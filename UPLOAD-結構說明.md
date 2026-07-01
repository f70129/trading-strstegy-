# ⚠️ GitHub 上傳結構說明（必讀）

## 你目前的問題

若 GitHub 根目錄長這樣（**全部平铺**）→ **錯誤**：

```
dashboard.js          ← 應在 js/ 裡
mobile-ui.js          ← 應在 js/ 裡
twse.js               ← 應在 netlify/functions/ 裡
fred (2).js           ← 重複，應刪除
README (6).md         ← 重複，應刪除
index.html
...
```

網頁引用的是 `js/dashboard.js` 和 `/.netlify/functions/twse`，平铺會 **404 → 整站壞掉**。

---

## 正確結構（repo 根目錄）

```
trading-strategy/          ← GitHub repo 根目錄
├── index.html
├── mobile.html
├── netlify.toml
├── .netlifyignore
├── sw.js
├── manifest.json
├── manifest-mobile.json
├── icon.svg
├── README.md
├── js/
│   ├── dashboard.js
│   └── mobile-ui.js
└── netlify/
    └── functions/
        ├── twse.js
        ├── taifex.js
        ├── fred.js
        └── finmind.js
```

（`local-proxy.py`、`*.bat` 可不上傳，Netlify 不需要）

---

## 重新上傳步驟

### 方法 1：刪除重傳（推薦）

1. GitHub 進入 repo → 逐一刪除根目錄**所有檔案**（或刪除 repo 重建）
2. 在本機**解壓** `taiwan-trading-dashboard-github.zip`
3. 解壓後會看到 `js`、`netlify` 等**資料夾**
4. GitHub → **Add file** → **Upload files**
5. 把解壓後的**所有檔案與資料夾**一次拖進去（要看到 `js` 資料夾，不是只有 .js 檔）
6. Commit

### 方法 2：只補資料夾

若不想全刪，至少：

1. 刪除根目錄的 `dashboard.js`、`mobile-ui.js`、`twse.js`、`fred*.js`、`taifex*.js`
2. 刪除 `README (6).md`、`fred (2).js`、`taifex (3).js` 等重複檔
3. Upload → 建立 `js` 資料夾，放入 `dashboard.js`、`mobile-ui.js`
4. Upload → 建立 `netlify/functions/`，放入四個 .js

---

## Netlify 設定

| 項目 | 值 |
|------|-----|
| Build command | **留空** |
| Publish directory | `.` |
| Base directory | 留空 |

Deploy 成功後開：`https://你的網站.netlify.app/mobile.html`

---

## 快速檢查

在 GitHub 點進 repo，應能點開 **`js`** 資料夾看到 `dashboard.js`，點開 **`netlify/functions`** 看到 `twse.js`。若看不到這兩個資料夾，結構仍錯。
