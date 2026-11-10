#!/usr/bin/env python3
"""Fetch TAIFEX TXO Put/Call open-interest ratio from FinMind, backtest每個門檻
跌破後的 5 日 / 10 日 TAIEX 報酬,並導出動態警戒線與建議,寫入 pcr.json.

資料源 (FinMind):
  - Put/Call 未平倉比: 嘗試 TaiwanPutCallRatio 等資料集,取 OI ratio 欄位。
  - TAIEX 指數: TaiwanStockTotalReturnIndex (data_id=TAIEX) 作為前瞻報酬基準。

門檻以 P/C 自身的分位數 (p10..p90) 建立 → 單位不敏感;「跌破」= 由上向下
穿越門檻。動態警戒線 = 在樣本數足夠的門檻中,跌破後 10 日平均報酬最差者
(偏空警戒) 與最佳者 (偏多機會),每次執行重算 → 即「動態」。
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

API = "https://api.finmindtrade.com/api/v4/data"
OUT = os.path.join(os.path.dirname(__file__), "..", "pcr.json")
TOKEN = os.environ.get("FINMIND_TOKEN", "").strip()
START = (datetime.now(timezone.utc) - timedelta(days=365 * 6)).strftime("%Y-%m-%d")

PCR_DATASETS = ["TaiwanPutCallRatio", "TaiwanOptionPutCallRatio", "TaiwanTxoPutCallRatio"]
OI_FIELDS = ["PutCallOpenInterestRatio", "put_call_open_interest_ratio",
             "PutCallRatioOpenInterest", "OpenInterestPutCallRatio"]


def fm(dataset, data_id=""):
    params = {"dataset": dataset, "start_date": START}
    if data_id:
        params["data_id"] = data_id
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
        params["token"] = TOKEN
    r = requests.get(API, params=params, headers=headers, timeout=60)
    r.raise_for_status()
    j = r.json()
    if j.get("status") not in (200, None) and not j.get("data"):
        raise ValueError(j.get("msg", "api error"))
    return j.get("data", [])


def num(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def load_pcr():
    for ds in PCR_DATASETS:
        try:
            rows = fm(ds)
        except Exception as e:
            print(f"[pcr] {ds}: {e}", file=sys.stderr)
            continue
        if not rows:
            continue
        keys = rows[0].keys()
        fld = next((f for f in OI_FIELDS if f in keys), None)
        if fld is None:
            # any key containing open interest + ratio
            fld = next((k for k in keys if "open" in k.lower() and "ratio" in k.lower()), None)
        if fld is None:
            print(f"[pcr] {ds} has no OI-ratio field; keys={list(keys)}", file=sys.stderr)
            continue
        out = []
        for r in rows:
            d, v = r.get("date"), num(r.get(fld))
            if d and v is not None:
                out.append((d, v))
        out.sort()
        if out:
            print(f"[pcr] using {ds}.{fld}; {len(out)} rows; latest {out[-1]}")
            return ds, fld, out
    return None, None, []


def load_taiex():
    for did in ["TAIEX", "TPEx"][:1]:
        try:
            rows = fm("TaiwanStockTotalReturnIndex", did)
        except Exception as e:
            print(f"[pcr] taiex {did}: {e}", file=sys.stderr)
            rows = []
        m = {}
        for r in rows:
            d = r.get("date")
            c = num(r.get("price") or r.get("close") or r.get("index") or r.get("value"))
            if d and c and c > 0:
                m[d] = c
        if m:
            return m
    return {}


def pctile(sorted_vals, p):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, max(0, int(round(p / 100 * (len(sorted_vals) - 1)))))
    return sorted_vals[i]


def main():
    ds, fld, pcr = load_pcr()
    if not pcr:
        print("[pcr] no P/C ratio data parsed; leaving file untouched", file=sys.stderr)
        sys.exit(1)
    taiex = load_taiex()
    tdates = sorted(taiex.keys())
    tidx = {d: i for i, d in enumerate(tdates)}

    vals = [v for _, v in pcr]
    sv = sorted(vals)

    def fwd(date, n):
        i = tidx.get(date)
        if i is None or i + n >= len(tdates):
            return None
        a, b = taiex[tdates[i]], taiex[tdates[i + n]]
        return (b / a - 1) * 100 if a else None

    # backtest每個分位門檻的「跌破」事件
    bt = []
    for p in range(10, 91, 10):
        thr = pctile(sv, p)
        r5, r10 = [], []
        for k in range(1, len(pcr)):
            if pcr[k][1] < thr and pcr[k - 1][1] >= thr:   # 跌破
                f5, f10 = fwd(pcr[k][0], 5), fwd(pcr[k][0], 10)
                if f5 is not None:
                    r5.append(f5)
                if f10 is not None:
                    r10.append(f10)
        row = {
            "level": round(thr, 3), "pctile": p, "n": len(r10),
            "avg5": round(sum(r5) / len(r5), 2) if r5 else None,
            "win5": round(sum(1 for x in r5 if x > 0) / len(r5) * 100, 0) if r5 else None,
            "avg10": round(sum(r10) / len(r10), 2) if r10 else None,
            "win10": round(sum(1 for x in r10 if x > 0) / len(r10) * 100, 0) if r10 else None,
        }
        bt.append(row)

    usable = [r for r in bt if r["n"] >= 8 and r["avg10"] is not None] or \
             [r for r in bt if r["n"] >= 5 and r["avg10"] is not None]
    warn = min(usable, key=lambda r: r["avg10"]) if usable else None
    opp = max(usable, key=lambda r: r["avg10"]) if usable else None

    cur = pcr[-1][1]
    cur_pct = round(sum(1 for v in vals if v <= cur) / len(vals) * 100, 0)

    reco = f"目前 P/C(未平倉)={cur:.3f}(歷史分位 {cur_pct:.0f}%)。"
    if warn:
        reco += f" 回測:跌破警戒線 {warn['level']}(p{warn['pctile']})後 10 日平均 {warn['avg10']:+.2f}%(勝率 {warn['win10']:.0f}%、樣本 {warn['n']})。"
        if cur <= warn["level"]:
            reco += " 目前已處警戒區,偏空留意。"
    if opp and opp is not warn:
        reco += f" 跌破機會線 {opp['level']}(p{opp['pctile']})後 10 日平均 {opp['avg10']:+.2f}%(勝率 {opp['win10']:.0f}%)。"
    reco += " ※ 統計傾向非保證,樣本有限時參考性較低。"

    payload = {
        "source": "FinMind TAIFEX TXO Put/Call open-interest ratio + TAIEX",
        "dataset_used": f"{ds}.{fld}",
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "latest": {"date": pcr[-1][0], "pcoi": round(cur, 3), "pctile": cur_pct},
        "series": [{"date": d, "pcoi": round(v, 3)} for d, v in pcr[-600:]],
        "backtest": bt,
        "warn": warn,
        "opp": opp,
        "reco": reco,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"[pcr] wrote {len(payload['series'])} pts; warn={warn['level'] if warn else None} "
          f"opp={opp['level'] if opp else None}")


if __name__ == "__main__":
    main()
