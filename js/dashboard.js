// =====================================================
// STATE
// =====================================================
let state = {
  symbol: '^TWII',
  currentPrice: null,
  highPrice: null,
  lowPrice: null,
  prices: [],
  ma21: null,
  ma55: null,
  ma144: null,
  ma233: null,
  trend: 'neutral',
  fibLevels: {},
  tradeLog: JSON.parse(localStorage.getItem('tradeLog') || '[]'),
  priceChart: null,
  stockList: [],
  stockFilter: 'all',
  realtimeTimer: null,
  realtimeKey: null,
  realtimeChannel: null,
  lastTargetInfo: null,
  lastCloses: null,
  lastVolumes: null,
};

// =====================================================
// CLOCK
// =====================================================
function updateClock() {
  const now = new Date();
  document.getElementById('clockDisplay').textContent =
    now.toLocaleDateString('zh-TW') + ' ' + now.toLocaleTimeString('zh-TW');
}
setInterval(updateClock, 1000);
updateClock();

// =====================================================
// SYMBOL MAPPING
// =====================================================
function resolveSymbol(input) {
  const s = input.trim().toUpperCase();
  const map = {
    'TWII': '^TWII', '^TWII': '^TWII',
    'TX': 'FITX.TW', '台指': 'FITX.TW', '台指期': 'FITX.TW',
    'FITX': 'FITX.TW', 'FITX.TW': 'FITX.TW', 'TX00': 'TX00.TW', 'TX00.TW': 'TX00.TW',
    'SPX': '^GSPC', 'SP500': '^GSPC', '^SPX': '^GSPC',
    'NDX': '^IXIC', 'NASDAQ': '^IXIC',
    'DJI': '^DJI',
    'VIX': '^VIX',
    'SOX': '^SOX',
    'HSI': '^HSI',
  };
  if (map[s]) return map[s];
  // Taiwan stocks: 4-digit number
  if (/^\d{4,5}$/.test(s)) return s + '.TW';
  // Taiwan futures approximation
  if (s.endsWith('.TW') || s.startsWith('^')) return s;
  return s;
}

function displaySymbol(raw) {
  const s = raw.trim().toUpperCase();
  if (/^\d{4,5}$/.test(s)) return s;
  if (s === 'TX' || s === 'TWII') return '台指期/台股';
  return s;
}

function quickSymbol(sym) {
  document.getElementById('symbolInput').value = sym;
  loadSymbol();
}

// =====================================================
// REAL DATA — FinMind (台股/台指) + Yahoo (全球指數)
// =====================================================
const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';
const TAIEX_CACHE_KEY = 'finmind_taiex_daily_v3';
const TAIEX_VOL_CACHE_KEY = 'finmind_taiex_vol_v1';

/** FinMind 成交量欄位（API 版本命名不一致） */
function volumeFromRow(r, extraKeys = []) {
  if (!r || typeof r !== 'object') return 0;
  const keys = [
    ...extraKeys,
    'Trading_Volume', 'trading_volume', 'Trading_volume',
    'volume', 'Volume', 'TotalDealVolume', 'total_deal_volume',
    'CTotalVolume',
  ];
  for (const k of keys) {
    const v = Number(r[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

function getProxyHost() {
  return (localStorage.getItem('proxyHost') || '127.0.0.1:8787').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function isCloudDeployed() {
  if (location.protocol === 'file:') return false;
  const h = location.hostname;
  if (['localhost', '127.0.0.1'].includes(h)) return false;
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  return true;
}

function cloudFn(path) {
  return `/.netlify/functions/${path}`;
}

function proxyUrl(path) {
  return `http://${getProxyHost()}${path.startsWith('/') ? path : '/' + path}`;
}

function setHtml(id, html) {
  const e = document.getElementById(id);
  if (e) e.innerHTML = html;
}

function setDataStatus(mode, text) {
  const el = document.getElementById('dataStatus');
  if (!el) return;
  el.className = 'data-badge ' + (mode === 'ok' ? 'data-live' : mode === 'err' ? 'data-error' : 'data-loading');
  el.textContent = text;
}

async function checkProxyHealth() {
  const el = document.getElementById('proxyStatus');
  if (!el) return false;

  if (isCloudDeployed()) {
    try {
      const [fredR, finR] = await Promise.all([
        fetch(`${cloudFn('fred')}?health=1`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${cloudFn('finmind')}?health=1`, { signal: AbortSignal.timeout(5000) }),
      ]);
      if (fredR.ok && finR.ok) {
        const fredJ = await fredR.json();
        const finJ = await finR.json();
        window._cloudHasFred = !!fredJ.hasKey;
        window._cloudHasFinMind = !!finJ.hasToken;
        if (typeof updateMobileTokenStatus === 'function') updateMobileTokenStatus();
        el.className = 'data-badge data-live';
        const builtIn = window._cloudHasFred && window._cloudHasFinMind;
        el.textContent = builtIn ? '● 雲端已就緒（免填 Token）' : '● 雲端代理已就緒';
        el.title = builtIn
          ? 'Netlify 已內建 FinMind + FRED，手機開即用'
          : 'Netlify 函式 · 若資料失敗請在 Netlify 後台加 FINMIND_TOKEN / FRED_API_KEY';
        return true;
      }
    } catch (_) {}
    el.className = 'data-badge data-error';
    el.textContent = '● 雲端代理異常';
    return false;
  }

  const host = getProxyHost();
  const urls = [`http://${host}/health`, 'http://127.0.0.1:8787/health', 'http://localhost:8787/health'];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.ok) {
        el.className = 'data-badge data-live';
        el.textContent = '● 即時代理已連線';
        el.title = '本機代理 8787 正常 · 個股/加權/台指期/FRED 可用';
        return true;
      }
    } catch (_) { /* next */ }
  }
  el.className = 'data-badge data-error';
  el.textContent = '● 即時代理未啟動';
  el.title = '請雙擊「啟動看板.bat」或執行 python local-proxy.py';
  return false;
}

function showLoadError(message) {
  const html = `<div class="error-panel"><div style="font-size:14px;margin-bottom:8px;">⚠️ 無法取得真實數據</div>
    <div style="color:var(--muted);font-size:12px;margin-bottom:12px;">${message}</div>
    <button class="btn" onclick="loadSymbol()">重新載入</button></div>`;
  setHtml('targetInfo', html);
  setHtml('trendSystem', html);
  setHtml('elliottWave', html);
  setHtml('fibLevels', html);
  if (document.getElementById('hurstCycles')) setHtml('hurstCycles', html);
  if (document.getElementById('volumeAnalysis')) setHtml('volumeAnalysis', html);
  setDataStatus('err', '● 資料載入失敗');
}

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function setCookie(name, value, days = 400) {
  const maxAge = days * 86400;
  if (value) {
    document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${maxAge};SameSite=Lax`;
  } else {
    document.cookie = `${name}=;path=/;max-age=0;SameSite=Lax`;
  }
}

function getFinMindToken() {
  return (localStorage.getItem('finmindToken') || getCookie('fm_token') || '').trim();
}

function isStandalonePWA() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function fetchFinMind(params) {
  const token = getFinMindToken();
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => qs.set(k, v));

  const fetchers = [];
  if (isCloudDeployed()) {
    const qCloud = new URLSearchParams(qs);
    if (token) qCloud.set('token', token);
    fetchers.push(() => fetch(`${cloudFn('finmind')}?${qCloud.toString()}`));
  } else if (token) {
    fetchers.push(
      () => fetch(proxyUrl(`/finmind?${qs.toString()}&token=${encodeURIComponent(token)}`)),
      () => fetch(`http://127.0.0.1:8787/finmind?${qs.toString()}&token=${encodeURIComponent(token)}`),
      () => fetch(`http://localhost:8787/finmind?${qs.toString()}&token=${encodeURIComponent(token)}`),
    );
  }
  const qDirect = new URLSearchParams(qs);
  if (token) qDirect.set('token', token);
  fetchers.push(() => fetch(`${FINMIND_API}?${qDirect.toString()}`));

  let lastErr = isCloudDeployed() && !token
    ? 'FinMind 未設定：請在 Netlify 後台加環境變數 FINMIND_TOKEN（手機免填）'
    : 'FinMind 連線失敗';
  for (const f of fetchers) {
    try {
      const r = await f();
      const json = await r.json();
      if (json.error) {
        lastErr = typeof json.error === 'string' ? json.error : json.msg || lastErr;
        continue;
      }
      if (json.status === 402 || /upper limit/i.test(json.msg || '')) {
        lastErr = 'FinMind 額度用盡（402）。請於設定填入免費 token。';
        continue;
      }
      if (json.status !== 200 || !Array.isArray(json.data)) {
        lastErr = json.msg || 'FinMind 回傳錯誤';
        continue;
      }
      return json.data;
    } catch (e) {
      lastErr = e.message || lastErr;
    }
  }
  throw new Error(lastErr);
}

function recentWeekdays(count) {
  const out = [];
  const d = new Date();
  while (out.length < count) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      out.push(d.toISOString().slice(0, 10));
    }
    d.setDate(d.getDate() - 1);
  }
  return out;
}

function aggregateTaiexTicks(rows) {
  if (!rows.length) return null;
  const prices = rows.map(r => r.TAIEX).filter(v => v > 0);
  if (!prices.length) return null;
  const day = String(rows[0].date).slice(0, 10);
  return {
    date: day,
    open: prices[0],
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices[prices.length - 1],
    volume: 0,
  };
}

async function fetchTaiexDay(date) {
  const rows = await fetchFinMind({
    dataset: 'TaiwanVariousIndicators5Seconds',
    start_date: date,
  });
  return aggregateTaiexTicks(rows);
}

async function fetchTaiexDailyHistory(days = 90, onProgress) {
  const cache = JSON.parse(localStorage.getItem(TAIEX_CACHE_KEY) || '{}');
  const dates = recentWeekdays(days);
  const missing = dates.filter(d => !cache[d]);
  let done = dates.length - missing.length;

  for (let i = 0; i < missing.length; i += 4) {
    const batch = missing.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map(d => fetchTaiexDay(d)));
    for (const res of results) {
      if (res.status === 'rejected') {
        const msg = res.reason?.message || '';
        if (/FinMind Token|402|雲端\/手機版|upper limit/i.test(msg)) throw res.reason;
      }
    }
    results.forEach((res, idx) => {
      if (res.status === 'fulfilled' && res.value) cache[batch[idx]] = res.value;
    });
    done += batch.length;
    if (onProgress) onProgress(Math.min(done, days), days);
    await new Promise(r => setTimeout(r, 120));
  }

  localStorage.setItem(TAIEX_CACHE_KEY, JSON.stringify(cache));
  return dates.map(d => cache[d]).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchTaiexMarketVolDay(date) {
  const rows = await fetchFinMind({
    dataset: 'TaiwanStockStatisticsOfOrderBookAndTrade',
    start_date: date,
  });
  if (!rows?.length) return null;
  let maxVol = 0;
  for (const r of rows) {
    const v = volumeFromRow(r, ['TotalDealVolume', 'TotalDealMoney']);
    if (v > maxVol) maxVol = v;
  }
  return maxVol > 0 ? maxVol : null;
}

async function ensureTaiexVolumeCache(dates, onProgress) {
  const cache = JSON.parse(localStorage.getItem(TAIEX_VOL_CACHE_KEY) || '{}');
  const missing = dates.filter(d => cache[d] == null);
  let done = dates.length - missing.length;

  for (let i = 0; i < missing.length; i += 3) {
    const batch = missing.slice(i, i + 3);
    const results = await Promise.allSettled(batch.map(d => fetchTaiexMarketVolDay(d)));
    results.forEach((res, idx) => {
      if (res.status === 'fulfilled' && res.value != null) cache[batch[idx]] = res.value;
    });
    done += batch.length;
    if (onProgress) onProgress(Math.min(done, dates.length), dates.length);
    await new Promise(r => setTimeout(r, 150));
  }

  localStorage.setItem(TAIEX_VOL_CACHE_KEY, JSON.stringify(cache));
  return cache;
}

function pickFrontMonthFutures(rows) {
  const byDate = {};
  for (const row of rows) {
    const d = row.date;
    const vol = volumeFromRow(row);
    if (!byDate[d] || vol > volumeFromRow(byDate[d])) byDate[d] = row;
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

function finMindRowsToSeries(rows, mapFn) {
  const bars = rows.map(mapFn).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 20) throw new Error('歷史資料不足');
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume || 0);
  const timestamps = bars.map(b => Math.floor(new Date(b.date).getTime() / 1000));
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const high52 = Math.max(...bars.map(b => b.high));
  const low52 = Math.min(...bars.map(b => b.low));
  return {
    closes,
    volumes,
    timestamps,
    price: last.close,
    change: last.close - prev.close,
    changePct: ((last.close - prev.close) / prev.close) * 100,
    volume: last.volume || 0,
    high52,
    low52,
    marketCap: null,
    name: last.name,
    source: 'FinMind',
    updatedAt: new Date(),
  };
}

async function fetchFinMindStock(stockId, startDate, endDate) {
  const rows = await fetchFinMind({
    dataset: 'TaiwanStockPrice',
    data_id: stockId,
    start_date: startDate,
    end_date: endDate,
  });
  return finMindRowsToSeries(rows, r => ({
    date: r.date,
    open: r.open,
    high: r.max,
    low: r.min,
    close: r.close,
    volume: volumeFromRow(r),
    name: r.stock_name ? `${r.stock_id} ${r.stock_name}` : `台股 ${stockId}`,
  }));
}

async function fetchFinMindFutures(futuresId, startDate, endDate) {
  const rows = await fetchFinMind({
    dataset: 'TaiwanFuturesDaily',
    data_id: futuresId,
    start_date: startDate,
    end_date: endDate,
  });
  const front = pickFrontMonthFutures(rows);
  return finMindRowsToSeries(front, r => ({
    date: r.date,
    open: r.open,
    high: r.max,
    low: r.min,
    close: r.close,
    volume: volumeFromRow(r),
    name: `台指期 ${futuresId}`,
  }));
}

async function fetchFinMindTaiexIndex(onProgress) {
  const bars = await fetchTaiexDailyHistory(120, onProgress);
  if (bars.length < 20) throw new Error('加權指數歷史資料不足');
  const volCache = await ensureTaiexVolumeCache(bars.map(b => b.date), onProgress);
  return finMindRowsToSeries(bars, b => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: volCache[b.date] ?? 0,
    name: '台灣加權指數 TAIEX',
  }));
}

async function fetchViaProxy(targetUrl) {
  const proxies = [
    async (url) => {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
      if (!r.ok) throw new Error('proxy');
      const data = await r.json();
      return JSON.parse(data.contents);
    },
    async (url) => {
      const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
      if (!r.ok) throw new Error('proxy');
      return await r.json();
    },
    async (url) => {
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
      if (!r.ok) throw new Error('proxy');
      return await r.json();
    },
    async (url) => {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) throw new Error('direct');
      return await r.json();
    },
  ];
  for (const proxy of proxies) {
    try {
      const result = await proxy(targetUrl);
      if (result?.chart?.result?.[0]) return result;
    } catch (_) { /* next */ }
  }
  return null;
}

function parseYahooChart(json, minBars = 20) {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const quotes = r.indicators?.quote?.[0];
  const ts = r.timestamp || [];
  const closes = quotes?.close || [];
  const vols = quotes?.volume || [];
  const pairs = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c != null && c > 0) pairs.push({ t: ts[i], c, v: vols[i] || 0 });
  }
  if (pairs.length < minBars) return null;
  const meta = r.meta;
  const price = meta.regularMarketPrice || pairs[pairs.length - 1].c;
  const prev = meta.previousClose || meta.chartPreviousClose || pairs[pairs.length - 2].c;
  const closeVals = pairs.map(p => p.c);
  return {
    closes: closeVals,
    volumes: pairs.map(p => p.v),
    timestamps: pairs.map(p => p.t),
    price,
    change: price - prev,
    changePct: ((price - prev) / prev) * 100,
    volume: meta.regularMarketVolume || 0,
    high52: meta.fiftyTwoWeekHigh || Math.max(...closeVals),
    low52: meta.fiftyTwoWeekLow || Math.min(...closeVals),
    marketCap: meta.marketCap || null,
    name: meta.shortName || meta.symbol,
    source: 'Yahoo Finance',
    updatedAt: new Date(),
  };
}

