# FRED 美股指數設定

FRED **無法**從瀏覽器直接呼叫，必須透過後端代理。

## 方案 A：Netlify 部署（推薦，不用填 Worker 網址）

1. 將整個 `taiwan-trading-dashboard` 資料夾推到 GitHub
2. 登入 [Netlify](https://app.netlify.com) → **Add new site** → Import from Git
3. 選 repo，Build settings 使用預設（已含 `netlify.toml`）
4. **Site configuration → Environment variables** 新增：
   - `FRED_API_KEY` = 你的 FRED Key
5. Deploy 完成後，看板會**自動**使用：
   ```
   https://你的網站.netlify.app/.netlify/functions/fred
   ```
6. 右上角 **FRED → 測試連線** 應顯示 ✅

> **GitHub Pages 純靜態部署無法跑 FRED**，請改用 Netlify 或方案 B。

## 方案 B：Cloudflare Worker

1. Cloudflare → Workers → Create
2. 貼上 `workers/fred-proxy.js` → Deploy
3. Settings → Variables → `FRED_API_KEY`
4. 看板右上角 **FRED** → 貼 Worker 網址 → **測試連線**

測試網址（瀏覽器開啟）：
```
https://你的worker.workers.dev?health=1
```
應回傳：`{"ok":true,"hasKey":true,...}`

## 方案 C：Cloudflare Pages

1. Pages 部署此 repo
2. 設定環境變數 `FRED_API_KEY`
3. 自動使用 `/api/fred`（`functions/api/fred.js`）

## 疑難排解

| 錯誤 | 原因 |
|------|------|
| `FRED_API_KEY 未設定` | 後台環境變數未填或忘記 Redeploy |
| `代理回傳非 JSON` | Worker 網址打錯，或貼成 FRED 官網網址 |
| `hasKey: false` | health 有回但 Key 沒綁上 Worker |
| 本機 `file://` 開啟 | 無法用同源自動代理，請用 `python -m http.server` 或部署 |

## 安全

- **不要把 FRED Key 寫進 `index.html` 或 Git**
- Key 只放在 Netlify / Cloudflare 環境變數
