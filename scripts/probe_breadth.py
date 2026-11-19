#!/usr/bin/env python3
"""Dump MIS getStockInfo 多檔回傳的原始欄位,診斷為何多數檔 z 為空。"""
import json
import sys
import requests

UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": "https://mis.twse.com.tw/stock/index.jsp"}
TSE = ["2330","2317","2454","2308","2382","2303","2412","3711","2881","2882","2891","2886","2884","2885","2892","2880","2883","2887","2890","5880"]


def fetch(chs):
    exch = "|".join(f"{c}.tw" for c in chs)
    url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={exch}&json=1&delay=0"
    r = requests.get(url, headers=UA, timeout=30)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, {"_raw": r.text[:300]}


for label, chs in [("batch20", [f"tse_{c}" for c in TSE]),
                   ("batch5", [f"tse_{c}" for c in TSE[:5]])]:
    st, j = fetch(chs)
    arr = j.get("msgArray", []) if isinstance(j, dict) else []
    print(f"\n[{label}] status={st} rtcode={j.get('rtcode')} msgArray_len={len(arr)}", file=sys.stderr)
    if arr:
        print(f"  keys[0]={sorted(arr[0].keys())}", file=sys.stderr)
        for m in arr[:8]:
            print(f"  c={m.get('c')} z={m.get('z')!r} y={m.get('y')!r} o={m.get('o')!r} "
                  f"u={m.get('u')!r} w={m.get('w')!r} tv={m.get('tv')!r} v={m.get('v')!r} "
                  f"a={str(m.get('a'))[:14]!r} b={str(m.get('b'))[:14]!r} ex={m.get('ex')!r} t={m.get('t')!r} pct={m.get('%')!r}", file=sys.stderr)