async function fetchYahooChart(ySymbol) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=1d&range=1y&includePrePost=false`;
    const json = await fetchViaProxy(url);
    const parsed = parseYahooChart(json);
    if (parsed) return parsed;
  }
  return null;
}

// =====================================================
// FRED（直接填 Key，經公開 CORS 代理連線，免部署）
// =====================================================
const STOCK_CACHE_KEY = 'tw_stock_list_v2';
const STOCK_CACHE_TTL = 24 * 60 * 60 * 1000;
const FRED_CACHE_TTL = 10 * 60 * 1000;
const _fredMem = new Map();
let _fredQueue = Promise.resolve();

function getFredKey() {
  return (localStorage.getItem('fredApiKey') || getCookie('fred_key') || '').trim();
}

function saveFredKey(key) {
  const k = (key || '').trim();
  if (k !== getFredKey()) {
    _fredMem.clear();
    try { localStorage.removeItem('fredSeriesCache'); } catch (_) {}
  }
  try { localStorage.setItem('fredApiKey', k); } catch (_) {}
  setCookie('fred_key', k);
}

function fredLsGet() {
  try { return JSON.parse(localStorage.getItem('fredSeriesCache') || '{}'); } catch { return {}; }
}
function fredLsSet(key, entry) {
  const all = fredLsGet();
  all[key] = entry;
  try { localStorage.setItem('fredSeriesCache', JSON.stringify(all)); } catch (_) {}
}

function enqueueFred(task) {
  const run = _fredQueue.then(() => new Promise(r => setTimeout(r, 350))).then(task);
  _fredQueue = run.catch(() => {});
  return run;
}

async function fetchWithTimeout(url, ms = 35000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchFredSeriesRaw(seriesId, limit) {
  const key = getFredKey();
  const q = `series_id=${encodeURIComponent(seriesId)}&limit=${limit}`;
  const qk = key ? `${q}&key=${encodeURIComponent(key)}` : q;
  const fredUrl = key
    ? `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=${limit}`
    : '';

  const fetchers = isCloudDeployed()
    ? [
        () => fetchWithTimeout(`${cloudFn('fred')}?${q}`, 20000).then(toJson),
        ...(key ? [() => fetchWithTimeout(`${cloudFn('fred')}?${qk}`, 20000).then(toJson)] : []),
        () => fetchWithTimeout(`/api/fred?${qk}`, 20000).then(toJson),
      ]
    : (() => {
        if (!key) throw new Error('請點右上角 FRED 填入 API Key');
        return [
          () => fetchWithTimeout(proxyUrl(`/fred?${qk}`), 20000).then(toJson),
          () => fetchWithTimeout(`http://127.0.0.1:8787/fred?${qk}`, 20000).then(toJson),
          () => fetchWithTimeout(`http://localhost:8787/fred?${qk}`, 20000).then(toJson),
          () => fetchWithTimeout(`${cloudFn('fred')}?${qk}`, 20000).then(toJson),
          () => fetchWithTimeout(`/api/fred?${qk}`, 20000).then(toJson),
          () => fetchWithTimeout(`https://api.allorigins.win/raw?url=${encodeURIComponent(fredUrl)}`).then(toJson),
          () => fetchWithTimeout(`https://api.allorigins.win/get?url=${encodeURIComponent(fredUrl)}`).then(toJsonContents),
        ];
      })();

  async function toJson(r) {
    if (!r.ok) throw new Error(`代理 HTTP ${r.status}`);
    return r.json();
  }
  async function toJsonContents(r) {
    if (!r.ok) throw new Error(`代理 HTTP ${r.status}`);
    const j = await r.json();
    return j && typeof j.contents === 'string' ? JSON.parse(j.contents) : j;
  }

  let lastErr = 'FRED 連線失敗';
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const fetcher of fetchers) {
      try {
        const json = await fetcher();
        if (json && json.error_message) throw new Error(json.error_message);
        const parsed = parseFredObservations(json);
        if (!parsed) { lastErr = 'FRED 資料不足'; continue; }
        return parsed;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? '連線逾時，重試中…' : (e.message || lastErr);
      }
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 800));
  }
  throw new Error(lastErr);
}

async function fetchFredSeries(seriesId, limit = 120) {
  const cacheKey = seriesId;
  const mem = _fredMem.get(cacheKey);
  if (mem && mem.limit >= limit && Date.now() - mem.ts < FRED_CACHE_TTL) {
    return mem.data;
  }
  const ls = fredLsGet()[cacheKey];
  if (ls && ls.limit >= limit && Date.now() - ls.ts < FRED_CACHE_TTL) {
    _fredMem.set(cacheKey, ls);
    return ls.data;
  }

  const needLimit = seriesId === 'SP500'
    ? Math.max(limit, mem?.limit || 0, ls?.limit || 0, 500)
    : Math.max(limit, mem?.limit || 0, ls?.limit || 0);

  const data = await enqueueFred(() => fetchFredSeriesRaw(seriesId, needLimit));
  const entry = { data, limit: needLimit, ts: Date.now() };
  _fredMem.set(cacheKey, entry);
  fredLsSet(cacheKey, entry);
  return data;
}

