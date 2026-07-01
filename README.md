"""
本機 CORS 代理 — 讓 file:// 開啟的看板能取得即時報價。

支援：
- 上市個股 / 加權指數（TWSE MIS）：  /twse?id=2330  、 /twse?id=t00（加權）
- 台指期近月（TAIFEX 期交所）：       /taifex?cid=TXF
- 台股日線 / 期貨 / 清單（FinMind）： /finmind?dataset=...&token=你的FinMindToken
- 美股指數（FRED，S&P/NASDAQ/VIX）：  /fred?series_id=SP500&key=你的FREDKey

用法（在本資料夾開 PowerShell 或終端機）：
    python local-proxy.py
然後保持這個視窗開著，直接雙擊 index.html 即可。
看板會自動連到 http://127.0.0.1:8787 取得真實即時報價。

注意：
- 股票/加權：週一~五 09:00–13:30；台指期：日盤 08:45–13:45、夜盤 15:00–次日05:00。
- 資料來源：TWSE MIS / TAIFEX 官方端點，非模擬數據。
"""
import json
import re
import urllib.request
import urllib.parse
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8787
TWSE_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
TAIFEX_URL = "https://mis.taifex.com.tw/futures/api/getQuoteList"
ID_RE = re.compile(r"^[0-9A-Za-z]{2,6}$")


def fetch_twse(stock_id, market="tse"):
    if market not in ("tse", "otc"):
        market = "tse"
    qs = urllib.parse.urlencode({
        "ex_ch": f"{market}_{stock_id}.tw",
        "json": "1",
        "delay": "0",
    })
    req = urllib.request.Request(
        f"{TWSE_URL}?{qs}",
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
            "Referer": "https://mis.twse.com.tw/",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def fetch_finmind(query):
    token = query.pop("token", [""])
    token = token[0] if isinstance(token, list) else token
    flat = {k: (v[0] if isinstance(v, list) else v) for k, v in query.items()}
    qs = urllib.parse.urlencode(flat)
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"https://api.finmindtrade.com/api/v4/data?{qs}",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        # 把 402 等錯誤的 JSON 原樣回傳，前端可辨識
        return e.read()


def fetch_fred(series_id, limit, key):
    qs = urllib.parse.urlencode({
        "series_id": series_id,
        "api_key": key,
        "file_type": "json",
        "sort_order": "desc",
        "limit": limit,
    })
    req = urllib.request.Request(
        f"https://api.stlouisfed.org/fred/series/observations?{qs}",
        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def fetch_taifex(cid):
    body = json.dumps({
        "MarketType": "0", "SymbolType": "F", "KindID": "1",
        "CID": cid, "ExpireMonth": "", "RowSize": "全部",
        "PageNo": "", "SortColumn": "", "AscDesc": "A",
    }).encode("utf-8")
    req = urllib.request.Request(
        TAIFEX_URL, data=body,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Referer": "https://mis.taifex.com.tw/",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # 允許 file:// / 公開頁面存取 localhost（Chrome Private Network Access）
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path in ("/", "/health"):
            self._send_json(200, {"ok": True, "service": "twse-local-proxy"})
            return

        if parsed.path == "/twse":
            stock_id = (params.get("id") or [""])[0]
            market = (params.get("ex") or ["tse"])[0]
            if not ID_RE.match(stock_id):
                self._send_json(400, {"error": "id required (listed stock e.g. 2330, index t00)"})
                return
            self._proxy(lambda: fetch_twse(stock_id, market), "TWSE")
            return

        if parsed.path == "/taifex":
            cid = (params.get("cid") or ["TXF"])[0]
            if not ID_RE.match(cid):
                self._send_json(400, {"error": "cid invalid"})
                return
            self._proxy(lambda: fetch_taifex(cid), "TAIFEX")
            return

        if parsed.path == "/finmind":
            if not params.get("dataset"):
                self._send_json(400, {"error": "dataset required"})
                return
            self._proxy(lambda: fetch_finmind(dict(params)), "FinMind")
            return

        if parsed.path == "/fred":
            sid = (params.get("series_id") or [""])[0]
            key = (params.get("key") or [""])[0]
            limit = (params.get("limit") or ["120"])[0]
            if not re.match(r"^[0-9A-Za-z._-]{1,40}$", sid) or not re.match(r"^[0-9A-Za-z]{8,64}$", key):
                self._send_json(400, {"error": "series_id & valid key required"})
                return
            if not str(limit).isdigit():
                limit = "120"
            self._proxy(lambda: fetch_fred(sid, limit, key), "FRED")
            return

        self._send_json(404, {"error": "not found"})

    def _proxy(self, fn, label):
        try:
            data = fn()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._cors()
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._send_json(502, {"error": str(e) or f"{label} 連線失敗"})

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    import socket
    def lan_ip():
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return "127.0.0.1"

    ip = lan_ip()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"TWSE/TAIFEX/FRED/FinMind 代理已啟動 → 埠 {PORT}")
    print(f"  本機：http://127.0.0.1:{PORT}")
    print(f"  手機（同 WiFi）：http://{ip}:{PORT}")
    print("保持此視窗開著。手機版請在設定填入上述 IP:8787")
    print("按 Ctrl+C 結束。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
