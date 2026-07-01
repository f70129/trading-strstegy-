<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0a0e1a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="台指看板">
<link rel="manifest" href="manifest-mobile.json">
<link rel="apple-touch-icon" href="icon.svg">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<title>台指看板 · 手機版</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg: #0a0e1a; --panel: #111827; --border: #1f2d40;
  --accent: #00d4ff; --green: #00ff88; --red: #ff4466;
  --gold: #ffd700; --text: #e2e8f0; --muted: #6b7280;
  --nav-h: 56px; --hdr-h: 52px;
}
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
body.mobile-app {
  background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px; padding-bottom: calc(var(--nav-h) + env(safe-area-inset-bottom));
}
.mob-header {
  position: sticky; top: 0; z-index: 200;
  background: linear-gradient(135deg, #0a0e1a, #1a1f35);
  border-bottom: 1px solid var(--accent);
  padding: 8px 12px; padding-top: max(8px, env(safe-area-inset-top));
}
.mob-header h1 { font-size: 15px; color: var(--accent); margin-bottom: 6px; }
.mob-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.symbol-input {
  flex: 1; min-width: 80px; background: #1a2035; border: 1px solid var(--accent);
  color: var(--accent); padding: 10px 12px; border-radius: 8px; font-size: 16px;
  text-transform: uppercase;
}
.btn {
  background: var(--accent); color: #000; border: none; padding: 10px 14px;
  border-radius: 8px; font-weight: 600; font-size: 13px; min-height: 44px;
}
.btn-outline { background: transparent; border: 1px solid var(--muted); color: var(--muted); }
.btn-sm { padding: 8px 10px; min-height: 40px; font-size: 12px; }
.badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.data-badge { font-size: 10px; padding: 3px 8px; border-radius: 12px; white-space: nowrap; }
.data-live { background: rgba(0,255,136,.15); color: var(--green); border: 1px solid var(--green); }
.data-error { background: rgba(255,68,102,.15); color: var(--red); border: 1px solid var(--red); }
.data-loading { background: rgba(0,212,255,.1); color: var(--accent); border: 1px solid var(--accent); }

.mob-main { padding: 10px 12px; }
.mob-panel { display: none; }
.mob-panel.active { display: block; }
.panel {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px; margin-bottom: 10px;
}
.panel-title {
  font-size: 11px; color: var(--accent); letter-spacing: 1px;
  margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 6px;
}
.panel-title .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.stat-card { background: #0d1526; border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
.stat-label { color: var(--muted); font-size: 10px; margin-bottom: 4px; }
.stat-value { font-size: 22px; font-weight: bold; }
.stat-sub { font-size: 11px; margin-top: 4px; }
.up { color: var(--green); } .down { color: var(--red); } .neutral { color: var(--accent); } .gold { color: var(--gold); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.grid-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.trend-badge { display: inline-flex; padding: 4px 10px; border-radius: 16px; font-size: 11px; font-weight: 600; }
.bull { background: rgba(0,255,136,.15); border: 1px solid var(--green); color: var(--green); }
.bear { background: rgba(255,68,102,.15); border: 1px solid var(--red); color: var(--red); }
.sideways { background: rgba(255,213,0,.15); border: 1px solid var(--gold); color: var(--gold); }
.chart-wrap { position: relative; height: 180px; }
.loading { color: var(--muted); text-align: center; padding: 20px; font-size: 12px; }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--muted); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; vertical-align: middle; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }
.search-input { width: 100%; background: #1a2035; border: 1px solid var(--border); color: var(--text); padding: 12px; border-radius: 8px; font-size: 16px; margin-bottom: 8px; }
.search-results { max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; display: none; }
.search-item { padding: 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
.search-item:active { background: #1a2035; }
.input-field { width: 100%; background: #1a2035; border: 1px solid var(--border); color: var(--text); padding: 12px; border-radius: 8px; font-size: 14px; margin-bottom: 8px; }
.input-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; display: block; }
.hint { font-size: 11px; color: var(--muted); line-height: 1.6; margin-bottom: 10px; }

.mob-nav {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 300;
  height: calc(var(--nav-h) + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: #0d1526; border-top: 1px solid var(--border);
  display: grid; grid-template-columns: repeat(4, 1fr);
}
.mob-tab {
  background: none; border: none; color: var(--muted);
  font-size: 11px; padding: 8px 4px; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
}
.mob-tab.active { color: var(--accent); }
.mob-tab span.icon { font-size: 18px; line-height: 1; }
#elliottWave, #fibLevels { display: none !important; }
</style>
</head>
<body class="mobile-app">

<header class="mob-header">
  <h1>📱 台指看板 · 手機版</h1>
  <div class="mob-row">
    <input class="symbol-input" id="symbolInput" placeholder="2330 / ^TWII / TX" value="^TWII">
    <button class="btn btn-sm" type="button" onclick="quickSymbol('^TWII')">加權</button>
    <button class="btn btn-sm" type="button" onclick="quickSymbol('TX')">台指</button>
    <button class="btn btn-sm" onclick="loadSymbol()">載入</button>
  </div>
  <div class="badges">
    <span id="proxyStatus" class="data-badge data-loading">● 代理…</span>
    <span id="dataStatus" class="data-badge data-loading">● 載入中</span>
    <span id="clockDisplay" class="data-badge" style="border:1px solid var(--border);color:var(--muted);"></span>
  </div>
</header>

<main class="mob-main">

  <!-- 標的 -->
  <div id="tab-quote" class="mob-panel active">
    <div class="panel">
      <div class="panel-title"><div class="dot"></div>目標標的 · <span id="targetSymbolTitle" style="color:var(--gold)">-</span></div>
      <div id="targetInfo"><div class="loading"><span class="spinner"></span>請載入標的</div></div>
    </div>
    <div class="panel">
      <div class="panel-title"><div class="dot"></div>趨勢判斷</div>
      <div id="trendSystem"><div class="loading">等待數據</div></div>
    </div>
    <div class="panel">
      <div class="panel-title"><div class="dot"></div>價格走勢</div>
      <div class="chart-wrap"><canvas id="priceChart"></canvas></div>
    </div>
  </div>

  <!-- 量價 -->
  <div id="tab-volume" class="mob-panel">
    <div class="panel">
      <div class="panel-title"><div class="dot"></div>量價關係 · 當日與 5 日</div>
      <div id="volumeAnalysis"><div class="loading">等待數據</div></div>
    </div>
  </div>

  <!-- 概況 -->
  <div id="tab-market" class="mob-panel">
    <div class="panel">
      <div class="panel-title"><div class="dot"></div>全球市場概況</div>
      <div class="grid-2" id="marketOverview"><div class="loading"><span class="spinner"></span>載入中</div></div>
    </div>
    <div class="panel">
      <div class="panel-title"><div class="dot"></div>市場情緒</div>
      <div id="sentimentGrid"><div class="loading">載入中</div></div>
    </div>
  </div>

  <!-- 設定 / 搜尋 -->
  <div id="tab-more" class="mob-panel">
    <div class="panel search-wrap">
      <div class="panel-title"><div class="dot"></div>台股搜尋</div>
      <input class="search-input" id="stockSearchInput" type="search" autocomplete="off" placeholder="代號或名稱，例 2330">
      <div id="stockSearchResults" class="search-results"></div>
      <div id="stockSearchMeta" class="hint">載入清單中…</div>
    </div>
    <div class="panel">
      <div class="panel-title"><div class="dot"></div>連線設定</div>
      <div id="cloudHint" class="hint" style="display:none;color:var(--green);">
        ✓ 已使用雲端代理，免填 IP、4G/WiFi 皆可，電腦不必開著。
      </div>
      <div id="proxyHostBlock">
        <label class="input-label">代理位址（僅本機 WiFi 模式）</label>
        <input class="input-field" id="proxyHostInput" placeholder="例 192.168.1.100:8787">
        <div class="hint">本機模式才需填。建議改部署 Netlify，手機直接用網址，免此步驟。</div>
      </div>
      <label class="input-label">FinMind Token</label>
      <input class="input-field" id="finmindTokenInput" placeholder="finmindtrade.com 免費 token">
      <label class="input-label">FRED API Key</label>
      <input class="input-field" id="fredKeyInput" placeholder="美股 S&P / VIX">
      <button class="btn" type="button" style="width:100%;margin-top:8px;" onclick="saveMobileSettings()">儲存並重新載入</button>
    </div>
    <div class="panel">
      <div class="hint">
        <strong>📱 最便利用法（推薦）</strong><br>
        部署 Netlify 一次 → 手機開固定網址 → 加入主畫面，像 App 一樣用。<br><br>
        <strong>iPhone</strong>：Safari 開啟 → 分享 → 加入主畫面<br>
        <strong>Android</strong>：Chrome 開啟 → ⋮ → 加入主畫面 / 安裝應用程式<br><br>
        首次：設定分頁填入 FinMind Token + FRED Key → 儲存（只需一次）<br>
        <a href="index.html" style="color:var(--accent);">→ 電腦完整版</a>
      </div>
    </div>
  </div>

</main>

<!-- 桌面版才用的隱藏節點（共用 JS） -->
<div id="elliottWave" style="display:none"></div>
<div id="fibLevels" style="display:none"></div>
<div id="fredSettings" style="display:none"></div>
<span id="symbolBadge" style="display:none"></span>

<nav class="mob-nav">
  <button type="button" class="mob-tab active" data-tab="quote"><span class="icon">📊</span>標的</button>
  <button type="button" class="mob-tab" data-tab="volume"><span class="icon">📈</span>量價</button>
  <button type="button" class="mob-tab" data-tab="market"><span class="icon">🌐</span>概況</button>
  <button type="button" class="mob-tab" data-tab="more"><span class="icon">⚙️</span>設定</button>
</nav>

<script src="js/dashboard.js"></script>
<script src="js/mobile-ui.js"></script>
</body>
</html>