/** FRED 歷史區間（季節性分析用） */
async function fetchFredHistorical(seriesId, startDate, endDate) {
  const cacheKey = `hist_${seriesId}_${startDate}_${endDate}`;
  const ls = fredLsGet()[cacheKey];
  if (ls && ls.bars && Date.now() - ls.ts < 86400000) return ls.bars;

  const key = getFredKey();
  const q = `series_id=${encodeURIComponent(seriesId)}&observation_start=${startDate}&observation_end=${endDate}`;
  const qk = key ? `${q}&key=${encodeURIComponent(key)}` : q;
  const fredDirect = key
    ? `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${startDate}&observation_end=${endDate}&sort_order=asc`
    : '';

  const parseObs = (json) => {
    const obs = (json.observations || [])
      .filter(o => o.value !== '.' && !Number.isNaN(parseFloat(o.value)))
      .map(o => ({ date: o.date, close: parseFloat(o.value) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (obs.length < 100) throw new Error('FRED 歷史資料不足');
    fredLsSet(cacheKey, { bars: obs, ts: Date.now() });
    return obs;
  };

  const fetchers = [];
  if (isCloudDeployed()) {
    fetchers.push(() => fetchWithTimeout(`${cloudFn('fred')}?${q}`, 45000).then(r => r.json()));
    if (key) fetchers.push(() => fetchWithTimeout(`${cloudFn('fred')}?${qk}`, 45000).then(r => r.json()));
  }
  if (key) {
    fetchers.push(
      () => fetchWithTimeout(proxyUrl(`/fred?${qk}`), 45000).then(r => r.json()),
      () => fetchWithTimeout(`http://127.0.0.1:8787/fred?${qk}`, 45000).then(r => r.json()),
      () => fetchWithTimeout(`http://localhost:8787/fred?${qk}`, 45000).then(r => r.json()),
      () => fetchWithTimeout(`${cloudFn('fred')}?${qk}`, 45000).then(r => r.json()),
    );
    if (fredDirect) {
      fetchers.push(async () => {
        const r = await fetchWithTimeout(`https://api.allorigins.win/get?url=${encodeURIComponent(fredDirect)}`, 45000);
        const j = await r.json();
        return typeof j.contents === 'string' ? JSON.parse(j.contents) : j;
      });
    }
  }

  if (!fetchers.length) throw new Error('需 FRED API Key（設定面板或 Netlify FRED_API_KEY）');

  let lastErr = 'FRED 歷史資料載入失敗';
  for (const f of fetchers) {
    try {
      return parseObs(await f());
    } catch (e) {
      lastErr = e.message || lastErr;
    }
  }
  throw new Error(lastErr);
}

function finMindRowToBar(r) {
  const date = String(r.date).slice(0, 10);
  const close = parseFloat(r.close ?? r.price ?? r.TAIEX ?? r.closing_index);
  if (!date || !Number.isFinite(close) || close <= 0) return null;
  return { date, close };
}

async function fetchFinMindIndexBars(dataset, dataId, startDate, endDate) {
  const rows = await fetchFinMind({
    dataset,
    data_id: dataId,
    start_date: startDate,
    end_date: endDate,
  });
  return (rows || []).map(finMindRowToBar).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchTaiexIndexByYear(dataset, dataId, startDate, endDate) {
  const merged = [];
  const y0 = parseInt(startDate.slice(0, 4), 10);
  const y1 = parseInt(endDate.slice(0, 4), 10);
  for (let y = y0; y <= y1; y++) {
    try {
      const part = await fetchFinMindIndexBars(dataset, dataId, `${y}-01-01`, `${y}-12-31`);
      merged.push(...part);
    } catch (_) { /* try next year */ }
    await new Promise(r => setTimeout(r, 180));
  }
  const dedup = {};
  for (const b of merged) dedup[b.date] = b;
  return Object.values(dedup).sort((a, b) => a.date.localeCompare(b.date));
}

/** 台股加權指數歷史（FinMind 真實日資料） */
async function fetchTaiexIndexHistorical(startDate, endDate) {
  const cacheKey = `taiex_hist_v3_${startDate}_${endDate}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.bars && cached.bars.length >= 100 && Date.now() - cached.ts < 86400000) {
      return cached.bars;
    }
  } catch (_) { /* ignore */ }

  const strategies = [
    { dataset: 'TaiwanStockPrice', data_id: '001', label: '加權指數001' },
    { dataset: 'TaiwanStockTotalReturnIndex', data_id: 'TAIEX', label: 'TAIEX報酬指數' },
    { dataset: 'TaiwanStockPrice', data_id: 'TAIEX', label: 'TAIEX' },
  ];

  let lastErr = '台股加權歷史資料不足';
  for (const s of strategies) {
    try {
      let bars = await fetchFinMindIndexBars(s.dataset, s.data_id, startDate, endDate);
      if (bars.length < 100) {
        bars = await fetchTaiexIndexByYear(s.dataset, s.data_id, startDate, endDate);
      }
      if (bars.length >= 100) {
        localStorage.setItem(cacheKey, JSON.stringify({ bars, ts: Date.now(), source: s.label }));
        return bars;
      }
      lastErr = `${s.label} 僅 ${bars.length} 筆`;
    } catch (e) {
      lastErr = e.message || lastErr;
    }
  }
  throw new Error(lastErr + '（請確認 FinMind Token）');
}

function toggleFredSettings() {
  const el = document.getElementById('fredSettings');
  const show = el.style.display === 'none';
  el.style.display = show ? 'block' : 'none';
  if (show) {
    document.getElementById('fredKeyInput').value = getFredKey();
    document.getElementById('finmindTokenInput').value = getFinMindToken();
    document.getElementById('fredTestStatus').style.display = 'none';
  }
}

function saveFinMindToken(token) {
  const t = (token || '').trim();
  try { localStorage.setItem('finmindToken', t); } catch (_) {}
  setCookie('fm_token', t);
}

async function saveFredSettings() {
  saveFredKey(document.getElementById('fredKeyInput').value);
  saveFinMindToken(document.getElementById('finmindTokenInput').value);
  toggleFredSettings();
  await loadSymbol();
}

async function testFredConnection() {
  const statusEl = document.getElementById('fredTestStatus');
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = '測試中…';
  saveFredKey(document.getElementById('fredKeyInput').value);

  if (!getFredKey()) {
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = '請先填入 FRED API Key';
    return;
  }
  try {
    const data = await fetchFredSeries('SP500');
    statusEl.style.color = 'var(--green)';
    statusEl.textContent = `✅ 連線成功 · SP500 最新 ${data.price.toFixed(2)}`;
  } catch (e) {
    statusEl.style.color = 'var(--orange)';
    statusEl.textContent = `❌ ${e.message}`;
  }
}

function parseFredObservations(json) {
  const obs = (json.observations || [])
    .filter(o => o.value !== '.' && !Number.isNaN(parseFloat(o.value)))
    .map(o => ({ date: o.date, close: parseFloat(o.value) }));
  obs.reverse();
  if (obs.length < 2) return null;
  const closes = obs.map(o => o.close);
  const price = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  return {
    closes,
    timestamps: obs.map(o => Math.floor(new Date(o.date + 'T12:00:00').getTime() / 1000)),
    price,
    change: price - prev,
    changePct: ((price - prev) / prev) * 100,
    volume: 0,
    high52: Math.max(...closes),
    low52: Math.min(...closes),
    source: 'FRED',
    updatedAt: new Date(),
  };
}

// =====================================================
// 台股個股搜尋（FinMind TaiwanStockInfo）
// =====================================================
async function loadStockList() {
  const meta = document.getElementById('stockSearchMeta');
  try {
    const cached = JSON.parse(localStorage.getItem(STOCK_CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.ts < STOCK_CACHE_TTL) {
      state.stockList = cached.data;
      const twse = state.stockList.filter(s => s.type === 'twse').length;
      const tpex = state.stockList.filter(s => s.type === 'tpex').length;
      meta.textContent = `已快取 · 上市 ${twse} 檔 · 上櫃 ${tpex} 檔 · 資料來源 FinMind`;
      return;
    }
    meta.textContent = '下載股票清單中（FinMind）…';
    const rows = await fetchFinMind({ dataset: 'TaiwanStockInfo' });
    const map = new Map();
    for (const r of rows) {
      if (r.type === 'twse' || r.type === 'tpex') map.set(r.stock_id, r);
    }
    state.stockList = Array.from(map.values()).sort((a, b) => a.stock_id.localeCompare(b.stock_id));
    localStorage.setItem(STOCK_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: state.stockList }));
    const twse = state.stockList.filter(s => s.type === 'twse').length;
    const tpex = state.stockList.filter(s => s.type === 'tpex').length;
    meta.textContent = `上市 ${twse} 檔 · 上櫃 ${tpex} 檔 · 真實資料 FinMind`;
  } catch (e) {
    meta.textContent = '股票清單載入失敗：' + (e.message || '');
    meta.style.color = 'var(--red)';
  }
}

function marketLabel(type) {
  return type === 'twse' ? '上市' : type === 'tpex' ? '上櫃' : type;
}

function searchStocks(query) {
  const q = query.trim().toLowerCase();
  if (!q || !state.stockList.length) return [];
  return state.stockList.filter(s => {
    if (state.stockFilter !== 'all' && s.type !== state.stockFilter) return false;
    return s.stock_id.includes(q) || (s.stock_name && s.stock_name.toLowerCase().includes(q));
  }).slice(0, 25);
}

function renderStockSearchResults(items) {
  const box = document.getElementById('stockSearchResults');
  if (!items.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = 'block';
  box.innerHTML = items.map(s => `
    <div class="search-item" onclick="selectStock('${s.stock_id}')">
      <span class="code">${s.stock_id}</span>
      <span class="name">${s.stock_name || '-'}</span>
      <span class="mkt">${marketLabel(s.type)} · ${s.industry_category || ''}</span>
    </div>
  `).join('');
}

function setStockFilter(filter, btn) {
  state.stockFilter = filter;
  document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const q = document.getElementById('stockSearchInput').value;
  if (q) renderStockSearchResults(searchStocks(q));
}

function selectStock(stockId) {
  document.getElementById('symbolInput').value = stockId;
  document.getElementById('stockSearchInput').value = '';
  document.getElementById('stockSearchResults').style.display = 'none';
  loadSymbol();
}

function initStockSearch() {
  const input = document.getElementById('stockSearchInput');
  if (!input) return;
  input.addEventListener('input', () => {
    renderStockSearchResults(searchStocks(input.value));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const items = searchStocks(input.value);
      if (items.length) selectStock(items[0].stock_id);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
      document.getElementById('stockSearchResults').style.display = 'none';
    }
  });
  loadStockList();
}

// =====================================================
// 上市個股 TWSE 盤中即時報價
// =====================================================
function getTwTime(now = new Date()) {
  return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

function isTwMarketOpen(now = new Date()) {
  const tw = getTwTime(now);
  const day = tw.getDay();
  if (day === 0 || day === 6) return false;
  const hhmm = tw.getHours() * 100 + tw.getMinutes();
  return hhmm >= 845 && hhmm <= 1335;
}

function isFuturesOpen(now = new Date()) {
  const tw = getTwTime(now);
  const day = tw.getDay();
  const hhmm = tw.getHours() * 100 + tw.getMinutes();
  // 日盤 週一~五 08:45–13:45
  if (day >= 1 && day <= 5 && hhmm >= 845 && hhmm <= 1345) return true;
  // 夜盤 週一~五 15:00 之後
  if (day >= 1 && day <= 5 && hhmm >= 1500) return true;
  // 夜盤 跨日 週二~六 00:00–05:00
  if (day >= 2 && day <= 6 && hhmm <= 500) return true;
  return false;
}

function isListedTwStock(stockId) {
  if (!/^\d{4,5}$/.test(stockId)) return false;
  const item = state.stockList.find(s => s.stock_id === stockId);
  if (item) return item.type === 'twse';
  return stockId.length === 4;
}

// 回傳市場別給即時報價：'tse'（上市/未知）或 'otc'（上櫃），非台股回傳 null
function twMarketOf(stockId) {
  if (!/^\d{4,5}$/.test(stockId)) return null;
  const item = state.stockList.find(s => s.stock_id === stockId);
  if (item) return item.type === 'tpex' ? 'otc' : item.type === 'twse' ? 'tse' : null;
  return 'tse';
}

function parseTwsePrice(val) {
  if (val == null || val === '' || val === '-') return null;
  const n = parseFloat(String(val).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseTwseQuote(item, prevPrice, kind = 'stock', market = 'tse') {
  const yClose = parseTwsePrice(item.y);
  let price = parseTwsePrice(item.z);
  if (price == null) {
    const bestBid = parseTwsePrice((item.b || '').split('_')[0]);
    const bestAsk = parseTwsePrice((item.a || '').split('_')[0]);
    if (bestBid != null && bestAsk != null) price = (bestBid + bestAsk) / 2;
    else price = prevPrice ?? parseTwsePrice(item.o) ?? yClose;
  }
  if (price == null || yClose == null) throw new Error('TWSE 報價欄位不完整');
  const change = price - yClose;
  const changePct = yClose ? (change / yClose) * 100 : 0;
  const bids = (item.b || '').split('_').map(parseTwsePrice);
  const asks = (item.a || '').split('_').map(parseTwsePrice);
  const bidVol = (item.g || '').split('_').filter(Boolean);
  const askVol = (item.f || '').split('_').filter(Boolean);
  return {
    kind,
    code: item.c,
    name: item.n,
    price,
    yClose,
    change,
    changePct,
    open: parseTwsePrice(item.o),
    high: parseTwsePrice(item.h),
    low: parseTwsePrice(item.l),
    volumeLots: parseInt(item.v, 10) || 0,
    volUnit: '張',
    limitUp: parseTwsePrice(item.u),
    limitDown: parseTwsePrice(item.w),
    time: item['%'] || item.t || '',
    bids, asks, bidVol, askVol,
    source: 'TWSE',
    sourceLabel: kind === 'index'
      ? '加權指數即時（TWSE）'
      : market === 'otc'
        ? '上櫃盤中即時（TWSE）'
        : '上市盤中即時（TWSE）',
  };
}

function parseTaifexQuote(item, prevPrice) {
  const yClose = parseTwsePrice(item.CRefPrice);
  let price = parseTwsePrice(item.CLastPrice);
  if (price == null) {
    const bid = parseTwsePrice(item.CBidPrice1);
    const ask = parseTwsePrice(item.CAskPrice1);
    if (bid != null && ask != null) price = (bid + ask) / 2;
    else price = prevPrice ?? parseTwsePrice(item.COpenPrice) ?? yClose;
  }
  if (price == null || yClose == null) throw new Error('TAIFEX 報價欄位不完整');
  const change = price - yClose;
  const t = String(item.CTime || '').padStart(6, '0');
  const time = /^\d{6}$/.test(t) ? `${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}` : '';
  const sym = String(item.SymbolID || '').replace('-F', '');
  return {
    kind: 'futures',
    code: sym,
    name: `台指期 ${sym}`,
    price,
    yClose,
    change,
    changePct: yClose ? (change / yClose) * 100 : 0,
    open: parseTwsePrice(item.COpenPrice),
    high: parseTwsePrice(item.CHighPrice),
    low: parseTwsePrice(item.CLowPrice),
    volumeLots: parseInt(item.CTotalVolume, 10) || 0,
    volUnit: '口',
    limitUp: parseTwsePrice(item.CCeilPrice),
    limitDown: parseTwsePrice(item.CFloorPrice),
    time,
    bids: [parseTwsePrice(item.CBidPrice1)],
    asks: [parseTwsePrice(item.CAskPrice1)],
    bidVol: [item.CBidSize1 || ''],
    askVol: [item.CAskSize1 || ''],
    source: 'TAIFEX',
    sourceLabel: '台指期即時（TAIFEX）',
  };
}

async function tryFetchJson(urls, timeout) {
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(timeout) });
      if (!r.ok) continue;
      return await r.json();
    } catch (_) { /* next */ }
  }
  return null;
}

function proxyBases(localPath, customKey) {
  const custom = (localStorage.getItem(customKey) || '').trim();
  if (isCloudDeployed()) {
    return [cloudFn(localPath), `/api/${localPath}`, ...(custom ? [custom] : [])];
  }
  const host = getProxyHost();
  return [
    `http://${host}/${localPath}`,
    `http://127.0.0.1:8787/${localPath}`,
    `http://localhost:8787/${localPath}`,
    ...(custom ? [custom] : []),
    cloudFn(localPath),
    `/api/${localPath}`,
  ];
}

async function fetchTwseRealtime(stockId, kind = 'stock', market = 'tse') {
  const prevPrice = state.lastTargetInfo?.realtime?.price ?? null;
  const target =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp` +
    `?ex_ch=${market}_${encodeURIComponent(stockId)}.tw&json=1&delay=0`;

  const proxyUrls = proxyBases('twse', 'twseProxyUrl').map(
    b => `${b}${b.includes('?') ? '&' : '?'}id=${encodeURIComponent(stockId)}&ex=${market}`
  );
  let data = await tryFetchJson(proxyUrls, 9000);

  if (!data?.msgArray) {
    try {
      const r = await fetch(target, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      if (r.ok) data = await r.json();
    } catch (_) { /* next */ }
  }
  if (!data?.msgArray) {
    data = await tryFetchJson([
      `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
      `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(target)}`,
    ], 20000);
  }

  const item = data?.msgArray?.[0];
  if (!item) throw new Error('NO_REALTIME');
  return parseTwseQuote(item, prevPrice, kind, market);
}

async function fetchTaifexRealtime(cid = 'TXF') {
  const prevPrice = state.lastTargetInfo?.realtime?.price ?? null;
  const proxyUrls = proxyBases('taifex', 'taifexProxyUrl').map(
    b => `${b}${b.includes('?') ? '&' : '?'}cid=${encodeURIComponent(cid)}`
  );
  const data = await tryFetchJson(proxyUrls, 12000);
  const arr = data?.RtData?.QuoteList || data?.QuoteList || [];
  const front = arr.find(x => String(x.SymbolID || '').endsWith('-F'));
  if (!front) throw new Error('NO_REALTIME');
  return parseTaifexQuote(front, prevPrice);
}

function stopRealtimePolling() {
  if (state.realtimeTimer) {
    clearInterval(state.realtimeTimer);
    state.realtimeTimer = null;
  }
  state.realtimeKey = null;
  state.realtimeChannel = null;
}

function renderOrderBook(rt) {
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const bid = rt.bids[i];
    const ask = rt.asks[i];
    if (bid == null && ask == null) continue;
    rows.push(`<tr>
      <td class="up">${bid != null ? bid.toLocaleString() : '-'}</td>
      <td style="color:var(--muted);font-size:10px;">${rt.bidVol[i] || ''}</td>
      <td class="down">${ask != null ? ask.toLocaleString() : '-'}</td>
      <td style="color:var(--muted);font-size:10px;">${rt.askVol[i] || ''}</td>
    </tr>`);
  }
  if (!rows.length) return '';
  return `<table style="width:100%;font-size:11px;text-align:center;border-collapse:collapse;margin-top:6px;">
    <thead><tr style="color:var(--muted);font-size:10px;">
      <th colspan="2" style="color:var(--green);padding:2px;">買進</th>
      <th colspan="2" style="color:var(--red);padding:2px;">賣出</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`;
}

