# 台指期聰明錢看板（大單 / 小單即時流向 · 順勢跟單模擬 · Telegram 通知）

`smartmoney.html` 是一個獨立的單頁看板（手機 / 桌機皆可），搭配 `js/smartmoney-core.js`
（瀏覽器與 Node 共用的核心引擎）與 `smartmoney_engine.py`（Python 版，離線回測 / 常駐推播）。

> 資料來源全部是 **FinMind 付費（sponsor）方案**：
> - 即時：`taiwan_futures_snapshot`（約 10 秒更新，含 `TickType` 內外盤、最後一筆成交口數、累積量 / 金額、最佳買賣價）
> - 歷史逐筆：`TaiwanFuturesTick`（每筆成交的價格與口數，TX / MTX / TMF）
> - 逐筆 WebSocket：`wss://api.finmindtrade.com/api/v4/websocket/taiwan_futopt_price_tick`（實驗性，訊息欄位以現場為準）
> - 盤後底牌（免費）：`TaiwanFuturesInstitutionalInvestors`、`TaiwanFuturesOpenInterestLargeTraders`

---

## 1. 使用方式

### 桌機 / 手機直接開網頁
1. 把整個資料夾放在同一處（`smartmoney.html` 需要旁邊的 `js/smartmoney-core.js`）。
2. 用瀏覽器開 `smartmoney.html`（雙擊即可；已部署 Netlify 者開 `https://你的站/smartmoney.html`）。
3. **設定** 分頁：貼上 FinMind 付費 Token、Telegram Bot Token 與 Chat ID → 儲存（只存在該瀏覽器）。
4. **檢核** 分頁 → 執行檢核：會跑 15 項引擎單元測試，並實際驗證 Token、快照權限（TXF / MXF / TMF）、
   歷史逐筆權限、Telegram Bot。
5. **即時** 分頁 → 開始。看板每 10 秒（可調）拉三個商品的快照，即時更新大戶心態、流量、SMI 與訊號；
   出現進 / 出場訊號、大戶心態轉變時推播 Telegram。
6. 沒有付費 Token 也可先按 **示範資料**（合成逐筆、每秒回放 1 分鐘）熟悉介面。

手機加入主畫面：iPhone Safari → 分享 → 加入主畫面；Android Chrome → ⋮ → 加入主畫面。

### 連線路徑
| 開啟方式 | FinMind | Telegram |
|---|---|---|
| 雙擊 `smartmoney.html`（file://） | 直連 FinMind（允許 CORS）→ 失敗改本機代理 `python local-proxy.py` | 直連 api.telegram.org → 失敗改本機代理 |
| Netlify / Cloudflare 部署 | `netlify/functions/finmind.js`（Token 可放環境變數 `FINMIND_TOKEN`）→ 直連 | `netlify/functions/telegram.js`（可放 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`）→ 直連 |

### Python 引擎（離線回測 / 常駐推播）
```bash
pip install requests
export FINMIND_TOKEN=你的付費token
export TELEGRAM_BOT_TOKEN=123456:ABC...   # 選用
export TELEGRAM_CHAT_ID=123456789        # 選用

