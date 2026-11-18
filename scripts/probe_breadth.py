#!/usr/bin/env python3
"""一次性探測:找出可取得「上市/上櫃 即時漲跌家數(含漲停/跌停)」的端點。
在 GitHub Actions(有外網)執行,印出每個候選端點的狀態/型別/長度/前段內容。"""
import sys
import requests

UA = {"User-Agent": "Mozilla/5.0", "Accept": "*/*", "Referer": "https://mis.twse.com.tw/"}

CANDIDATES = [
    # TWSE MIS 盤中(猜測)
    ("GET", "https://mis.twse.com.tw/stock/api/getStatis.jsp?response=json"),
    ("GET", "https://mis.twse.com.tw/stock/api/getStatistics.jsp?response=json"),
    ("GET", "https://mis.twse.com.tw/stock/api/getMarketStatis.jsp?response=json"),
    ("GET", "https://mis.twse.com.tw/stock/api/getDiffStatis.jsp?response=json"),
    ("GET", "https://mis.twse.com.tw/stock/data/statis.json"),
    ("GET", "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw|otc_o00.tw&json=1&delay=0"),
    # TWSE 盤後 MI_INDEX(含大盤漲跌家數統計,型別參考用)
    ("GET", "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&type=MS"),
    ("GET", "https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&type=ALLBUT0999"),
    # TWSE OpenAPI(盤後)
    ("GET", "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX"),
    # TPEx 上櫃 盤中/盤後
    ("GET", "https://www.tpex.org.tw/www/zh-tw/afterTrading/mktStatistics"),
    ("GET", "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"),
    ("GET", "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"),
    # Yahoo TW 大盤摘要(猜測)
    ("GET", "https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.marketSummary"),
]


def main():
    for method, url in CANDIDATES:
        try:
            r = requests.get(url, headers=UA, timeout=30)
            body = r.content
            ct = r.headers.get("Content-Type", "")
            txt = ""
            for enc in ("utf-8", "big5", "cp950"):
                try:
                    txt = body.decode(enc); break
                except UnicodeDecodeError:
                    txt = body.decode("utf-8", "replace")
            txt1 = " ".join(txt.split())[:260]
            # 是否像含家數
            hint = [k for k in ("漲停", "跌停", "上漲", "下跌", "家數", "up", "down", "advanc", "declin", "limit") if k in txt]
            print(f"[probe] {r.status_code} ct={ct[:30]} len={len(body)} hints={hint}\n        {url}\n        {txt1!r}", file=sys.stderr)
        except Exception as ex:
            print(f"[probe] ERR {url} :: {ex}", file=sys.stderr)


if __name__ == "__main__":
    main()