async function refreshRealtimeQuote(channel) {
  if (state.realtimeKey !== channel.key || !state.lastTargetInfo) return;
  try {
    const q = await channel.fetch();
    if (state.realtimeKey !== channel.key) return;
    const live = channel.live !== false;
    if (!live) {
      q.sourceLabel = (q.sourceLabel || '').replace('盤中即時', '今日收盤');
    }
    state.currentPrice = q.price;
    const volume = q.kind === 'futures'
      ? q.volumeLots
      : q.kind === 'index'
        ? state.lastTargetInfo.volume
        : q.volumeLots * 1000;
    const merged = {
      ...state.lastTargetInfo,
      price: q.price,
      change: q.change,
      changePct: q.changePct,
      volume,
      name: q.name || state.lastTargetInfo.name,
      source: `${q.source} ${live ? '即時' : '今日收盤'} · ${q.time || getTwTime().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`,
      realtime: q,
    };
    state.lastTargetInfo = merged;
    renderTargetInfo(merged);
    if (volume > 0 && state.lastCloses?.length && state.lastVolumes?.length) {
      state.lastVolumes = state.lastVolumes.slice();
      state.lastVolumes[state.lastVolumes.length - 1] = volume;
      renderVolumeAnalysis(state.lastCloses, state.lastVolumes);
    }
    const entryEl = document.getElementById('step_entryprice');
    if (entryEl) entryEl.value = q.price.toFixed(2);
    setDataStatus('ok', `● ${q.sourceLabel} · ${q.time || '更新中'}`);
  } catch (e) {
    console.warn('realtime', e);
    if (state.realtimeKey !== channel.key) return;
    setDataStatus('err', '● 即時連線失敗 · 顯示日線收盤');
    const warnEl = document.getElementById('realtimeWarn');
    if (warnEl) {
      warnEl.style.display = 'block';
      warnEl.innerHTML = e.message === 'NO_REALTIME'
        ? '⚠️ 無法取得盤中即時報價。右上角若顯示「<strong>即時代理未啟動</strong>」，請雙擊 <code>啟動看板.bat</code> 或執行 <code>python local-proxy.py</code> 後重新整理。<br>' +
          '目前顯示為 FinMind 日線收盤價（可能為昨日）。'
        : '⚠️ 即時報價暫時連線失敗，顯示日線收盤價，將自動重試。';
    }
  }
}

function startRealtimePolling(channel) {
  stopRealtimePolling();
  state.realtimeKey = channel.key;
  state.realtimeChannel = channel;
  const live = channel.live !== false;
  setDataStatus('loading', `● 連線${channel.label}…`);
  refreshRealtimeQuote(channel);
  // 盤中才定時刷新；盤後僅抓一次今日收盤快照
  if (live) {
    state.realtimeTimer = setInterval(() => refreshRealtimeQuote(channel), channel.interval || 20000);
  }
}

function getDateRange(daysBack) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}

function classifySymbol(rawInput) {
  const s = rawInput.trim().toUpperCase();
  if (['^TWII', 'TWII', '加權', 'TAIEX'].includes(s)) return { kind: 'taiex' };
  if (['TX', '台指', '台指期', 'FITX', 'FITX.TW', 'TX00', 'TX00.TW'].includes(s)) return { kind: 'futures', id: 'TX' };
  if (/^\d{4,5}$/.test(s)) return { kind: 'stock', id: s };
  if (s.startsWith('^') || s.endsWith('.TW')) return { kind: 'yahoo', symbol: resolveSymbol(rawInput) };
  return { kind: 'yahoo', symbol: resolveSymbol(rawInput) };
}

async function fetchMarketData(rawInput, onProgress) {
  const kind = classifySymbol(rawInput);
  const range = getDateRange(400);

  if (kind.kind === 'taiex') {
    return fetchFinMindTaiexIndex(onProgress);
  }
  if (kind.kind === 'futures') {
    return fetchFinMindFutures(kind.id, range.start_date, range.end_date);
  }
  if (kind.kind === 'stock') {
    return fetchFinMindStock(kind.id, range.start_date, range.end_date);
  }
  const yahoo = await fetchYahooChart(kind.symbol);
  if (yahoo) return yahoo;
  throw new Error(`無法取得 ${kind.symbol} 的真實行情，請稍後重試`);
}

