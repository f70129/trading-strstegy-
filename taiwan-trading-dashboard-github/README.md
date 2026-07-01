# 台指交易分析看板（純 HTML）

單頁網頁版交易看板：費波那契、波浪、凱利公式、十步驟交易系統、交易筆記（瀏覽器 localStorage）。

## 本機預覽

直接用瀏覽器開啟 `index.html`，或：

```powershell
cd taiwan-trading-dashboard
python -m http.server 8080
```

瀏覽器開啟：http://localhost:8080

## 部署建議

| 平台 | 台股 FinMind | 美股 FRED | 個股搜尋 |
|------|-------------|-----------|----------|
| **Netlify**（推薦） | ✅ | ✅ 自動 | ✅ |
| GitHub Pages | ✅ | ❌ 需另設 Worker | ✅ |
| 本機 `http.server` | ✅ | 需 Worker 網址 | ✅ |

### Netlify 一鍵部署（含 FRED）

1. Push 到 GitHub（根目錄要有 `index.html`、`netlify.toml`、`netlify/functions/`）
2. [Netlify](https://app.netlify.com) → Import repo
3. **Build command 留空**，Publish directory = `.`（或留空，由 netlify.toml 決定）
4. Deploy → 手機開 `https://你的網站.netlify.app/mobile.html`

> 若部署失敗：確認 repo 根目錄不是 zip 子資料夾；`netlify.toml` 不可含 User-Agent redirect。

詳見 `GITHUB.md`

## 資料來源（真實數據）

| 商品 | 來源 |
|------|------|
| 加權 `^TWII`、台指 `TX`、個股日線 | **FinMind**（需免費 token）|
| 上市 / 上櫃搜尋 | **FinMind** TaiwanStockInfo（需免費 token）|
| **上市個股 / 加權指數盤中即時** | **TWSE MIS**（官方，需本機/部署代理） |
| **台指期近月盤中即時** | **TAIFEX 期交所**（官方，需本機/部署代理） |
| S&P / NASDAQ / VIX | **FRED**（直接填 Key，經公開 CORS 代理） |

- 全球概況：S&P 500、NASDAQ、VIX、台股加權（已移除恆生）
- 個股搜尋支援上市（twse）、上櫃（tpex），約 3700+ 檔
- 不再使用模擬數據

### 盤中即時報價（上市個股 / 加權指數 / 台指期）

| 商品 | 輸入 | 即時來源 | 交易時段 |
|------|------|----------|----------|
| 上市個股 | 例 `2330` | TWSE MIS | 09:00–13:30 |
| 加權指數 | `^TWII` / `加權` | TWSE MIS `t00` | 09:00–13:30 |
| 台指期近月 | `TX` / `台指` | TAIFEX | 日盤 08:45–13:45、夜盤 15:00–05:00 |

瀏覽器**無法直連** TWSE / TAIFEX（CORS），公開代理又常不穩，所以需要一個代理才能拿到真即時報價：

**A) 本機 file:// 開啟（最簡單）**

直接**雙擊 `啟動看板.bat`** — 會自動啟動即時代理並開啟看板（代理視窗請保持開著）。

或手動：

```powershell
cd taiwan-trading-dashboard
python local-proxy.py      # 保持視窗開著
```

然後雙擊 `index.html`，搜尋上市股（例 `2330`）。交易時段（09:00–13:30）會顯示綠框「上市盤中即時（TWSE）」與五檔。

> ⚠️ 代理是常駐程式，**電腦重開或關閉代理視窗後就會停**，即時報價會失效（台指期尤其只能靠代理）。重新雙擊 `啟動看板.bat` 即可恢復。

**B) 部署 Netlify / Cloudflare Pages**

已內建 `twse.js`（個股/加權）與 `taifex.js`（台指期）函式（`netlify/functions/` 與 `functions/api/` 各一份），部署後自動可用，無需本機代理。

**C) 自訂代理網址**（選用）

在瀏覽器 Console 執行：

```js
localStorage.setItem('twseProxyUrl','https://你的代理/twse')    // 個股 / 加權
localStorage.setItem('taifexProxyUrl','https://你的代理/taifex') // 台指期
```

> 盤後或非交易時段：自動顯示 FinMind **當日/最近收盤價**（技術分析一律使用日線）。
> 若代理連不上，面板會出現橘色警告，明確標示「目前為日線收盤，非即時」。

### 手機版 — 最便利用法（推薦 Netlify）

| 方式 | 便利度 | 說明 |
|------|--------|------|
| **Netlify 部署** | ⭐⭐⭐ 最推薦 | 手機開固定網址，4G/WiFi 皆可，免開電腦、免填 IP |
| 加入主畫面 PWA | ⭐⭐⭐ | iPhone / Android 像 App 一點就開 |
| 本機 WiFi + IP | ⭐ 較麻煩 | 僅適合不部署、只在家的情境 |

#### 一次部署（約 5 分鐘）

1. 把專案 push 到 GitHub
2. 登入 [Netlify](https://app.netlify.com) → Import repo → Deploy
3. 手機開 `https://你的網站.netlify.app/mobile.html`
4. **設定**分頁：貼 FinMind Token + FRED Key → 儲存（只需一次）
5. **加入主畫面**：
   - **iPhone**：Safari → 底部「分享」→「加入主畫面」
   - **Android**：Chrome → 右上角 ⋮ →「加入主畫面」或「安裝應用程式」

之後點主畫面圖示即可，右上角會顯示「● 雲端代理已就緒」。

#### 本機 WiFi 模式（不部署時）

雙擊 `啟動手機版.bat` → 手機同 WiFi 開 `http://<電腦IP>:8080/mobile.html` → 設定填 `<電腦IP>:8787`。（較繁瑣，不推薦日常使用）

### FinMind Token 設定（台股日線必須）

FinMind 匿名額度只有 300 次/小時且全網共用，常被用爆而回傳 **402（Requests reach the upper limit）**，導致台股日線 / 期貨 / 個股清單載入失敗。請填入自己的免費 token：

1. 至 [finmindtrade.com](https://finmindtrade.com/) 免費註冊並驗證信箱（接受 Gmail / Yahoo / iCloud）
2. 登入後在帳號頁複製 **API Token**
3. 看板右上角 **FRED** 按鈕 → 面板最上方「FinMind Token」貼上 → 儲存並重新載入

> 免費 token 有專屬 600 次/小時，本看板日線資料（個股、加權、期貨、清單）皆在免費層。Token 只存在本機瀏覽器。

### FRED 設定（免部署）

1. 點看板右上角 **FRED**
2. 貼上你的 FRED API Key → **儲存並重新載入**（可先按「測試連線」）
3. Key 只存在本機瀏覽器 `localStorage`

> ⚠️ FRED 不支援瀏覽器直連，看板會經公開 CORS 代理（allorigins 等）轉發。
> 若把此網站公開分享，他人可從瀏覽器讀到你填的 Key；公開部署時建議改用 `workers/` 內的後端代理方案（選用）。

## GitHub Pages（僅台股，無 FRED）

```powershell
cd taiwan-trading-dashboard
git push -u origin main
```

Settings → Pages → branch `main` → 網址 `https://帳號.github.io/taiwan-trading-dashboard/`

> 若也要美股指數，請改部署 **Netlify**（見 `workers/README.md`）

## 手機當 App 用（PWA）

1. 用手機 Chrome / Safari 開啟上述網址
2. **加入主畫面** / **Add to Home Screen**
3. 桌面會出現「台指看板」圖示

## 免責聲明

本看板為技術分析輔助工具，非投資建議。
