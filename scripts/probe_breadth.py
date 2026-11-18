#!/usr/bin/env python3
"""探測 getStatis.jsp 參數變體與其他盤中家數候選端點。"""
import sys
import requests

UA = {"User-Agent": "Mozilla/5.0", "Accept": "*/*", "Referer": "https://mis.twse.com.tw/stock/index.jsp"}

CAND = [
    "https://mis.twse.com.tw/stock/api/getStatis.jsp",
    "https://mis.twse.com.tw/stock/api/getStatis.jsp?response=json&ex=tse",
    "https://mis.twse.com.tw/stock/api/getStatis.jsp?response=json&ex=otc",
    "https://mis.twse.com.tw/stock/api/getStatis.jsp?response=json&i=1",
    "https://mis.twse.com.tw/stock/api/getStatis.jsp?ex_ch=tse&json=1&delay=0",
    "https://mis.twse.com.tw/stock/api/getStatis.jsp?response=json&market=0",
    "https://mis.twse.com.tw/stock/api/getStatis.jsp?response=json&TYPEK=sii",
    "https://mis.twse.com.tw/stock/api/getDailyStatis.jsp?response=json",
    "https://mis.twse.com.tw/stock/api/getStatistics.jsp?response=json&ex=tse",
    "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_intraday_index",
    "https://www.tpex.org.tw/www/zh-tw/intraday/soaring",
]


def main():
    for url in CAND:
        try:
            r = requests.get(url, headers=UA, timeout=25)
            body = r.content
            txt = body.decode("utf-8", "replace")
            txt1 = " ".join(txt.split())[:280]
            hints = [k for k in ("漲停", "跌停", "上漲", "下跌", "家數", "平盤") if k in txt]
            print(f"[probe] {r.status_code} len={len(body)} hints={hints}\n        {url}\n        {txt1!r}", file=sys.stderr)
        except Exception as ex:
            print(f"[probe] ERR {url} :: {ex}", file=sys.stderr)


if __name__ == "__main__":
    main()