python smartmoney_engine.py --selftest                       # 單元測試（免網路）
python smartmoney_engine.py --live --once                    # 拉一次快照，印出原始欄位（首次務必看）
python smartmoney_engine.py --live --interval 10             # 盤中常駐：訊號 → Telegram，狀態寫 data/smartmoney_live.json
python smartmoney_engine.py --backtest 2026-08-01 2026-09-05 # 逐筆回測 → data/smartmoney_backtest.json
python smartmoney_engine.py --grid 2026-08-01 2026-09-05     # 108 組網格 → data/smartmoney_grid.json
python smartmoney_engine.py --live --params-file data/smartmoney_grid.json   # 用網格最佳參數跑即時
```
逐筆資料會快取在 `data/ticks/YYYY-MM-DD.json`（TX 一天約數萬～十餘萬筆）。

---

## 2. 大戶 / 散戶配比（研究依據）

| 類別 | 定義 | 名目規模（指數 24,000） | 說明 |
|---|---|---|---|
| 🐋 大單（大戶） | 大台單筆 **≥ 10 口**（可調） | ≥ 4,800 萬 | 法人 / 大額交易人程式單、避險單多落在此區間 |
| 🐬 中單（中實戶） | 大台 3–9 口 | 1,440–4,320 萬 | 不計入 SMI，只顯示 |
| 🐟 小單（散戶） | 大台 1–2 口、**小台全部**、**微台全部** | ≤ 960 萬 | 散戶反向指標 |

- 流量統一換算成「大台等值口數」：小台 × 0.25、微台 × 0.025（依契約乘數 200 / 50 / 5）。
- 為何用「單筆成交口數」而不是「帳戶」：期交所逐筆只揭露每筆成交的量，帳戶層級的資料只有盤後
  （三大法人、大額交易人）。10 口門檻是常見的期貨大單分界，可在網格搜尋中用 5 / 10 / 20 驗證。
- 盤後底牌（外資淨 OI、前十大交易人淨部位）在看板右下角當作方向確認，不進策略運算。

### 方向判定
| 資料 | 判定 |
|---|---|
| 即時快照 | `TickType` 1 = 外盤（主動買）、2 = 內盤（主動賣）；0 時用成交價 vs 最佳買賣價；再無則 Tick Rule |
| 快照未取樣量 | 兩次快照間 Δ累積金額 / Δ累積量 = 區間均價，高於中價 → 買方主導 |
| 歷史逐筆 / WebSocket | Tick Rule（上漲 tick = 買、下跌 tick = 賣、平盤沿用上一筆） |

### 指標
```
bigNet(分鐘)    = 大單主動買 − 大單主動賣           （大台等值口數）
retailNet(分鐘) = 小單主動買 − 小單主動賣
winBig          = 最近 W 分鐘 bigNet 合計（預設 W = 10）
zBig            = winBig / (今日至今每分鐘 bigNet 標準差 × √W)
SMI             = zBig − 0.5 × zRetail                   （散戶反向）
大戶心態分數    = 50 + 60 × 大單淨買比 − 20 × 散戶淨買比 （0–100；≥58 偏多、≤42 偏空）
```

### 順勢跟單策略（模擬盤，大台 1 口）
- 進場：`SMI ≥ 1.5` 且價格 ≥ VWAP → 多；`SMI ≤ −1.5` 且價格 ≤ VWAP → 空。
- 出場：停損 30 點 / 停利 60 點（以該分鐘高低價觸價）/ SMI 反向穿越 0 / 13:40 強制平倉。
- 限制：13:00 後不新進場、出場後冷卻 5 分鐘、每日最多 6 筆、每趟成本 1.5 點（手續費 + 期交稅 + 滑價）。
- 所有參數可在「設定」調整；「回測 → 網格搜尋」會跑 108 組並可一鍵套用。

---

## 3. 檢核結果（本次交付）

| 項目 | 方式 | 結果 |
|---|---|---|
| 引擎單元測試（JS） | `node tests/smartmoney-core.test.js` | 29 項全部通過 |
| 引擎單元測試（Python） | `python smartmoney_engine.py --selftest` | 15 項全部通過 |
| **跨語言一致性** | `node tests/parity.js`：同一組合成逐筆（6 個種子 + 8 組網格），JS 與 Python 的交易數、損益、SMI、排名 | 完全相同 |
| 合成資料訊號偵測 | 大單淨流方向 vs 隱含趨勢一致率 | 82%（門檻 58%） |
| 看板端對端（Playwright + 模擬 FinMind / Telegram 伺服器） | 檢核頁 / 即時輪詢 40 輪 / 重新整理還原狀態 / 盤後底牌 / 模擬頁 / 示範資料回測 / 108 組網格 / 套用參數 / 逐筆回測 | 全部通過，0 個 JS 錯誤 |
| 手機版 390px | 無橫向捲動、底部分頁列、圖表可讀 | 通過 |
| file:// 直接開啟 | 引擎與 Chart.js 載入 | 通過 |
| Telegram 推播格式 | 模擬伺服器收到進場 / 出場 / 心態轉變 / 30 分摘要 | 通過 |
| 代理函式 | Netlify / Cloudflare / local-proxy.py 的 `endpoint` 白名單、Telegram 參數驗證 | 通過 |

**未能在開發環境驗證（網路被封鎖，需你在本機第一次執行時確認）：**
1. FinMind 快照真實欄位名稱是否與官方 python 套件一致（`TickType`、`total_amount`、`buy_price`…）。
   看板「檢核」會把首筆快照原始內容印出來；`python smartmoney_engine.py --live --once` 也會。
2. `MXF` / `TMF` 是否能用快照端點取得（官方文件寫「目前支援台指期」）。若取不到，小台 / 微台流量會缺失，
   看板會以警告顯示，但大單分析（TX）仍可運作。
3. WebSocket 逐筆的訊息格式與是否需要 token；看板會把第一筆原始訊息寫進「檢核 → 事件日誌」。
4. 策略在真實資料上的績效 —— 合成資料只驗證邏輯正確，**不代表實盤期望值**。請先用 `--grid` 跑至少
   20 個交易日，且只挑「前 20 名中穩定出現、正報酬日 ≥ 60%」的參數區間。

---

## 4. 已知限制與建議
- **快照模式是取樣估計**：FinMind 快照約 10 秒一筆，只揭露「最後一筆成交」的口數與方向，其餘量歸入
  「未取樣」（僅算整體方向，不算大小單）。看板會顯示取樣率。要完整逐筆請用 WebSocket 模式或盤後逐筆回測。
- 一分 K 收完才會出訊號（與回測邏輯一致，避免盤中 / 回測落差）。
- 模擬盤不含滑價分布、漲跌停、流動性；成本以 1.5 點粗估。
- 日盤限定（08:45–13:45）；夜盤只顯示流量、策略不進場。
- Token 與 Telegram 憑證只存在瀏覽器 `localStorage`；公開部署請改用 Netlify 環境變數。

## 5. 檔案
```
smartmoney.html                看板（單頁，手機 / 桌機）
js/smartmoney-core.js          核心引擎（分類、Tick Rule、1 分 K、SMI、模擬盤、回測、網格、快照差量、合成資料）
smartmoney_engine.py           Python 引擎（同邏輯；離線回測 / 網格 / 盤中常駐推播）
tests/smartmoney-core.test.js  JS 單元測試
tests/parity.js                JS ↔ Python 一致性檢核
netlify/functions/telegram.js  Telegram 代理（Netlify）；functions/api/telegram.js（Cloudflare）
netlify/functions/finmind.js   新增 endpoint 參數（taiwan_futures_snapshot 等）；functions/api/finmind.js 同
local-proxy.py                 本機代理：新增 /finmind?endpoint=… 與 POST /telegram
```