async function fetchQuote(ySymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=1d&range=5d`;
  return fetchViaProxy(url);
}

async function fetchMultiQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  return fetchViaProxy(url);
}

// =====================================================
// MOVING AVERAGE
// =====================================================
function calcMA(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a,b) => a+b, 0) / period;
}

function calcAllMA(closes) {
  return {
    ma5:   calcMA(closes, 5),
    ma10:  calcMA(closes, 10),
    ma21:  calcMA(closes, 21),
    ma55:  calcMA(closes, 55),
    ma144: calcMA(closes, 144),
    ma233: calcMA(closes, 233),
  };
}

// =====================================================
// TREND DETERMINATION
// =====================================================
function determineTrend(price, ma) {
  if (!price || !ma.ma21 || !ma.ma144) return 'neutral';
  if (price > ma.ma21 && price > ma.ma144) return 'bull';
  if (price < ma.ma144) return 'bear';
  if (price > ma.ma21 && price < ma.ma144) return 'caution';
  return 'neutral';
}

// =====================================================
// FIBONACCI LEVELS
// =====================================================
function calcFib(high, low) {
  const diff = high - low;
  return {
    '0.0%':   { price: high,                label: '高點 (0%)', type: 'resist' },
    '23.6%':  { price: high - diff * 0.236, label: '23.6%', type: 'resist' },
    '38.2%':  { price: high - diff * 0.382, label: '38.2% ⭐', type: 'key' },
    '50.0%':  { price: high - diff * 0.500, label: '50.0%', type: 'mid' },
    '61.8%':  { price: high - diff * 0.618, label: '61.8% ⭐ 黃金', type: 'key' },
    '78.6%':  { price: high - diff * 0.786, label: '78.6%', type: 'support' },
    '100%':   { price: low,                 label: '低點 (100%)', type: 'support' },
    '127.2%': { price: low - diff * 0.272,  label: '127.2% 延伸', type: 'ext' },
    '161.8%': { price: low - diff * 0.618,  label: '161.8% 延伸 ⭐', type: 'ext' },
  };
}

// =====================================================
// ELLIOTT WAVE (simplified pattern detection)
// =====================================================
function detectElliottWave(closes, currentPrice, mas) {
  if (closes.length < 50) return null;
  const recent = closes.slice(-50);
  const trend = determineTrend(currentPrice, mas);

  // Find swing points in recent data
  let swings = [];
  for (let i = 2; i < recent.length-2; i++) {
    if (recent[i] > recent[i-1] && recent[i] > recent[i-2] && recent[i] > recent[i+1] && recent[i] > recent[i+2]) {
      swings.push({ i, price: recent[i], type: 'high' });
    }
    if (recent[i] < recent[i-1] && recent[i] < recent[i-2] && recent[i] < recent[i+1] && recent[i] < recent[i+2]) {
      swings.push({ i, price: recent[i], type: 'low' });
    }
  }

  // Determine wave position based on price vs MA and recent momentum
  const last20 = closes.slice(-20);
  const last5 = closes.slice(-5);
  const momentum20 = (last20[last20.length-1] - last20[0]) / last20[0] * 100;
  const momentum5 = (last5[last5.length-1] - last5[0]) / last5[0] * 100;

  let wavePos, waveDesc, action;

  if (trend === 'bull') {
    if (momentum20 > 5 && momentum5 > 2) {
      wavePos = 3; waveDesc = '推進浪 3 (最強勢浪)'; action = '順勢持倉';
    } else if (momentum20 > 2 && momentum5 < 0) {
      wavePos = 4; waveDesc = '調整浪 4 (回調整理)'; action = '等待回調完成';
    } else if (momentum20 > 0 && momentum5 > 1) {
      wavePos = 5; waveDesc = '推進浪 5 (末升段)'; action = '注意頂背離';
    } else {
      wavePos = 1; waveDesc = '推進浪 1 (初升段)'; action = '輕倉試單';
    }
  } else if (trend === 'bear') {
    if (momentum20 < -5 && momentum5 < -2) {
      wavePos = 'C'; waveDesc = '調整浪 C (最後跌段)'; action = '逢彈做空';
    } else if (momentum20 < -2 && momentum5 > 0) {
      wavePos = 'B'; waveDesc = '調整浪 B (逃命波)'; action = '逢高減多/做空';
    } else {
      wavePos = 'A'; waveDesc = '調整浪 A (首跌段)'; action = '開始減倉';
    }
  } else {
    wavePos = 2; waveDesc = '調整浪 2 (回測支撐)'; action = '等待入場時機';
  }

  return { wavePos, waveDesc, action, momentum20: momentum20.toFixed(1), momentum5: momentum5.toFixed(1), trend };
}

// =====================================================
// HURST CYCLE (赫斯特週期)
// =====================================================
const HURST_NOMINAL = [
  { days: 5, label: '5日', desc: '週線' },
  { days: 10, label: '10日', desc: '雙週' },
  { days: 20, label: '20日', desc: '月線' },
  { days: 40, label: '40日', desc: '雙月' },
  { days: 80, label: '80日', desc: '季線' },
];

function calcMASeries(arr, period) {
  const out = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += arr[j];
    out[i] = sum / period;
  }
  return out;
}

function hurstAutocorr(series, lag) {
  const segLen = Math.min(series.length, lag * 6);
  if (segLen < lag + 8) return 0;
  const use = series.slice(-segLen);
  const mean = use.reduce((a, b) => a + b, 0) / use.length;
  let num = 0, d1 = 0, d2 = 0;
  const len = use.length - lag;
  for (let i = 0; i < len; i++) {
    const x = use[i] - mean;
    const y = use[i + lag] - mean;
    num += x * y;
    d1 += x * x;
    d2 += y * y;
  }
  const den = Math.sqrt(d1 * d2);
  return den ? num / den : 0;
}

function hurstFindSwings(series, halfWindow) {
  const w = Math.max(2, halfWindow);
  const swings = [];
  for (let i = w; i < series.length - w; i++) {
    let hi = true, lo = true;
    for (let k = 1; k <= w; k++) {
      if (series[i] <= series[i - k] || series[i] <= series[i + k]) hi = false;
      if (series[i] >= series[i - k] || series[i] >= series[i + k]) lo = false;
    }
    if (hi) swings.push({ i, type: 'peak' });
    if (lo) swings.push({ i, type: 'trough' });
  }
  return swings;
}

function hurstPhaseLabel(pct) {
  if (pct < 12.5 || pct >= 87.5) {
    return { label: '谷底區', cls: 'bull', action: '週期低點區，留意築底反彈' };
  }
  if (pct < 37.5) return { label: '上升段', cls: 'bull', action: '週期上升，偏多操作' };
  if (pct < 62.5) return { label: '峰頂區', cls: 'bear', action: '週期高點區，留意回檔' };
  return { label: '下降段', cls: 'bear', action: '週期下降，偏空或觀望' };
}

function addTradingDays(baseMs, days) {
  const d = new Date(baseMs);
  let left = Math.max(0, Math.round(days));
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d;
}

function fmtCycleDate(ms) {
  return new Date(ms).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' });
}

function analyzeHurstCycles(closes, timestamps) {
  if (!closes || closes.length < 40) return null;

  const detrendPeriod = Math.min(80, Math.floor(closes.length / 2));
  const ma = calcMASeries(closes, detrendPeriod);
  const detrended = closes.map((c, i) => (ma[i] != null ? c - ma[i] : 0));
  const startIdx = detrendPeriod - 1;
  const dt = detrended.slice(startIdx);
  const lastIdx = closes.length - 1;
  const lastTs = timestamps?.[lastIdx] ? timestamps[lastIdx] * 1000 : Date.now();

  const cycles = HURST_NOMINAL.filter(c => c.days * 3 <= dt.length).map(c => {
    const strength = hurstAutocorr(dt, c.days);
    const swings = hurstFindSwings(dt, Math.max(2, Math.floor(c.days / 5)));
    const lastTrough = [...swings].reverse().find(s => s.type === 'trough');

    let daysSinceTrough = Math.round(c.days / 2);
    if (lastTrough) {
      daysSinceTrough = lastIdx - (startIdx + lastTrough.i);
    }
    const pos = ((daysSinceTrough % c.days) + c.days) % c.days;
    const phasePct = (pos / c.days) * 100;
    const half = c.days / 2;
    const phase = hurstPhaseLabel(phasePct);

    let daysToPeak, daysToTrough;
    if (pos < half) {
      daysToPeak = Math.round(half - pos);
      daysToTrough = Math.round(c.days - pos);
    } else {
      daysToTrough = Math.round(c.days - pos);
      daysToPeak = Math.round(half + (half - (pos - half)));
    }

    return {
      ...c,
      strength,
      phasePct,
      phase,
      daysToPeak,
      daysToTrough,
      nextPeak: fmtCycleDate(addTradingDays(lastTs, daysToPeak).getTime()),
      nextTrough: fmtCycleDate(addTradingDays(lastTs, daysToTrough).getTime()),
    };
  }).sort((a, b) => b.strength - a.strength);

  if (!cycles.length) return null;

  const primary = cycles[0];
  const troughZoneCount = cycles.filter(c => c.phase.label === '谷底區').length;
  const peakZoneCount = cycles.filter(c => c.phase.label === '峰頂區').length;
  let syncNote = '';
  if (troughZoneCount >= 2) {
    syncNote = `${troughZoneCount} 個週期同步於谷底區 — 赫斯特同步律：可能見底反彈`;
  } else if (peakZoneCount >= 2) {
    syncNote = `${peakZoneCount} 個週期同步於峰頂區 — 可能見高回落`;
  }

  const top3 = cycles.slice(0, 3);
  const compositePct = top3.reduce((s, c) => s + c.phasePct, 0) / top3.length;
  const compositePhase = hurstPhaseLabel(compositePct);

  return { cycles, primary, syncNote, compositePhase, compositePct, dataBars: closes.length };
}

function renderHurstCycles(hurst) {
  const el = document.getElementById('hurstCycles');
  if (!el) return;
  if (!hurst) {
    el.innerHTML = '<div class="loading">數據不足（需至少 40 根 K 線）</div>';
    return;
  }

  const p = hurst.primary;
  const phaseColor = p.phase.cls === 'bull' ? 'var(--green)' : p.phase.cls === 'bear' ? 'var(--red)' : 'var(--gold)';

  el.innerHTML = `
    <div class="signal-row" style="margin-bottom:10px;">
      <span class="trend-badge ${p.phase.cls}" style="font-size:13px;">
        主週期 <strong>${p.label}</strong> · ${p.phase.label}
      </span>
      <span class="signal-pill sideways">強度 ${(p.strength * 100).toFixed(0)}%</span>
    </div>
    <div class="stat-card" style="margin-bottom:10px;border-color:var(--gold);">
      <div class="stat-label">週期相位 · ${p.desc}（${p.days} 交易日）</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:6px 0;">
        <span class="stat-value" style="font-size:26px;color:${phaseColor};">${p.phasePct.toFixed(0)}%</span>
        <span style="font-size:11px;color:var(--muted);">0% 谷底 → 50% 峰頂 → 100% 谷底</span>
      </div>
      <div class="progress-wrap" style="height:12px;">
        <div class="progress-bar" style="width:${Math.min(100, p.phasePct)}%;background:${phaseColor};"></div>
      </div>
      <div style="font-size:12px;color:var(--accent);margin-top:8px;">${p.phase.action}</div>
    </div>
    <div class="grid-2" style="gap:8px;margin-bottom:10px;">
      <div class="stat-card">
        <div class="stat-label">預估下一峰頂</div>
        <div class="stat-value up" style="font-size:16px;">${p.nextPeak}</div>
        <div class="stat-sub" style="color:var(--muted);">約 ${p.daysToPeak} 個交易日</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">預估下一谷底</div>
        <div class="stat-value down" style="font-size:16px;">${p.nextTrough}</div>
        <div class="stat-sub" style="color:var(--muted);">約 ${p.daysToTrough} 個交易日</div>
      </div>
    </div>
    ${hurst.syncNote ? `<div class="stat-card" style="margin-bottom:10px;border-color:var(--accent);">
      <div class="stat-label">赫斯特同步律</div>
      <div style="font-size:12px;color:var(--accent);">${hurst.syncNote}</div>
    </div>` : ''}
    <div class="stat-card">
      <div class="stat-label">綜合相位（前 3 強週期平均 · ${hurst.compositePhase.label}）</div>
      <div class="progress-wrap" style="height:8px;margin-top:6px;">
        <div class="progress-bar" style="width:${hurst.compositePct.toFixed(0)}%;background:${hurst.compositePhase.cls === 'bull' ? 'var(--green)' : 'var(--red)'};"></div>
      </div>
    </div>
    <div style="margin-top:10px;overflow-x:auto;">
      <table class="fib-table" style="min-width:100%;">
        <thead>
          <tr>
            <th>週期</th><th>強度</th><th>相位</th><th>階段</th><th>下一峰</th><th>下一谷</th>
          </tr>
        </thead>
        <tbody>
          ${hurst.cycles.map(c => `
          <tr>
            <td class="gold">${c.label}<span style="color:var(--muted);font-size:9px;"> ${c.desc}</span></td>
            <td>${(c.strength * 100).toFixed(0)}%</td>
            <td>${c.phasePct.toFixed(0)}%</td>
            <td><span class="signal-pill ${c.phase.cls}" style="font-size:9px;padding:2px 6px;">${c.phase.label}</span></td>
            <td style="font-size:10px;">${c.nextPeak}</td>
            <td style="font-size:10px;">${c.nextTrough}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="search-meta">JM Hurst 週期分析 · 去趨勢後自相關 + 嵌套週期（5→10→20→40→80 日）· 依 ${hurst.dataBars} 根 K 線</div>
  `;
}

// =====================================================
// KELLY FORMULA
// =====================================================
function calcKelly() {
  const capEl = document.getElementById('totalCapital');
  if (!capEl) return null;

  const capital = parseFloat(capEl.value) || 1000000;
  const w = (parseFloat(document.getElementById('winRate')?.value) || 55) / 100;
  const r = parseFloat(document.getElementById('profitRatio')?.value) || 2;
  const maxRiskPct = parseFloat(document.getElementById('maxRisk')?.value) || 2;

  const f = (w * r - (1 - w)) / r; // Kelly fraction
  const halfKelly = f / 2;
  const adjKelly = Math.min(halfKelly, maxRiskPct / 100);
  const positionSize = capital * adjKelly;
  const expectedValue = (w * r - (1 - w)) * 100;

  const pct = (adjKelly * 100).toFixed(1);
  const kellyPct = document.getElementById('kellyPct');
  const kellyDetail = document.getElementById('kellyDetail');
  const breakdown = document.getElementById('kellyBreakdown');
  if (kellyPct) kellyPct.textContent = pct + '%';
  if (kellyDetail) {
    kellyDetail.textContent = `建議倉位比例 (半凱利+限制 ${maxRiskPct}%)`;
  }
  if (breakdown) {
    breakdown.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">期望值 EV</div>
      <div class="stat-value ${expectedValue > 0 ? 'up' : 'down'}">${expectedValue.toFixed(1)}%</div>
      <div class="stat-sub" style="color:var(--muted)">每筆平均</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">建議投入金額</div>
      <div class="stat-value gold">NT$ ${positionSize.toLocaleString('zh-TW', {maximumFractionDigits:0})}</div>
      <div class="stat-sub up">佔總資金 ${pct}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">全凱利 / 半凱利</div>
      <div class="stat-value neutral">${(f*100).toFixed(1)}% / ${(halfKelly*100).toFixed(1)}%</div>
      <div class="stat-sub" style="color:var(--muted)">全/半 Kelly</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">最大風險金額</div>
      <div class="stat-value down">NT$ ${(capital * maxRiskPct/100).toLocaleString('zh-TW', {maximumFractionDigits:0})}</div>
      <div class="stat-sub" style="color:var(--muted)">每筆最大虧損上限</div>
    </div>
  `;
  }
  return { positionSize, adjKelly, capital };
}

// =====================================================
// RENDER STEPS
// =====================================================
const STEPS = [
  { n:1,  title:'固定進場條件',  id:'step_entry',      type:'select', options:['趨勢突破', '均線支撐', '波浪回調', '費波那契支撐', '型態突破', '均線黃金交叉'] },
  { n:2,  title:'確定趨勢方向', id:'step_trend',      type:'select', options:['多頭 (Bullish)', '空頭 (Bearish)', '盤整 (Sideways)', '觀望'] },
  { n:3,  title:'預期利潤目標', id:'step_target',     type:'number', placeholder:'目標價格 (e.g. 950)' },
  { n:4,  title:'止損幅度設定', id:'step_stoploss',   type:'number', placeholder:'止損價格 (e.g. 850)' },
  { n:5,  title:'調整槓桿倍數', id:'step_leverage',   type:'select', options:['1x 現股', '1.5x', '2x', '3x', '5x', '10x'] },
  { n:6,  title:'開單進場價',   id:'step_entryprice', type:'number', placeholder:'進場價格 (e.g. 880)' },
  { n:7,  title:'止盈利潤比',   id:'step_rr',         type:'calc',   placeholder:'自動計算 R:R' },
  { n:8,  title:'平價保護設定', id:'step_breakeven',  type:'calc',   placeholder:'自動計算平保點' },
  { n:9,  title:'交易筆記',     id:'step_note',       type:'textarea', placeholder:'進場理由、市場背景...' },
  { n:10, title:'復盤交易',     id:'step_replay',     type:'textarea', placeholder:'結果、心得、改進...' },
];

function renderSteps() {
  const grid = document.getElementById('stepsGrid');
  if (!grid) return;
  grid.innerHTML = STEPS.map(s => {
    let inputHtml;
    if (s.type === 'select') {
      inputHtml = `<select class="step-input" id="${s.id}" onchange="calcAllSteps()">
        ${s.options.map(o => `<option>${o}</option>`).join('')}
      </select>`;
    } else if (s.type === 'textarea') {
      inputHtml = `<textarea class="step-input" id="${s.id}" rows="2" placeholder="${s.placeholder}" style="resize:vertical;"></textarea>`;
    } else if (s.type === 'calc') {
      inputHtml = `<div class="step-display neutral" id="${s.id}">-</div>`;
    } else {
      inputHtml = `<input class="step-input" type="number" id="${s.id}" placeholder="${s.placeholder}" onchange="calcAllSteps()" onkeyup="calcAllSteps()">`;
    }
    return `
      <div class="step-item">
        <div class="step-num" id="stepNum${s.n}">${s.n}</div>
        <div class="step-content">
          <div class="step-title">STEP ${s.n} · ${s.title}</div>
          ${inputHtml}
        </div>
      </div>`;
  }).join('');
}

function calcAllSteps() {
  const entry = parseFloat(document.getElementById('step_entryprice')?.value);
  const stop  = parseFloat(document.getElementById('step_stoploss')?.value);
  const target= parseFloat(document.getElementById('step_target')?.value);

  // Step 7: R:R Ratio
  if (entry && stop && target) {
    const risk   = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    const rr     = reward / risk;
    const dir    = target > entry ? '多' : '空';
    const rrEl = document.getElementById('step_rr');
    if (rrEl) {
      rrEl.innerHTML = `<span class="${rr >= 2 ? 'up' : rr >= 1 ? 'gold' : 'down'}">
        ${dir} | R:R = 1:${rr.toFixed(2)}
        ${rr >= 2 ? ' ✅ 良好' : rr >= 1 ? ' ⚠️ 尚可' : ' ❌ 不足'}
      </span>`;
      const sn7 = document.getElementById('stepNum7');
      if (sn7) sn7.className = 'step-num ' + (rr >= 2 ? 'done' : rr >= 1 ? 'warn' : '');
    }

    // Step 8: Breakeven
    const beEl = document.getElementById('step_breakeven');
    if (beEl) {
      const capitalData = calcKelly();
      const feeRate = 0.001425 + 0.003; // 手續費+交易稅 (股票)
      const breakeven = entry * (1 + feeRate);
      beEl.innerHTML = `<span class="gold">平保點: ${breakeven.toFixed(1)}
        | 風險: ${risk.toFixed(1)} (${(risk/entry*100).toFixed(1)}%)
        | 報酬: ${reward.toFixed(1)} (${(reward/entry*100).toFixed(1)})%
      </span>`;
      const sn8 = document.getElementById('stepNum8');
      if (sn8) sn8.className = 'step-num done';
    }
  }

  // Mark completed steps
  [1,2,3,4,5,6].forEach(n => {
    const id = STEPS[n-1].id;
    const el = document.getElementById(id);
    if (el && (el.value || el.textContent !== '-')) {
      const numEl = document.getElementById('stepNum' + n);
      if (numEl) numEl.className = 'step-num done';
    }
  });
}

// =====================================================
// RENDER MARKET OVERVIEW
// =====================================================
// VIX 依絕對水準分級（非多頭/空頭）；數值越低越平靜
function vixLevel(v) {
  if (v < 15) return { label: '正常', pillClass: 'bull', valueClass: 'up' };
  if (v < 20) return { label: '微不穩', pillClass: 'sideways', valueClass: 'gold' };
  if (v < 30) return { label: '不穩定', pillClass: 'warn', valueClass: 'gold' };
  return { label: '極度恐慌', pillClass: 'bear', valueClass: 'down' };
}

function vixLevelPill(level) {
  if (level.pillClass === 'warn') {
    return `<span class="signal-pill" style="background:rgba(255,149,0,.15);border:1px solid #ff9500;color:#ff9500;">${level.label}</span>`;
  }
  return `<span class="signal-pill ${level.pillClass}">${level.label}</span>`;
}

function renderMarketOverview(markets) {
  const el = document.getElementById('marketOverview');
  if (!el) return;
  if (!el.className.includes('grid')) el.className = 'grid-4';
  el.innerHTML = markets.map(m => {
    if (m.failed) {
      return `
    <div class="stat-card">
      <div class="stat-label">${m.name}</div>
      <div class="stat-value neutral">${m.price}</div>
      <div class="stat-sub" style="color:var(--muted)">${m.hint || '暫無數據'}</div>
    </div>`;
    }
    if (m.isVix) {
      const fearEasing = m.change <= 0;
      return `
    <div class="stat-card">
      <div class="stat-label">${m.name}</div>
      <div class="stat-value ${m.vixValueClass}">${m.price}</div>
      <div class="stat-sub ${fearEasing ? 'up' : 'down'}">
        ${m.change >= 0 ? '▲' : '▼'} ${Math.abs(m.change).toFixed(2)} (${Math.abs(m.changePct).toFixed(2)}%) · ${fearEasing ? '恐慌降' : '恐慌升'}
      </div>
      <div class="signal-row" style="margin-top:6px;">
        ${vixLevelPill(m.vixMeta)}
      </div>
    </div>`;
    }
    return `
    <div class="stat-card">
      <div class="stat-label">${m.name}</div>
      <div class="stat-value ${m.change >= 0 ? 'up' : 'down'}">${m.price}</div>
      <div class="stat-sub ${m.change >= 0 ? 'up' : 'down'}">
        ${m.change >= 0 ? '▲' : '▼'} ${Math.abs(m.change).toFixed(2)} (${m.changePct.toFixed(2)}%)
      </div>
      <div class="signal-row" style="margin-top:6px;">
        <span class="signal-pill ${m.trend === 'bull' ? 'bull' : m.trend === 'bear' ? 'bear' : 'sideways'}">
          ${m.trend === 'bull' ? '多頭' : m.trend === 'bear' ? '空頭' : '盤整'}
        </span>
        ${m.above21ma ? '<span class="signal-pill bull">MA21↑</span>' : '<span class="signal-pill bear">MA21↓</span>'}
      </div>
    </div>`;
  }).join('');
}

// =====================================================
// RENDER TARGET INFO
// =====================================================
function renderTargetInfo(info) {
  document.getElementById('targetSymbolTitle').textContent = info.name || info.symbol;
  document.getElementById('symbolBadge').textContent = info.symbol;

  const rt = info.realtime;
  const volLabel = rt
    ? (rt.kind === 'index' ? '—' : `${rt.volumeLots.toLocaleString()} ${rt.volUnit || '張'}`)
    : fmtVol(info.volume);

  const realtimeHtml = rt ? `
    <div style="margin-top:10px;padding:10px;background:#0a1628;border:1px solid var(--green);border-radius:6px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:11px;color:var(--green);font-weight:600;">● ${rt.sourceLabel || '盤中即時'}</span>
        <span style="font-size:10px;color:var(--muted);">${rt.time || ''}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:4px;font-size:11px;">
        <div><span style="color:var(--muted);">開 </span>${rt.open?.toLocaleString() ?? '-'}</div>
        <div><span style="color:var(--muted);">高 </span><span class="up">${rt.high?.toLocaleString() ?? '-'}</span></div>
        <div><span style="color:var(--muted);">低 </span><span class="down">${rt.low?.toLocaleString() ?? '-'}</span></div>
        <div><span style="color:var(--muted);">昨收 </span>${rt.yClose?.toLocaleString() ?? '-'}</div>
      </div>
      <div style="display:flex;gap:12px;font-size:10px;color:var(--muted);margin-bottom:4px;">
        ${rt.limitUp != null ? `<span>漲停 <span class="up">${rt.limitUp.toLocaleString()}</span></span>` : ''}
        ${rt.limitDown != null ? `<span>跌停 <span class="down">${rt.limitDown.toLocaleString()}</span></span>` : ''}
      </div>
      ${renderOrderBook(rt)}
    </div>
  ` : '';

  document.getElementById('targetInfo').innerHTML = `
    <div class="grid-2" style="gap:8px;margin-bottom:10px;">
      <div class="stat-card">
        <div class="stat-label">${rt ? '現價（即時）' : '現價'}</div>
        <div class="stat-value ${info.change >= 0 ? 'up' : 'down'}" style="font-size:28px;">${info.price.toLocaleString()}</div>
        <div class="stat-sub ${info.change >= 0 ? 'up' : 'down'}">
          ${info.change >= 0 ? '▲' : '▼'} ${Math.abs(info.change).toFixed(2)} (${info.changePct.toFixed(2)}%)
        </div>
      </div>
      <div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div class="stat-card"><div class="stat-label">52W 高</div><div class="stat-value up" style="font-size:14px;">${info.high52.toLocaleString()}</div></div>
          <div class="stat-card"><div class="stat-label">52W 低</div><div class="stat-value down" style="font-size:14px;">${info.low52.toLocaleString()}</div></div>
          <div class="stat-card"><div class="stat-label">成交量</div><div class="stat-value neutral" style="font-size:14px;">${volLabel}</div></div>
          <div class="stat-card"><div class="stat-label">市值</div><div class="stat-value gold" style="font-size:14px;">${fmtVol(info.marketCap)}</div></div>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${[['MA21', info.ma21, info.price > info.ma21],
         ['MA55', info.ma55, info.price > info.ma55],
         ['MA144', info.ma144, info.price > info.ma144],
         ['MA233', info.ma233, info.price > info.ma233]].map(([label, val, above]) => val ? `
        <div style="flex:1;min-width:80px;" class="stat-card">
          <div class="stat-label">${label}</div>
          <div class="stat-value ${above ? 'up' : 'down'}" style="font-size:14px;">${val.toLocaleString(undefined,{maximumFractionDigits:1})}</div>
          <div style="font-size:10px;color:var(--muted);">${above ? '▲ 上方' : '▼ 下方'}</div>
        </div>` : '').join('')}
    </div>
    ${realtimeHtml}
    <div id="realtimeWarn" style="display:none;margin-top:8px;padding:8px 10px;background:rgba(255,149,0,.1);border:1px solid var(--orange);border-radius:6px;font-size:11px;color:var(--orange);line-height:1.6;"></div>
    ${info.source ? `<div style="margin-top:8px;font-size:10px;color:var(--green);">● 真實數據來源：${info.source}</div>` : ''}
  `;
}

// =====================================================
// 量價關係分析（9 種組合）
// =====================================================
// 依「當日收盤 vs 前一日」與「當日量 vs 前一日量」分類。
// 門檻：價 / 量變動幅度在 ±0.3% / ±10% 內視為「平」。
const PV_ADVICE = {
  '價漲量增': { tag: 'bull',     signal: '健康上漲', desc: '買盤積極、量價齊揚，趨勢有量能支撐，最強多方訊號。', action: '偏多操作，順勢續抱或拉回找買點。' },
  '價漲量縮': { tag: 'caution',  signal: '背離警訊', desc: '上漲但量能萎縮，追價意願不足，漲勢動能轉弱。', action: '審慎追高，留意假突破與轉折，設好停利。' },
  '價漲量平': { tag: 'neutral',  signal: '溫和推升', desc: '價漲量持平，動能中性，需後續量能確認。', action: '中性偏多，等量能放大再加碼。' },
  '價跌量增': { tag: 'bear',     signal: '賣壓沉重', desc: '放量下跌、恐慌殺盤，短線弱勢，最強空方訊號。', action: '偏空或觀望，勿接刀，等量縮止跌。' },
  '價跌量縮': { tag: 'caution',  signal: '跌勢趨緩', desc: '下跌但量縮，殺盤力道減弱，可能接近止跌。', action: '觀望為主，等出量止穩訊號再進場。' },
  '價跌量平': { tag: 'neutral',  signal: '弱勢整理', desc: '價跌量持平，賣壓仍在但未擴大，方向未明。', action: '中性偏空，破前低減碼，守住則觀望。' },
  '價平量增': { tag: 'caution',  signal: '變盤前兆', desc: '價平量增，多空激烈換手，常為變盤或轉折前兆。', action: '留意突破方向，順突破方向操作。' },
  '價平量平': { tag: 'neutral',  signal: '盤整休息', desc: '量價俱平，市場觀望、缺乏方向，區間整理。', action: '觀望等待，區間高空低多或空手。' },
  '價平量縮': { tag: 'neutral',  signal: '量能萎縮', desc: '價平量縮，市場冷清、參與意願低，續整理。', action: '空手觀望，等量能重新聚集。' },
};

function classifyPriceVolume(prevClose, close, prevVol, vol) {
  if (prevClose == null || close == null || !prevVol || !vol) return null;
  const pPct = (close - prevClose) / prevClose * 100;
  const vPct = (vol - prevVol) / prevVol * 100;
  const priceDir = pPct > 0.3 ? '價漲' : pPct < -0.3 ? '價跌' : '價平';
  const volDir = vPct > 10 ? '量增' : vPct < -10 ? '量縮' : '量平';
  const key = priceDir + volDir;
  return { key, pPct, vPct, priceDir, volDir, ...PV_ADVICE[key] };
}

function summarize5DayPV(items) {
  // items: 由舊到新的量價分類（最多 5 筆）
  const valid = items.filter(Boolean);
  if (!valid.length) return { text: '資料不足', tag: 'neutral' };
  let bull = 0, bear = 0;
  valid.forEach(it => {
    if (it.tag === 'bull') bull += 2;
    else if (it.tag === 'bear') bear += 2;
    else if (it.tag === 'caution') { if (it.priceDir === '價漲') bear += 1; else if (it.priceDir === '價跌') bull += 1; }
  });
  const net = bull - bear;
  const priceUp = valid.filter(i => i.priceDir === '價漲').length;
  const volUp = valid.filter(i => i.volDir === '量增').length;

  let tag, text;
  if (net >= 3) { tag = 'bull'; text = `近 5 日量價偏多（量能support漲勢）`; }
  else if (net <= -3) { tag = 'bear'; text = `近 5 日量價偏空（賣壓為主）`; }
  else { tag = 'neutral'; text = `近 5 日量價中性、方向未明`; }

  let advice;
  if (tag === 'bull') advice = priceUp >= 3 && volUp >= 3 ? '量價齊揚，趨勢健康，回檔可偏多布局。' : '偏多但量能不夠一致，順勢為主、控管風險。';
  else if (tag === 'bear') advice = '賣方主導，反彈偏空看待，等量縮止跌再論多。';
  else advice = '多空拉鋸、量能分歧，宜觀望或區間操作，待方向明確。';
  return { text: text.replace('support', ' 支撐 '), tag, advice, priceUp, volUp, count: valid.length };
}

function renderVolumeAnalysis(closes, volumes) {
  const el = document.getElementById('volumeAnalysis');
  if (!el) return;
  const hasVol = Array.isArray(volumes) && volumes.some(v => v > 0);
  if (!closes || closes.length < 6 || !hasVol) {
    const sym = (state.symbol || '').toUpperCase();
    const isIndex = ['^TWII', 'TWII', '加權', 'TAIEX'].includes(sym);
    const noToken = !getFinMindToken();
    let hint = '資料不足，無法進行量價分析。';
    if (noToken) hint = '請先在設定填入 FinMind Token（免費註冊），個股與加權大盤量價皆需此 Token。';
    else if (isIndex) hint = '加權指數大盤成交量載入中或 FinMind 暫無資料，請重新載入或稍後再試。';
    el.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px;">${hint}</div>`;
    return;
  }

  const n = closes.length;
  const today = classifyPriceVolume(closes[n-2], closes[n-1], volumes[n-2], volumes[n-1]);

  // 最近 5 個交易日（每日 vs 前一日）
  const seq = [];
  for (let i = Math.max(1, n - 5); i < n; i++) {
    seq.push({ i, pv: classifyPriceVolume(closes[i-1], closes[i], volumes[i-1], volumes[i]) });
  }
  const summary = summarize5DayPV(seq.map(s => s.pv));

  const pill = (tag) => tag === 'bull' ? 'bull' : tag === 'bear' ? 'bear' : 'sideways';
  const todayHtml = today ? `
    <div class="stat-card" style="border-color:var(--${today.tag==='bull'?'green':today.tag==='bear'?'red':'gold'});">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span class="trend-badge ${pill(today.tag)}" style="font-size:13px;">${today.key}</span>
        <span class="gold" style="font-size:12px;">${today.signal}</span>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">
        價 ${today.pPct>=0?'+':''}${today.pPct.toFixed(2)}% · 量 ${today.vPct>=0?'+':''}${today.vPct.toFixed(1)}%
      </div>
      <div style="font-size:12px;line-height:1.6;">${today.desc}</div>
      <div style="font-size:12px;line-height:1.6;margin-top:6px;color:var(--accent);">➤ 建議：${today.action}</div>
    </div>` : '<div style="color:var(--muted);font-size:12px;">當日量價資料不足。</div>';

  const seqHtml = seq.map(s => {
    const pv = s.pv;
    if (!pv) return '';
    const c = pv.tag==='bull'?'up':pv.tag==='bear'?'down':'gold';
    return `<div style="flex:1;min-width:62px;text-align:center;" class="stat-card">
      <div style="font-size:10px;color:var(--muted);">D-${n-1-s.i}</div>
      <div class="${c}" style="font-size:11px;font-weight:bold;margin:2px 0;">${pv.key}</div>
      <div style="font-size:9px;color:var(--muted);">${pv.pPct>=0?'+':''}${pv.pPct.toFixed(1)}%｜量${pv.vPct>=0?'+':''}${pv.vPct.toFixed(0)}%</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">當日判定</div>
    ${todayHtml}
    <div style="font-size:11px;color:var(--muted);margin:12px 0 6px;">連續 5 日量價序列（D-0 為最新）</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">${seqHtml}</div>
    <div class="stat-card" style="margin-top:10px;border-color:var(--${summary.tag==='bull'?'green':summary.tag==='bear'?'red':'gold'});">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span class="trend-badge ${pill(summary.tag)}">5 日綜合</span>
        <span style="font-size:12px;">${summary.text}</span>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">5 日內：價漲 ${summary.priceUp||0} 日 · 量增 ${summary.volUp||0} 日</div>
      <div style="font-size:12px;line-height:1.6;color:var(--accent);">➤ 建議：${summary.advice||'-'}</div>
    </div>
    <div style="font-size:10px;color:var(--muted);margin-top:8px;">
      判定門檻：價 ±0.3%、量 ±10% 內視為「平」。量價分析為輔助，非投資建議。
    </div>
  `;
}

// =====================================================
// RENDER TREND SYSTEM
// =====================================================
function renderTrendSystem(price, mas, symbol) {
  const isTwStock = symbol.endsWith('.TW') || symbol === '^TWII';
  const trend = determineTrend(price, mas);
  const trendLabel = { bull:'多頭', bear:'空頭', caution:'觀望', neutral:'盤整' }[trend];
  const trendClass = { bull:'bull', bear:'bear', caution:'sideways', neutral:'sideways' }[trend];

  // Score
  let score = 0;
  if (mas.ma5 && price > mas.ma5) score++;
  if (mas.ma10 && price > mas.ma10) score++;
  if (mas.ma21 && price > mas.ma21) score += 2;
  if (mas.ma55 && price > mas.ma55) score++;
  if (mas.ma144 && price > mas.ma144) score += 3;
  if (mas.ma233 && price > mas.ma233) score++;
  const maxScore = 9;
  const scorePct = (score / maxScore * 100).toFixed(0);

  document.getElementById('trendSystem').innerHTML = `
    <div style="text-align:center;margin-bottom:12px;">
      <span class="trend-badge ${trendClass}" style="font-size:16px;padding:6px 20px;">
        ${trend === 'bull' ? '▲' : trend === 'bear' ? '▼' : '◆'} ${trendLabel}
      </span>
      ${isTwStock ? `<div style="font-size:10px;color:var(--muted);margin-top:6px;">
        台股判斷: ${mas.ma21 && price > mas.ma21 ? '✅ 21MA以上多頭' : '❌ 21MA以下'}
        ${mas.ma144 && price < mas.ma144 ? ' | ⚠️ 破144MA空頭' : ''}
      </div>` : ''}
    </div>
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="color:var(--muted);font-size:11px;">多頭強度評分</span>
        <span class="${parseInt(scorePct) > 60 ? 'up' : parseInt(scorePct) > 40 ? 'gold' : 'down'}">${score}/${maxScore} (${scorePct}%)</span>
      </div>
      <div class="progress-wrap">
        <div class="progress-bar" style="width:${scorePct}%;background:${parseInt(scorePct) > 60 ? 'var(--green)' : parseInt(scorePct) > 40 ? 'var(--gold)' : 'var(--red)'};"></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;">
      ${[
        ['價格 vs MA21', mas.ma21, price > (mas.ma21||0), '主要趨勢'],
        ['價格 vs MA55', mas.ma55, price > (mas.ma55||0), '中期趨勢'],
        ['價格 vs MA144', mas.ma144, price > (mas.ma144||0), '長期趨勢'],
        ['價格 vs MA233', mas.ma233, price > (mas.ma233||0), '超長趨勢'],
      ].map(([label, val, above, sub]) => val ? `
        <div style="background:#0d1526;border-radius:4px;padding:6px 8px;border:1px solid ${above ? 'rgba(0,255,136,.3)' : 'rgba(255,68,102,.3)'};">
          <div style="color:var(--muted);">${sub}</div>
          <div class="${above ? 'up' : 'down'}">${above ? '▲' : '▼'} ${label.split(' vs ')[1]}</div>
          <div style="color:var(--muted);font-size:10px;">${val.toFixed(1)}</div>
        </div>` : '').join('')}
    </div>
  `;
}

// =====================================================
// RENDER ELLIOTT WAVE
// =====================================================
function renderElliottWave(wave) {
  if (!wave) { document.getElementById('elliottWave').innerHTML = '<div class="loading">數據不足</div>'; return; }

  const waveColors = { 1:'up', 2:'gold', 3:'up', 4:'gold', 5:'purple', A:'down', B:'gold', C:'down' };
  const allWaves = ['1','2','3','4','5','A','B','C'];

  document.getElementById('elliottWave').innerHTML = `
    <div class="signal-row" style="margin-bottom:10px;">
      <span class="trend-badge ${wave.trend === 'bull' ? 'bull' : wave.trend === 'bear' ? 'bear' : 'sideways'}" style="font-size:13px;">
        當前浪位: <strong>浪 ${wave.wavePos}</strong>
      </span>
    </div>
    <div class="stat-card" style="margin-bottom:10px;border-color:var(--gold);">
      <div class="stat-label">浪型描述</div>
      <div style="font-size:14px;color:var(--gold);margin:4px 0;">${wave.waveDesc}</div>
      <div style="color:var(--accent);font-size:12px;">建議操作：${wave.action}</div>
    </div>
    <div class="wave-grid">
      ${allWaves.slice(0,5).map(w => `
        <div class="wave-card" style="${String(wave.wavePos) === w ? 'border-color:var(--gold);' : ''}">
          <div class="wave-num ${String(wave.wavePos) === w ? 'gold' : ''}">${w}</div>
          <div class="wave-type ${waveColors[w] || 'neutral'}">
            ${['1','3','5'].includes(w) ? '推進' : '調整'}
          </div>
          ${String(wave.wavePos) === w ? '<div style="color:var(--gold);font-size:9px;margin-top:2px;">◀ 現在</div>' : ''}
        </div>
      `).join('')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;font-size:11px;">
      <div class="stat-card"><div class="stat-label">20日動能</div>
        <div class="${parseFloat(wave.momentum20) > 0 ? 'up' : 'down'}">${wave.momentum20 > 0 ? '+' : ''}${wave.momentum20}%</div>
      </div>
      <div class="stat-card"><div class="stat-label">5日動能</div>
        <div class="${parseFloat(wave.momentum5) > 0 ? 'up' : 'down'}">${wave.momentum5 > 0 ? '+' : ''}${wave.momentum5}%</div>
      </div>
    </div>
  `;
}

// =====================================================
// RENDER FIBONACCI
// =====================================================
function renderFib(fibs, currentPrice, high, low) {
  state.fibLevels = fibs;
  const entries = Object.entries(fibs).reverse();
  document.getElementById('fibLevels').innerHTML = `
    <div style="font-size:10px;color:var(--muted);margin-bottom:8px;">
      基準: 高 ${high.toLocaleString()} → 低 ${low.toLocaleString()} | 現價: ${currentPrice.toLocaleString()}
    </div>
    <table class="fib-table">
      <thead><tr><th>比例</th><th>價格</th><th>距現價</th><th>意義</th></tr></thead>
      <tbody>
        ${entries.map(([pct, data]) => {
          const diff = ((data.price - currentPrice) / currentPrice * 100);
          const isNear = Math.abs(diff) < 2;
          const typeColor = {resist:'down', key:'gold', mid:'neutral', support:'up', ext:'purple'}[data.type];
          return `<tr style="${isNear ? 'background:rgba(255,213,0,.07);' : ''}">
            <td><span class="${typeColor}">${pct}</span></td>
            <td style="font-weight:bold;">${data.price.toFixed(1)}</td>
            <td class="${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%</td>
            <td style="color:var(--muted);font-size:10px;">${data.label}${isNear ? ' ◀ 現在' : ''}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// =====================================================
// PRICE CHART
// =====================================================
function renderPriceChart(closes, timestamps, mas) {
  const canvas = document.getElementById('priceChart');
  if (state.priceChart) { state.priceChart.destroy(); }

  const labels = timestamps.map(t => {
    const d = new Date(t * 1000);
    return d.toLocaleDateString('zh-TW', { month:'2-digit', day:'2-digit' });
  }).slice(-60);
  const data = closes.slice(-60);
  const n = data.length;

  const calcMAArr = (arr, period) => {
    return arr.map((_, i) => i < period-1 ? null : arr.slice(i-period+1, i+1).reduce((a,b)=>a+b,0)/period);
  };

  state.priceChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '收盤價', data, borderColor: '#00d4ff', borderWidth: 1.5,
          pointRadius: 0, fill: false, tension: 0.1 },
        { label: 'MA21', data: calcMAArr(data, Math.min(21,n)), borderColor: '#ffd700',
          borderWidth: 1, pointRadius: 0, fill: false, borderDash: [] },
        { label: 'MA55', data: calcMAArr(data, Math.min(55,n)), borderColor: '#ff9500',
          borderWidth: 1, pointRadius: 0, fill: false },
        { label: 'MA144', data: calcMAArr(data, Math.min(60,n)), borderColor: '#ff4466',
          borderWidth: 1.5, pointRadius: 0, fill: false },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { labels: { color: '#6b7280', font: { size: 10 } } },
        tooltip: { mode: 'index', intersect: false,
          bodyColor: '#e2e8f0', titleColor: '#00d4ff',
          backgroundColor: '#111827', borderColor: '#1f2d40', borderWidth: 1 }
      },
      scales: {
        x: { ticks: { color: '#6b7280', maxTicksLimit: 8, font: { size: 10 } },
             grid: { color: '#1f2d40' } },
        y: { ticks: { color: '#6b7280', font: { size: 10 } },
             grid: { color: '#1f2d40' }, position: 'right' }
      }
    }
  });
}

