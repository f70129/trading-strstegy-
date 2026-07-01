# GitHub 上傳與 Netlify 部署指南

本資料夾即為完整上線套件，可直接 push 至 GitHub，再連接 Netlify 供手機使用。

## 套件內容

```
taiwan-trading-dashboard/
├── index.html              電腦完整版
├── mobile.html             手機版（Netlify 推薦入口）
├── js/dashboard.js         共用核心邏輯
├── js/mobile-ui.js         手機 UI
├── sw.js / manifest*.json  PWA
├── netlify.toml            Netlify 設定
├── netlify/functions/      雲端代理（twse / taifex / fred / finmind）
├── functions/api/          Cloudflare Pages 用（可選）
├── local-proxy.py          本機開發用（可選，不影響 Netlify）
├── 啟動看板.bat / 啟動手機版.bat
└── README.md
```

## 方式 A：上傳 ZIP（最簡單）

1. 使用專案根目錄的 **`taiwan-trading-dashboard-github.zip`**
2. 至 [github.com/new](https://github.com/new) 建立新 repo（例：`taiwan-trading-dashboard`）
3. 選 **Upload files** → 拖入 zip 解壓後的所有檔案（或上傳 zip 後在網頁解壓）
4. Commit → 完成

## 方式 B：Git 指令

```powershell
cd taiwan-trading-dashboard
git init
git branch -M main
git add .
git commit -m "台指交易看板：電腦版 + 手機版 + Netlify 雲端代理"
git remote add origin https://github.com/你的帳號/taiwan-trading-dashboard.git
git push -u origin main
```

## Netlify 部署（手機 4G 可用）

1. 登入 [app.netlify.com](https://app.netlify.com)
2. **Add new site** → **Import an existing project** → 選 GitHub repo
3. 設定維持預設即可（Build command 留空，Publish directory = `.`）
4. **Deploy site**
5. 手機開啟：`https://你的網站名.netlify.app/mobile.html`
6. **設定**分頁填入：
   - FinMind Token（[finmindtrade.com](https://finmindtrade.com) 免費註冊）
   - FRED API Key（[fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html)）
7. iPhone / Android → **加入主畫面**

## 安全提醒

- **不要**把 FinMind Token、FRED Key 寫進程式碼再 push
- Token 只存在使用者手機瀏覽器的 localStorage
- 若曾不小心 commit 金鑰，請至 FinMind / FRED 後台重設

## 本機 vs 手機（Netlify）差異

| 項目 | 本機電腦 | 手機 Netlify |
|------|----------|--------------|
| 程式 | 本資料夾 `js/dashboard.js` | **GitHub 上同一檔**（需正確 push） |
| FinMind Token | 電腦瀏覽器 localStorage | **手機要再填一次**（不共用） |
| 即時代理 | `local-proxy.py` / 8787 | `netlify/functions/` 雲端函式 |
| 量價分析 | 本機已修復 v12 | GitHub **必須含最新 `js/dashboard.js`** |

手機失敗、本機成功 → **99% 是 GitHub 仍是舊版或目錄結構錯誤**（`dashboard.js` 平铺在根目錄而非 `js/` 內）。

## 部署後驗證

右上角應顯示 **「● 雲端代理已就緒」**，載入 2330 / 加權 / 台指 有即時報價即成功。

## Netlify 部署失敗（Initializing Failed）

常見原因與解法：

| 原因 | 解法 |
|------|------|
| `netlify.toml` 含 **User-Agent redirect** | 已移除；重新 push 後 Retry deploy |
| 檔案在 **子資料夾** 而非 repo 根目錄 | GitHub 根目錄應直接有 `index.html`、`netlify.toml` |
| Build command 設錯 | **留空**（靜態站，不需 build） |
| Publish directory 設錯 | 填 `.` 或留空 |

Netlify 後台 → **Deploys** → 點 **Why did it fail?** 可看到完整錯誤訊息。

修正後：GitHub 更新檔案 → Netlify **Retry deploy** 或 **Trigger deploy**。
