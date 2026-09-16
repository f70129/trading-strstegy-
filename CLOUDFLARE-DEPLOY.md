# Cloudflare Pages 部署指南（避開常見錯誤）

## 你看到的錯誤代表什麼？

```
Installing project dependencies: pip install -r requirements.txt
Executing user deploy command: npx wrangler deploy
Could not detect a directory containing static files
```

這表示 Cloudflare 被設成 **Workers + Python（Streamlit）**，不是這個 **靜態 HTML 看板**。

本專案根目錄有 `index.html`、`mobile.html`、`js/`，**沒有** Streamlit，也**不應**執行 `npx wrangler deploy`。

---

## 正確做法：建立 Cloudflare Pages（不是 Workers）

### 1. 刪除或停用錯誤的 Worker 專案

若先前在 **Workers** 建立專案並設了 Deploy command，請改開 **Pages**。

### 2. 新建 Pages 專案

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages**
2. **Create** → **Pages** → **Connect to Git**
3. 選 repo：`f70129/trading-strstegy-`（或你的 fork）
4. **Branch**：`main`

### 3. Build 設定（重要）

| 欄位 | 填什麼 |
|------|--------|
| Framework preset | **None** |
| Build command | **留空**（或 `npm run build`） |
| Build output directory | **`.`**（一個點，代表 repo 根目錄） |
| Deploy command | **留空**；若介面強制必填 → 改填 **`npm run deploy`**（勿用 `npx wrangler deploy`） |

### 4. 環境變數

**Settings → Environment variables → Production**：

| Key | Value |
|-----|-------|
| `FINMIND_TOKEN` | FinMind API Token |
| `FRED_API_KEY` | FRED API Key |

儲存後 **Retry deployment**。

### 5. 驗證

- 電腦：`https://你的專案.pages.dev/?v=43`
- 手機：`https://你的專案.pages.dev/mobile.html?v=43`
- 右上角應顯示 **「● Cloudflare 已就緒」** 或 **「● Cloudflare 代理已就緒」**
- API 測試：`https://你的專案.pages.dev/api/finmind?health=1`

---

## 常見錯誤對照

| 現象 | 原因 | 解法 |
|------|------|------|
| pip install streamlit | 連到錯的 repo／分支，或 Build 設錯 | 確認 repo 根目錄有 `index.html`，Build 留空 |
| `wrangler deploy` 找不到 static | Deploy 用了 Workers 指令 | 改填 **`npm run deploy`**（內建 `wrangler pages deploy`） |
| Deploy command 無法刪除 | 新版 Cloudflare 介面強制必填 | 填 **`npm run deploy`**，專案名須為 `trading-strstegy` |
| `/api/finmind` 404 | Functions 未部署 | 確認 repo 有 `functions/api/` 資料夾 |
| Token 失效 | 環境變數未設 | 填 `FINMIND_TOKEN` 後 Redeploy |

---

## 與 Netlify 並存

同一 repo 可同時部署 Netlify + Cloudflare Pages，程式 v43 會自動偵測平台。

Netlify 額度不足時，把手機書籤改指向 `.pages.dev` 即可。
