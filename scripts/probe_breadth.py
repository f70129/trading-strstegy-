#!/usr/bin/env python3
"""確認 (1) 全市場代碼來源與數量 (2) MIS getStockInfo 單次批量上限。"""
import sys
import requests

UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": "https://mis.twse.com.tw/stock/index.jsp"}


def getj(url):
    r = requests.get(url, headers=UA, timeout=60)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text[:200]


# (1) 上市代碼：TWSE OpenAPI STOCK_DAY_ALL
st, j = getj("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL")
tse_codes = []
if isinstance(j, list):
    k = sorted(j[0].keys()) if j else []
    print(f"[tse] STOCK_DAY_ALL status={st} rows={len(j)} keys={k}", file=sys.stderr)
    for r in j:
        c = str(r.get("Code") or r.get("證券代號") or "").strip()
        if c.isdigit() and len(c) == 4 and c[0] != '0':
            tse_codes.append(c)
    print(f"[tse] 4碼普通股 codes={len(tse_codes)} sample={tse_codes[:5]}", file=sys.stderr)

# (2) 上櫃代碼：TPEx OpenAPI
st, j = getj("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes")
otc_codes = []
if isinstance(j, list):
    k = sorted(j[0].keys()) if j else []
    print(f"[otc] mainboard_quotes status={st} rows={len(j)} keys={k}", file=sys.stderr)
    for r in j:
        c = str(r.get("SecuritiesCompanyCode") or r.get("Code") or "").strip()
        if c.isdigit() and len(c) == 4 and c[0] != '0':
            otc_codes.append(c)
    print(f"[otc] 4碼普通股 codes={len(otc_codes)} sample={otc_codes[:5]}", file=sys.stderr)

# (3) MIS 批量上限：用上市代碼測 50/100/150/200
for n in (50, 100, 150, 200):
    chs = tse_codes[:n]
    if len(chs) < n:
        break
    exch = "|".join(f"tse_{c}.tw" for c in chs)
    url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={exch}&json=1&delay=0"
    stt, jj = getj(url)
    ln = len(jj.get("msgArray", [])) if isinstance(jj, dict) else -1
    rt = jj.get("rtcode") if isinstance(jj, dict) else "?"
    print(f"[mis] req={n} -> returned={ln} rtcode={rt} status={stt}", file=sys.stderr)
