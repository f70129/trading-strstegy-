#!/usr/bin/env python3
"""抓台指選擇權(TXO) Put/Call 未平倉比,回測每個門檻「跌破後」的 5 日 / 10 日
加權指數報酬,導出動態警戒線與建議,寫入 pcr.json.

資料源:
  - Put/Call 未平倉比: 以 FinMind TaiwanOptionDaily(TXO)逐月彙總
    Σ賣權未平倉 / Σ買權未平倉 得每日 P/C 未平倉比(比值對稱,日/夜盤重複列不影響);
    台灣期交所 OpenAPI(PutCallRatio,滾動近 21 日)補最近缺漏日。
    註:期交所歷史查詢頁為 JS 驅動,簡單 HTTP 僅能取回近一個月,故歷年資料改由
    FinMind 原始選擇權日資料彙總。
  - 加權指數(TAIEX): FinMind TaiwanStockTotalReturnIndex(data_id=TAIEX);
    若無資料則改用 Yahoo ^TWII 日線作為前瞻報酬基準。

門檻以 P/C 自身分位數(p10..p90)建立 → 單位不敏感;「跌破」= 由上向下穿越門檻。
動態警戒線 = 樣本足夠的門檻中,跌破後 10 日平均報酬最差者(偏空警戒)與最佳者
(偏多機會),每次執行重算 → 即「動態」。
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

OUT = os.path.join(os.path.dirname(__file__), "..", "pcr.json")
TOKEN = os.environ.get("FINMIND_TOKEN", "").strip()
YEARS = 6
START_DT = datetime.now(timezone.utc) - timedelta(days=365 * YEARS)
START = START_DT.strftime("%Y-%m-%d")
UA = {"User-Agent": "Mozilla/5.0 (compatible; dashboard-bot/1.0)", "Accept": "*/*"}

TAIFEX_OPENAPI = "https://openapi.taifex.com.tw/v1/PutCallRatio"
FINMIND_API = "https://api.finmindtrade.com/api/v4/data"


def norm_date(s):
    """各種格式 → YYYY-MM-DD,失敗回 None."""
    s = str(s).strip()
    digits = s.replace("/", "").replace("-", "")
    if len(digits) == 8 and digits.isdigit():
        return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"
    return None


def num(x):
    try:
        if x is None:
            return None
        s = str(x).strip().replace(",", "")
        if s in ("", "-", "--", "N/A"):
            return None
        v = float(s)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


# ---------- Put/Call 未平倉比: TAIFEX ----------
def _row_to_pcoi(d, call_oi, put_oi, ratio_pct):
    """由 買權OI/賣權OI 或比率%算出 P/C 未平倉比."""
    c, p = num(call_oi), num(put_oi)
    if c and c > 0 and p is not None:
        return p / c
    rv = num(ratio_pct)
    if rv is not None:
        return rv / 100 if rv > 5 else rv
    return None


def load_pcr_openapi():
    r = requests.get(TAIFEX_OPENAPI, headers={**UA, "Accept": "application/json"}, timeout=90)
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, list) or not data:
        raise ValueError("OpenAPI returned no list")

    def pick(row, *subs):
        for k in row:
            kl = k.lower().replace(" ", "").replace("_", "")
            if all(s in kl for s in subs):
                return row[k]
        return None

    out = []
    for row in data:
        if not isinstance(row, dict):
            continue
        draw = pick(row, "date") or row.get("Date")
        d = norm_date(draw) if draw else None
        if not d:
            continue
        call_oi = pick(row, "call", "oi") or pick(row, "買權", "未平倉")
        put_oi = pick(row, "put", "oi") or pick(row, "賣權", "未平倉")
        ratio = pick(row, "putcall", "oi", "ratio") or pick(row, "未平倉", "比率")
        v = _row_to_pcoi(d, call_oi, put_oi, ratio)
        if v is not None:
            out.append((d, v))
    out.sort()
    if not out:
        raise ValueError(f"OpenAPI parsed 0 rows; sample keys={list(data[0].keys())}")
    print(f"[pcr] TAIFEX OpenAPI P/C(OI): {len(out)} rows; latest {out[-1]}")
    return out


def _finmind_get(dataset, data_id, start, end):
    params = {"dataset": dataset, "data_id": data_id, "start_date": start, "end_date": end}
    headers = dict(UA); headers["Accept"] = "application/json"
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"; params["token"] = TOKEN
    r = requests.get(FINMIND_API, params=params, headers=headers, timeout=120)
    r.raise_for_status()
    j = r.json()
    return (j.get("data", []) or []) if isinstance(j, dict) else []


_HIST_DIAG = False


def load_pcr_history():
    """以 FinMind TaiwanOptionDaily(TXO)逐月彙總 Σ賣權OI / Σ買權OI 得每日 P/C 未平倉比。
    比值對稱,日/夜盤若重複列不影響比值。"""
    import time
    global _HIST_DIAG
    acc = {}
    now = datetime.now(timezone.utc)
    y, mn = START_DT.year, START_DT.month
    months = []
    while (y < now.year) or (y == now.year and mn <= now.month):
        months.append((y, mn))
        mn += 1
        if mn > 12:
            y += 1; mn = 1
    okm = 0
    for yy, mm in months:
        start = f"{yy:04d}-{mm:02d}-01"
        nd = f"{yy+1:04d}-01-01" if mm == 12 else f"{yy:04d}-{mm+1:02d}-01"
        end = (datetime.strptime(nd, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        try:
            rows = _finmind_get("TaiwanOptionDaily", "TXO", start, end)
        except Exception as ex:
            print(f"[pcr] opt {start}: {ex}", file=sys.stderr)
            rows = []
        daymap = {}       # date -> [put_oi, call_oi]
        cp_samples, key_sample = set(), None
        for r in rows:
            if key_sample is None:
                key_sample = list(r.keys())
            d = r.get("date")
            if not d:
                continue
            cp = str(r.get("call_put") or r.get("CallPut") or r.get("type") or r.get("cp") or "")
            oi = num(r.get("open_interest") if "open_interest" in r else
                     (r.get("OpenInterest") or r.get("open_interest_balance")))
            if oi is None:
                continue
            if len(cp_samples) < 8:
                cp_samples.add(cp)
            cl = cp.strip().lower()
            if cl.startswith("p") or "賣" in cp:
                idx = 0
            elif cl.startswith("c") or "買" in cp:
                idx = 1
            else:
                continue
            daymap.setdefault(d, [0.0, 0.0])[idx] += oi
        for d, (pp, cc) in daymap.items():
            if cc > 0:
                acc[d] = pp / cc
        if daymap:
            okm += 1
        if not _HIST_DIAG:
            last = sorted(daymap.items())[-1] if daymap else None
            print(f"[pcr][hist] {start}..{end}: rows={len(rows)} days={len(daymap)} "
                  f"cp={sorted(cp_samples)} keys={key_sample} last={last}", file=sys.stderr)
            _HIST_DIAG = True
        time.sleep(0.25)
    out = sorted(acc.items())
    if not out:
        raise ValueError("FinMind TaiwanOptionDaily produced 0 days")
    print(f"[pcr] FinMind option P/C(OI): {len(out)} days ({okm}/{len(months)} months); latest {out[-1]}")
    return out


def load_pcr():
    """回傳 (source_label, [(date, pc_oi_ratio), ...] sorted).
    以 FinMind 選擇權日資料彙總歷年為主,再以 TAIFEX OpenAPI 補最近 21 日。"""
    merged = {}
    errs = []
    try:
        for d, v in load_pcr_history():
            merged[d] = v
    except Exception as e:
        errs.append(f"history: {e}")
        print(f"[pcr] load_pcr_history failed: {e}", file=sys.stderr)
    try:
        for d, v in load_pcr_openapi():
            merged.setdefault(d, v)  # 歷年值優先,OpenAPI 僅補最近缺漏
    except Exception as e:
        errs.append(f"openapi: {e}")
        print(f"[pcr] load_pcr_openapi failed: {e}", file=sys.stderr)
    out = sorted(merged.items())
    if not out:
        raise SystemExit("[pcr] all P/C sources failed: " + " | ".join(errs))
    print(f"[pcr] merged P/C(OI): {len(out)} rows; latest {out[-1]}")
    return "FinMind 台指選擇權日未平倉彙總(TXO)+ 期交所 OpenAPI 補近月", out


# ---------- TAIEX 指數 ----------
def load_taiex_finmind():
    params = {"dataset": "TaiwanStockTotalReturnIndex", "data_id": "TAIEX", "start_date": START}
    headers = dict(UA)
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
        params["token"] = TOKEN
    try:
        r = requests.get(FINMIND_API, params=params, headers=headers, timeout=60)
        j = r.json()
        data = j.get("data", []) if isinstance(j, dict) else []
    except Exception as e:
        print(f"[pcr] finmind taiex: {e}", file=sys.stderr)
        return {}
    m = {}
    for row in data:
        d = row.get("date")
        c = num(row.get("price") or row.get("close") or row.get("index") or row.get("value"))
        if d and c and c > 0:
            m[d] = c
    if m:
        print(f"[pcr] TAIEX via FinMind: {len(m)} days")
    return m


def load_taiex_yahoo():
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII"
           f"?period1={int(START_DT.timestamp())}&period2={int(datetime.now(timezone.utc).timestamp())}"
           "&interval=1d")
    try:
        r = requests.get(url, headers=UA, timeout=60)
        j = r.json()
        res = j["chart"]["result"][0]
        ts = res["timestamp"]
        cl = res["indicators"]["quote"][0]["close"]
    except Exception as e:
        print(f"[pcr] yahoo taiex: {e}", file=sys.stderr)
        return {}
    m = {}
    for t, c in zip(ts, cl):
        if c is None:
            continue
        d = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
        m[d] = c
    if m:
        print(f"[pcr] TAIEX via Yahoo ^TWII: {len(m)} days")
    return m


def load_taiex():
    return load_taiex_finmind() or load_taiex_yahoo()


def pctile(sorted_vals, p):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, max(0, int(round(p / 100 * (len(sorted_vals) - 1)))))
    return sorted_vals[i]


def main():
    source, pcr = load_pcr()
    taiex = load_taiex()
    tdates = sorted(taiex.keys())
    tidx = {d: i for i, d in enumerate(tdates)}

    def fwd(date, n):
        # 以 P/C 日期之後、指數序列中最接近的交易日為基準
        i = tidx.get(date)
        if i is None:
            # 找 >= date 的第一個指數日
            import bisect
            j = bisect.bisect_left(tdates, date)
            if j >= len(tdates):
                return None
            i = j
        if i + n >= len(tdates):
            return None
        a, b = taiex[tdates[i]], taiex[tdates[i + n]]
        return (b / a - 1) * 100 if a else None

    vals = [v for _, v in pcr]
    sv = sorted(vals)

    bt = []
    for p in range(10, 91, 10):
        thr = pctile(sv, p)
        r5, r10 = [], []
        for k in range(1, len(pcr)):
            if pcr[k][1] < thr and pcr[k - 1][1] >= thr:  # 跌破
                f5, f10 = fwd(pcr[k][0], 5), fwd(pcr[k][0], 10)
                if f5 is not None:
                    r5.append(f5)
                if f10 is not None:
                    r10.append(f10)
        bt.append({
            "level": round(thr, 3), "pctile": p, "n": len(r10),
            "avg5": round(sum(r5) / len(r5), 2) if r5 else None,
            "win5": round(sum(1 for x in r5 if x > 0) / len(r5) * 100, 0) if r5 else None,
            "avg10": round(sum(r10) / len(r10), 2) if r10 else None,
            "win10": round(sum(1 for x in r10 if x > 0) / len(r10) * 100, 0) if r10 else None,
        })

    usable = [r for r in bt if r["n"] >= 8 and r["avg10"] is not None] or \
             [r for r in bt if r["n"] >= 5 and r["avg10"] is not None] or \
             [r for r in bt if r["n"] >= 3 and r["avg10"] is not None]
    warn = min(usable, key=lambda r: r["avg10"]) if usable else None
    opp = max(usable, key=lambda r: r["avg10"]) if usable else None

    cur = pcr[-1][1]
    cur_pct = round(sum(1 for v in vals if v <= cur) / len(vals) * 100, 0)

    reco = f"目前 P/C(未平倉)={cur:.3f}(歷史分位 {cur_pct:.0f}%)。"
    if warn:
        reco += (f" 回測:跌破警戒線 {warn['level']}(p{warn['pctile']})後 10 日平均 "
                 f"{warn['avg10']:+.2f}%(勝率 {warn['win10']:.0f}%、樣本 {warn['n']})。")
        if cur <= warn["level"]:
            reco += " 目前已處警戒區,偏空留意。"
    if opp and opp is not warn:
        reco += (f" 跌破機會線 {opp['level']}(p{opp['pctile']})後 10 日平均 "
                 f"{opp['avg10']:+.2f}%(勝率 {opp['win10']:.0f}%)。")
    reco += " ※ 統計傾向非保證,樣本有限時參考性較低。"

    payload = {
        "source": source,
        "dataset_used": f"{source} · 加權指數前瞻報酬基準({len(tdates)} 交易日)",
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
          f"opp={opp['level'] if opp else None}; taiex_days={len(tdates)}")


if __name__ == "__main__":
    main()
