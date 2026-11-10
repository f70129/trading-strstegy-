#!/usr/bin/env python3
"""抓台指選擇權(TXO) Put/Call 未平倉比,回測每個門檻「跌破後」的 5 日 / 10 日
加權指數報酬,導出動態警戒線與建議,寫入 pcr.json.

資料源:
  - Put/Call 未平倉比: 台灣期交所 (TAIFEX) 官方 pcRatio 下載檔(買權/賣權未平倉量,
    自行計算 賣權OI / 買權OI = Put/Call 未平倉比)。這是最原始的權威來源;FinMind
    並未提供對應資料集(所有候選名稱皆回 422),故直接取用期交所公開檔(免 token)。
  - 加權指數(TAIEX): FinMind TaiwanStockTotalReturnIndex(data_id=TAIEX);
    若無資料則改用 Yahoo ^TWII 日線作為前瞻報酬基準。

門檻以 P/C 自身分位數(p10..p90)建立 → 單位不敏感;「跌破」= 由上向下穿越門檻。
動態警戒線 = 樣本足夠的門檻中,跌破後 10 日平均報酬最差者(偏空警戒)與最佳者
(偏多機會),每次執行重算 → 即「動態」。
"""
import csv
import io
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
TAIFEX_DOWN = "https://www.taifex.com.tw/cht/3/pcRatioDown"
TAIFEX_PAGE = "https://www.taifex.com.tw/cht/3/pcRatio"
FINMIND_API = "https://api.finmindtrade.com/api/v4/data"

from html.parser import HTMLParser


class _TableParser(HTMLParser):
    """擷取所有 <table> 的列/儲存格文字(容忍巢狀表格)。"""
    def __init__(self):
        super().__init__()
        self.tables = []
        self._stack = []   # 每層 table 的 rows
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._stack.append([])
        elif tag == "tr" and self._stack:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag == "table" and self._stack:
            rows = self._stack.pop()
            if rows:
                self.tables.append(rows)
        elif tag == "tr" and self._row is not None and self._stack:
            self._stack[-1].append(self._row)
            self._row = None
        elif tag in ("td", "th") and self._cell is not None:
            if self._row is not None:
                self._row.append("".join(self._cell).strip())
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


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


def _parse_pcr_html(content):
    """解析 pcRatio 顯示頁回傳的 HTML 表格 → [(date, pcoi)]。
    依標題欄位名稱定位 日期 / 買權未平倉量 / 賣權未平倉量 / 未平倉比率。"""
    text = None
    for enc in ("utf-8", "big5", "cp950"):
        try:
            text = content.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = content.decode("big5", errors="replace")
    p = _TableParser()
    p.feed(text)

    best = []
    for rows in p.tables:
        hidx = next((i for i, r in enumerate(rows) if any("日期" in c for c in r)), None)
        if hidx is None:
            continue
        header = rows[hidx]

        def find(*keys):
            for i, h in enumerate(header):
                hh = h.replace("\n", "").replace(" ", "")
                if all(k in hh for k in keys):
                    return i
            return None

        i_date, i_call, i_put, i_ratio = find("日期"), find("買權", "未平倉"), find("賣權", "未平倉"), find("未平倉", "比")
        if i_date is None or (i_ratio is None and (i_call is None or i_put is None)):
            continue
        out = []
        for row in rows[hidx + 1:]:
            if len(row) <= i_date:
                continue
            d = norm_date(row[i_date])
            if not d:
                continue
            g = lambda i: row[i] if i is not None and len(row) > i else None
            v = _row_to_pcoi(d, g(i_call), g(i_put), g(i_ratio))
            if v is not None:
                out.append((d, v))
        if len(out) > len(best):
            best = out
    return best


_DIAG_DONE = False