// =====================================================
// SAVE / LOAD TRADE LOG
// =====================================================
function saveTrade() {
  const entry = parseFloat(document.getElementById('step_entryprice')?.value);
  const stop  = parseFloat(document.getElementById('step_stoploss')?.value);
  const target= parseFloat(document.getElementById('step_target')?.value);
  const dir   = document.getElementById('step_trend')?.value || '-';
  const lev   = document.getElementById('step_leverage')?.value || '1x';
  const cap   = calcKelly();

  if (!entry) { alert('請先填入進場價格'); return; }

  const risk   = entry && stop ? Math.abs(entry - stop) : 0;
  const reward = entry && target ? Math.abs(target - entry) : 0;
  const rr = risk > 0 ? (reward/risk).toFixed(2) : '-';

  const rec = {
    date: new Date().toLocaleDateString('zh-TW'),
    symbol: state.symbol,
    dir: dir.includes('多') ? '多' : dir.includes('空') ? '空' : '-',
    entry: entry,
    stop: stop || '-',
    target: target || '-',
    posPct: (cap.adjKelly * 100).toFixed(1) + '%',
    pnl: '未平',
    status: '持倉',
    note: document.getElementById('step_note')?.value || '',
    replay: document.getElementById('step_replay')?.value || '',
    rr,
  };

  state.tradeLog.unshift(rec);
  localStorage.setItem('tradeLog', JSON.stringify(state.tradeLog));
  renderTradeLog();
  alert('✅ 交易已儲存！');
}

