#!/usr/bin/env python3
"""全市場家數全流程驗證:抓代碼→MIS 批量查詢→以現價判漲跌/漲停跌停→印出家數。"""
import sys
import requests

UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": "https://mis.twse.com.tw/stock/index.jsp"}


def getj(url):
    r = requests.get(url, headers=UA, timeout=60)
    return r.json()


def codes_from(url, key):
    out = []
    for r in getj(url):
        c = str(r.get(key) or "").strip()
        if c.isdigit() and len(c) == 4 and c[0] != '0':
            out.append(c)
    return out


def num(x):
    try:
        s = str(x).strip().replace(",", "")
        if s in ("", "-", "--"): return None
        v = float(s); return v if v == v else None
    except Exception:
        return None


def price(m):
    z = num(m.get("z"))
    if z and z > 0: return z
    ask = num(str(m.get("a") or "").split("_")[0]); bid = num(str(m.get("b") or "").split("_")[0])
    if ask and bid: return (ask + bid) / 2
    if ask: return ask
    if bid: return bid
    pz = num(m.get("pz"))
    if pz and pz > 0: return pz
    o = num(m.get("o"))
    return o if o and o > 0 else None


def mis(chs):
    exch = "|".join(chs)
    j = getj(f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={exch}&json=1&delay=0")
    return j.get("msgArray", []) if isinstance(j, dict) else []


tse = codes_from("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", "Code")
otc = codes_from("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes", "SecuritiesCompanyCode")
chans = [f"tse_{c}.tw" for c in tse] + [f"otc_{c}.tw" for c in otc]
print(f"universe tse={len(tse)} otc={len(otc)} total={len(chans)}", file=sys.stderr)

arr = []
for i in range(0, len(chans), 150):
    arr += mis(chans[i:i+150])
print(f"MIS returned entries={len(arr)}", file=sys.stderr)

S = lambda: {"n":0,"up":0,"dn":0,"flat":0,"lu":0,"ld":0,"nt":0}
o = {"tse":S(),"otc":S(),"all":S()}
ld_samples = []
eps = 1e-6
for m in arr:
    mk = "otc" if m.get("ex") == "otc" else "tse"
    px, y, u, w = price(m), num(m.get("y")), num(m.get("u")), num(m.get("w"))
    s, a = o[mk], o["all"]; s["n"] += 1; a["n"] += 1
    if px is None or y is None: s["nt"] += 1; a["nt"] += 1; continue
    if u and px >= u-eps: s["lu"] += 1; a["lu"] += 1
    if w and px <= w+eps:
        s["ld"] += 1; a["ld"] += 1
        if len(ld_samples) < 10: ld_samples.append(m.get("c"))
    if px > y+eps: s["up"] += 1; a["up"] += 1
    elif px < y-eps: s["dn"] += 1; a["dn"] += 1
    else: s["flat"] += 1; a["flat"] += 1

for k in ("tse","otc","all"):
    print(f"[{k}] {o[k]}", file=sys.stderr)
print(f"跌停 samples={ld_samples}", file=sys.stderr)