def _parse_pcr_any(content):
    """同時嘗試 HTML 表格與 CSV 兩種格式,回傳列數較多者。"""
    rows = _parse_pcr_html(content)
    try:
        text = content.decode("big5", errors="replace")
        crows = list(csv.reader(io.StringIO(text)))
        hidx = next((i for i, r in enumerate(crows) if any("日期" in c for c in r)), None)
        if hidx is not None:
            header = [h.replace("\n", "").replace(" ", "") for h in crows[hidx]]

            def find(*keys):
                for i, h in enumerate(header):
                    if all(k in h for k in keys):
                        return i
                return None
            i_date, i_call, i_put, i_ratio = find("日期"), find("買權", "未平倉"), find("賣權", "未平倉"), find("未平倉", "比")
            if i_date is not None and (i_ratio is not None or (i_call is not None and i_put is not None)):
                cout = []
                g = lambda row, i: row[i] if i is not None and len(row) > i else None
                for row in crows[hidx + 1:]:
                    if len(row) <= i_date:
                        continue
                    d = norm_date(row[i_date])
                    if not d:
                        continue
                    v = _row_to_pcoi(d, g(row, i_call), g(row, i_put), g(row, i_ratio))
                    if v is not None:
                        cout.append((d, v))
                if len(cout) > len(rows):
                    rows = cout
    except Exception:
        pass
    return rows


def _fetch_pcr_window(start, end):
    """單一區間:試多個端點/欄位,回傳解析到最多列的那組 [(date,pcoi)]。"""
    global _DIAG_DONE
    s, e = start.strftime("%Y/%m/%d"), end.strftime("%Y/%m/%d")
    attempts = [
        (TAIFEX_DOWN, {"queryStartDate": s, "queryEndDate": e}),
        (TAIFEX_DOWN, {"down": "", "queryStartDate": s, "queryEndDate": e}),
        (TAIFEX_PAGE, {"queryStartDate": s, "queryEndDate": e}),
    ]
    best = []
    for url, data in attempts:
        try:
            r = requests.post(url, data=data, headers={**UA, "Referer": TAIFEX_PAGE}, timeout=90)
            r.raise_for_status()
            if not _DIAG_DONE:
                body = r.content
                snip = body[:300].decode("big5", errors="replace").replace("\n", " ")
                print(f"[pcr][diag] {url} fields={list(data)} status={r.status_code} "
                      f"ctype={r.headers.get('Content-Type')} len={len(body)} "
                      f"has_table={b'<table' in body.lower()} has_date={('日期' in body.decode('big5', 'ignore'))} "
                      f"head={snip!r}", file=sys.stderr)
            rows = _parse_pcr_any(r.content)
            if len(rows) > len(best):
                best = rows
            if len(rows) > 2:
                break
        except Exception as ex:
            print(f"[pcr]   {url} {s}..{e}: {ex}", file=sys.stderr)
    _DIAG_DONE = True
    return best


def load_pcr_down():
    """分段(~120 天視窗)抓 TAIFEX,解析 HTML 表格累積歷年資料。"""
    import time
    WINDOW = 120
    acc = {}
    now = datetime.now(timezone.utc)
    wins = []
    cur = START_DT
    while cur < now:
        nxt = min(cur + timedelta(days=WINDOW), now)
        wins.append((cur, nxt))
        cur = nxt + timedelta(days=1)
    wins.reverse()  # 由最近往回,便於先診斷近期視窗
    windows = ok = 0
    for cur, nxt in wins:
        rows = _fetch_pcr_window(cur, nxt)
        for d, v in rows:
            acc[d] = v
        if rows:
            ok += 1
        windows += 1
        time.sleep(0.4)
    out = sorted(acc.items())
    if not out:
        raise ValueError(f"TAIFEX parsed 0 rows across {windows} windows")
    print(f"[pcr] TAIFEX P/C(OI): {len(out)} rows ({ok}/{windows} windows ok); latest {out[-1]}")
    return out


def load_pcr():
    """回傳 (source_label, [(date, pc_oi_ratio), ...] sorted).
    以分段下載取得歷年資料為主,再以 OpenAPI 補最近 21 日。"""
    merged = {}
    errs = []
    try:
        for d, v in load_pcr_down():
            merged[d] = v
    except Exception as e:
        errs.append(f"down: {e}")
        print(f"[pcr] load_pcr_down failed: {e}", file=sys.stderr)
    try:
        for d, v in load_pcr_openapi():
            merged.setdefault(d, v)  # 下載值優先,OpenAPI 僅補缺
    except Exception as e:
        errs.append(f"openapi: {e}")
        print(f"[pcr] load_pcr_openapi failed: {e}", file=sys.stderr)
    out = sorted(merged.items())
    if not out:
        raise SystemExit("[pcr] all TAIFEX sources failed: " + " | ".join(errs))
    print(f"[pcr] merged P/C(OI): {len(out)} rows; latest {out[-1]}")
    return "台灣期交所 TAIFEX Put/Call 未平倉比", out


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