function clearLog() {
  if (confirm('確定清除所有交易紀錄？')) {
    state.tradeLog = [];
    localStorage.removeItem('tradeLog');
    renderTradeLog();
  }
}

function clearSteps() {
  STEPS.forEach(s => {
    const el = document.getElementById(s.id);
    if (el) {
      if (s.type === 'calc') el.textContent = '-';
      else if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = '';
    }
    const numEl = document.getElementById('stepNum' + s.n);
    if (numEl) numEl.className = 'step-num';
  });
}

function renderTradeLog() {
  const tbody = document.getElementById('tradeLogBody');
  if (state.tradeLog.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:20px;">尚無紀錄</td></tr>';
    return;
  }
  tbody.innerHTML = state.tradeLog.map(r => `
    <tr>
      <td style="color:var(--muted)">${r.date}</td>
      <td class="gold">${r.symbol}</td>
      <td class="${r.dir === '多' ? 'up' : 'down'}">${r.dir}</td>
      <td>${r.entry}</td>
      <td class="down">${r.stop}</td>
      <td class="up">${r.target}</td>
      <td class="gold">${r.posPct}</td>
      <td class="${r.pnl === '未平' ? 'neutral' : parseFloat(r.pnl) >= 0 ? 'up' : 'down'}">${r.pnl}</td>
      <td><span class="trend-badge ${r.status === '持倉' ? 'sideways' : r.status === '獲利' ? 'bull' : 'bear'}" style="font-size:9px;">${r.status}</span></td>
    </tr>
  `).join('');
}

// =====================================================
// FORMAT HELPERS
// =====================================================
function fmtVol(n) {
  if (!n) return '-';
  if (n >= 1e12) return (n/1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n/1e4).toFixed(1) + '萬';
  return n.toLocaleString();
}

// =====================================================
// LOAD SYMBOL MAIN FUNCTION
// =====================================================
async function loadSymbol() {
  const rawInput = document.getElementById('symbolInput').value.trim() || '^TWII';
  state.symbol = rawInput.toUpperCase();
  const ySymbol = resolveSymbol(rawInput);
  stopRealtimePolling();

  document.getElementById('targetInfo').innerHTML = '<div class="loading"><span class="spinner"></span>載入真實數據中...</div>';
  setHtml('trendSystem', '<div class="loading"><span class="spinner"></span>分析趨勢...</div>');
  setHtml('elliottWave', '<div class="loading"><span class="spinner"></span>辨識波浪...</div>');
  setHtml('fibLevels', '<div class="loading"><span class="spinner"></span>計算費波那契...</div>');
  setHtml('hurstCycles', '<div class="loading"><span class="spinner"></span>分析赫斯特週期...</div>');
  document.getElementById('symbolBadge').textContent = state.symbol;
  setDataStatus('loading', '● 載入真實數據…');

  try {
    const market = await fetchMarketData(rawInput, (done, total) => {
      setDataStatus('loading', `● 載入真實數據 ${done}/${total}`);
    });

    const closes = market.closes;
    const timestamps = market.timestamps;
    const volumes = market.volumes || [];
    const priceData = {
      price: market.price,
      change: market.change,
      changePct: market.changePct,
      volume: market.volume,
      high52: market.high52,
      low52: market.low52,
      marketCap: market.marketCap,
      name: market.name,
      source: market.source,
    };

    const mas = calcAllMA(closes);
    const price = priceData.price;
    state.currentPrice = price;
    state.highPrice = priceData.high52;
    state.lowPrice = priceData.low52;
    state.prices = closes;

    const targetInfo = { ...priceData, symbol: state.symbol, ...mas };
    state.lastTargetInfo = targetInfo;
    renderTargetInfo(targetInfo);
    renderTrendSystem(price, mas, ySymbol);

    const kind = classifySymbol(rawInput);
    const stockMarket = kind.kind === 'stock' ? twMarketOf(kind.id) : null;
    const twOpen = isTwMarketOpen();
    const futOpen = isFuturesOpen();
    if (kind.kind === 'stock' && stockMarket) {
      startRealtimePolling({
        key: `stock:${kind.id}`,
        label: stockMarket === 'otc' ? '上櫃即時報價' : '上市即時報價',
        interval: 20000,
        live: twOpen,
        fetch: () => fetchTwseRealtime(kind.id, 'stock', stockMarket),
      });
    } else if (kind.kind === 'taiex') {
      startRealtimePolling({
        key: 'index:t00',
        label: '加權指數即時報價',
        interval: 15000,
        live: twOpen,
        fetch: () => fetchTwseRealtime('t00', 'index'),
      });
    } else if (kind.kind === 'futures') {
      startRealtimePolling({
        key: 'futures:TXF',
        label: '台指期即時報價',
        interval: 15000,
        live: futOpen,
        fetch: () => fetchTaifexRealtime('TXF'),
      });
    }

    const wave = detectElliottWave(closes, price, mas);
    renderElliottWave(wave);

    const hurst = analyzeHurstCycles(closes, timestamps);
    renderHurstCycles(hurst);

    const fibs = calcFib(priceData.high52, priceData.low52);
    renderFib(fibs, price, priceData.high52, priceData.low52);

    renderPriceChart(closes, timestamps, mas);
    state.lastCloses = closes;
    state.lastVolumes = volumes.slice();
    renderVolumeAnalysis(closes, volumes);
    if (document.getElementById('totalCapital')) calcKelly();

    const entryEl = document.getElementById('step_entryprice');
    if (entryEl) entryEl.value = price.toFixed(1);

    const trendEl = document.getElementById('step_trend');
    if (trendEl) {
      const t = determineTrend(price, mas);
      if (t === 'bull') trendEl.value = '多頭 (Bullish)';
      else if (t === 'bear') trendEl.value = '空頭 (Bearish)';
      else trendEl.value = '觀望';
    }
    calcAllSteps();

    const timeStr = market.updatedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    setDataStatus('ok', `● 真實數據 · ${market.source} · ${timeStr}`);

    await loadMarketOverview();
    await renderSentiment();
  } catch (err) {
    console.error(err);
    showLoadError(err.message || '資料來源暫時無法連線，請稍後再試');
  }
}

// =====================================================
// MARKET OVERVIEW LOADER
// =====================================================
async function fetchMarketOverviewItem(idx) {
  try {
    if (idx.finmind) {
      const hist = await fetchTaiexDailyHistory(30);
      if (hist.length < 2) throw new Error('加權資料不足');
      const closes = hist.map(h => h.close);
      const mas = calcAllMA(closes);
      const price = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      const change = price - prev;
      return {
        name: idx.name,
        price: price.toLocaleString(undefined, { maximumFractionDigits: 1 }),
        change,
        changePct: (change / prev) * 100,
        trend: determineTrend(price, mas),
        above21ma: mas.ma21 && price > mas.ma21,
        source: 'FinMind',
      };
    }
    if (idx.fred) {
      const parsed = await fetchFredSeries(idx.seriesId);
      if (idx.vix || idx.seriesId === 'VIXCLS') {
        const meta = vixLevel(parsed.price);
        return {
          name: idx.name,
          price: parsed.price.toFixed(2),
          change: parsed.change,
          changePct: parsed.changePct,
          isVix: true,
          vixMeta: meta,
          vixValueClass: meta.valueClass,
          source: 'FRED',
        };
      }
      const mas = calcAllMA(parsed.closes);
      return {
        name: idx.name,
        price: parsed.price.toLocaleString(undefined, { maximumFractionDigits: 1 }),
        change: parsed.change,
        changePct: parsed.changePct,
        trend: determineTrend(parsed.price, mas),
        above21ma: mas.ma21 && parsed.price > mas.ma21,
        source: 'FRED',
      };
    }
    throw new Error('未知市場類型');
  } catch (err) {
    return {
      name: idx.name,
      price: '載入失敗',
      change: 0,
      changePct: 0,
      trend: 'neutral',
      above21ma: false,
      failed: true,
      hint: err.message || '',
    };
  }
}

async function loadMarketOverview() {
  const indices = [
    { fred: true, seriesId: 'SP500', name: 'S&P 500' },
    { fred: true, seriesId: 'NASDAQCOM', name: 'NASDAQ' },
    { fred: true, seriesId: 'VIXCLS', name: 'VIX 恐慌', vix: true },
    { finmind: true, name: '台股加權' },
  ];

  const el = document.getElementById('marketOverview');
  el.innerHTML = '<div class="loading"><span class="spinner"></span>載入全球市場真實數據…</div>';

  const markets = [];
  for (const idx of indices) {
    markets.push(await fetchMarketOverviewItem(idx));
  }
  renderMarketOverview(markets);
}

// =====================================================
// 美銀牛熊指標（手動）+ VIX 推算情緒（即時）
// =====================================================
function bbZone(v) {
  if (v <= 2) return { label: '極度看空 · 反向買進訊號', cls: 'bull', color: 'var(--green)' };
  if (v < 4) return { label: '偏空 · 逢低布局區', cls: 'bull', color: '#7ed957' };
  if (v <= 6) return { label: '中性', cls: 'sideways', color: 'var(--gold)' };
  if (v < 8) return { label: '偏多 · 留意過熱', cls: 'bear', color: 'var(--orange)' };
  return { label: '極度看多 · 賣出訊號', cls: 'bear', color: 'var(--red)' };
}

function gaugeHtml(value, max, color, sub) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
      <span class="stat-value" style="color:${color};font-size:30px;">${value.toFixed(1)}</span>
      <span style="color:var(--muted);font-size:11px;">/ ${max}</span>
    </div>
    <div class="progress-wrap" style="height:10px;">
      <div class="progress-bar" style="width:${pct}%;background:${color};"></div>
    </div>
    <div style="font-size:11px;margin-top:6px;color:${color};">${sub}</div>`;
}

function toggleBbEdit() {
  const el = document.getElementById('bbEdit');
  const show = el.style.display === 'none';
  el.style.display = show ? 'block' : 'none';
  if (show) {
    const saved = JSON.parse(localStorage.getItem('bofaBullBear') || 'null');
    if (saved) document.getElementById('bbValueInput').value = saved.value;
  }
}

function saveBbValue() {
  const v = parseFloat(document.getElementById('bbValueInput').value);
  if (Number.isNaN(v) || v < 0 || v > 10) { alert('請輸入 0–10 的數值'); return; }
  localStorage.setItem('bofaBullBear', JSON.stringify({ value: v, date: new Date().toISOString() }));
  document.getElementById('bbEdit').style.display = 'none';
  renderSentiment();
}

// 百分位排名：latest 在 arr 中 <= 的比例（0~1）
function percentileRank(arr, latest) {
  if (!arr.length) return 0.5;
  let le = 0;
  for (const v of arr) if (v <= latest) le++;
  return le / arr.length;
}

// 自製綜合情緒：以美銀牛熊核心因子做百分位加權（0=極空,10=極多）
// 因子：信用利差(HY+IG)、VIX、金融狀況(NFCI)、股市動能(SP500)
const SENTIMENT_FACTORS = [
  { id: 'BAMLH0A0HYM2', name: '高收益信用利差', weight: 0.22, invert: true, limit: 600 },
  { id: 'BAMLC0A0CM',   name: '投資級信用利差', weight: 0.10, invert: true, limit: 600 },
  { id: 'VIXCLS',       name: 'VIX 波動率',     weight: 0.20, invert: true, limit: 600 },
  { id: 'NFCI',         name: '金融狀況 NFCI',  weight: 0.18, invert: true, limit: 600 },
  { id: 'SP500_MOM',    name: 'S&P 動能',       weight: 0.30, invert: false, limit: 500 },
];

async function factorScore(factor) {
  if (factor.id === 'SP500_MOM') {
    const sp = await fetchFredSeries('SP500', factor.limit);
    const c = sp.closes;
    const win = 100;
    if (c.length < win + 5) throw new Error('SP500 資料不足');
    const ratios = [];
    for (let i = win; i < c.length; i++) {
      const ma = c.slice(i - win, i).reduce((a, b) => a + b, 0) / win;
      ratios.push(c[i] / ma - 1);
    }
    const latest = ratios[ratios.length - 1];
    const p = percentileRank(ratios, latest);
    return { score: p * 10, raw: (latest * 100).toFixed(1) + '%' };
  }
  const s = await fetchFredSeries(factor.id, factor.limit);
  const p = percentileRank(s.closes, s.price);
  const bull = factor.invert ? (1 - p) : p;
  return { score: bull * 10, raw: s.price.toFixed(2) };
}

async function computeComposite() {
  const comps = [];
  let wsum = 0, acc = 0;
  for (const f of SENTIMENT_FACTORS) {
    try {
      const r = await factorScore(f);
      comps.push({ name: f.name, score: r.score, raw: r.raw, weight: f.weight, ok: true });
      acc += r.score * f.weight;
      wsum += f.weight;
    } catch {
      comps.push({ name: f.name, ok: false });
    }
  }
  if (wsum === 0) throw new Error('情緒因子全部載入失敗');
  let score = acc / wsum;
  const cal = parseFloat(localStorage.getItem('bbCalibration') || '0') || 0;
  const adj = Math.max(0, Math.min(10, score + cal));
  return { score: adj, rawScore: score, calibration: cal, comps };
}

function calibrateToBofa() {
  const saved = JSON.parse(localStorage.getItem('bofaBullBear') || 'null');
  if (!saved) { alert('請先在右上角「更新數值」輸入美銀牛熊值，才能校準'); return; }
  const raw = window._lastCompositeRaw;
  if (raw == null) { alert('綜合情緒尚未載入完成，請稍候再試'); return; }
  const offset = saved.value - raw;
  localStorage.setItem('bbCalibration', String(offset));
  renderSentiment();
}

function resetCalibration() {
  localStorage.removeItem('bbCalibration');
  renderSentiment();
}

function compositeCardHtml(data) {
  const z = bbZone(data.score);
  const bars = data.comps.map(c => {
    if (!c.ok) return `<div style="font-size:10px;color:var(--muted);">${c.name}：載入失敗</div>`;
    const cz = bbZone(c.score);
    return `
      <div style="margin-bottom:5px;">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);">
          <span>${c.name} <span style="opacity:.6;">(${(c.weight * 100).toFixed(0)}%)</span></span>
          <span style="color:${cz.color};">${c.score.toFixed(1)} · ${c.raw}</span>
        </div>
        <div class="progress-wrap" style="height:4px;"><div class="progress-bar" style="width:${c.score * 10}%;background:${cz.color};"></div></div>
      </div>`;
  }).join('');
  const calNote = data.calibration
    ? `已校準 ${data.calibration > 0 ? '+' : ''}${data.calibration.toFixed(1)}（原始 ${data.rawScore.toFixed(1)}）`
    : `未校準（原始值）`;
  return `
    <div class="stat-card">
      <div class="stat-label">自製綜合情緒（即時 · 真實數據）</div>
      ${gaugeHtml(data.score, 10, z.color, z.label)}
      <div style="margin-top:10px;">${bars}</div>
      <div class="search-meta">FRED 信用利差 + VIX + 金融狀況 + S&P 動能 · 百分位加權</div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
        <button class="btn btn-outline" type="button" style="font-size:10px;padding:3px 8px;" onclick="calibrateToBofa()">校準至美銀</button>
        ${data.calibration ? '<button class="btn btn-outline" type="button" style="font-size:10px;padding:3px 8px;" onclick="resetCalibration()">取消校準</button>' : ''}
        <span style="font-size:10px;color:var(--muted);align-self:center;">${calNote}</span>
      </div>
    </div>`;
}

function bofaCardHtml() {
  const saved = JSON.parse(localStorage.getItem('bofaBullBear') || 'null');
  if (saved) {
    const z = bbZone(saved.value);
    const d = new Date(saved.date);
    return `
      <div class="stat-card">
        <div class="stat-label">美銀牛熊指標 (BofA Bull & Bear)</div>
        ${gaugeHtml(saved.value, 10, z.color, z.label)}
        <div class="search-meta">更新：${d.toLocaleDateString('zh-TW')} · 手動輸入（每週公布、無免費 API）</div>
      </div>`;
  }
  return `
    <div class="stat-card" style="border-color:var(--gold);">
      <div class="stat-label">美銀牛熊指標 (BofA Bull & Bear)</div>
      <div style="color:var(--muted);font-size:12px;margin:10px 0;line-height:1.6;">
        尚未輸入。每週公布、無免費 API，請點右上角 <strong style="color:var(--gold)">更新數值</strong> 填入，
        即可用來校準左側自製情緒。
      </div>
      <div style="font-size:10px;color:var(--muted);">0–2 買訊 · 8–10 賣訊</div>
    </div>`;
}

async function renderSentiment() {
  const grid = document.getElementById('sentimentGrid');
  grid.innerHTML = `
    <div class="stat-card"><div class="loading"><span class="spinner"></span>計算綜合情緒（真實數據）…</div></div>
    ${bofaCardHtml()}`;

  const hasFred = getFredKey() || (isCloudDeployed() && window._cloudHasFred);
  if (!hasFred) {
    grid.innerHTML = `
      <div class="stat-card" style="border-color:var(--gold);">
        <div class="stat-label">自製綜合情緒</div>
        <div style="color:var(--muted);font-size:12px;margin:10px 0;">需 FRED Key（Netlify 環境變數 FRED_API_KEY，或設定面板填入）</div>
      </div>
      ${bofaCardHtml()}`;
    return;
  }

  try {
    const data = await computeComposite();
    window._lastCompositeRaw = data.rawScore;
    grid.innerHTML = compositeCardHtml(data) + bofaCardHtml();
  } catch (e) {
    grid.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">自製綜合情緒</div>
        <div style="color:var(--muted);font-size:12px;margin:10px 0;">載入失敗：${e.message}。可重新整理重試。</div>
      </div>
      ${bofaCardHtml()}`;
  }
}

// =====================================================
// INIT
// =====================================================
const _urlParams = new URLSearchParams(location.search);
if (_urlParams.get('finmind_token')) {
  saveFinMindToken(_urlParams.get('finmind_token'));
}
if (_urlParams.get('fred_key')) {
  saveFredKey(_urlParams.get('fred_key'));
}
if (_urlParams.get('finmind_token') || _urlParams.get('fred_key')) {
  history.replaceState({}, '', location.pathname + location.hash);
}

async function bootDashboard() {
  renderSteps();
  if (document.getElementById('tradeLogBody')) renderTradeLog();
  if (document.getElementById('totalCapital')) calcKelly();
  initStockSearch();
  if (typeof initMobileTabs === 'function') initMobileTabs();
  if (typeof updateMobileTokenStatus === 'function') updateMobileTokenStatus();
  await checkProxyHealth();
  if (typeof updateMobileSettingsUI === 'function') updateMobileSettingsUI();
  if (typeof updateMobileTokenStatus === 'function') updateMobileTokenStatus();
  await loadSymbol();
}

bootDashboard();

setInterval(checkProxyHealth, 60000);

// Refresh every 5 minutes
setInterval(() => {
  if (document.visibilityState === 'visible') loadSymbol();
}, 300000);

// PWA service worker（自動更新，避免卡在舊版快取）
if ('serviceWorker' in navigator) {
  let _swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swReloaded) return;
    _swReloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update();
    setInterval(() => reg.update(), 60 * 60 * 1000);
  }).catch(() => {});
}
