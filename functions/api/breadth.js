/** Cloudflare Pages Function — /api/breadth
 * 全市場(上市+上櫃普通股)盤中漲跌/漲停/跌停家數:
 * 1) 取全市場代碼(TWSE/TPEx OpenAPI,快取 6h)
 * 2) MIS getStockInfo 每批 150 檔並行查詢即時報價
 * 3) 逐檔以 現價(成交→委買賣中價→前筆→開盤) vs 昨收 判漲跌,u/w 判漲跌停
 * 結果快取 12 秒,供多人共用、降低 MIS 負載。
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const MIS_HDR = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://mis.twse.com.tw/stock/index.jsp' };

export async function onRequest(context) {
  const { request, waitUntil } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  try {
    const uni = await getUniverse(cache, waitUntil);
    const chans = [...uni.tse.map(c => `tse_${c}.tw`), ...uni.otc.map(c => `otc_${c}.tw`)];
    if (!chans.length) return json({ error: 'universe unavailable' }, 502);

    const batches = [];
    for (let i = 0; i < chans.length; i += 150) batches.push(chans.slice(i, i + 150));
    const arrs = await Promise.all(batches.map(misFetch));
    const arr = arrs.flat();

    const result = aggregate(arr);
    const resp = json(result, 200, { 'Cache-Control': 'public, max-age=12' });
    waitUntil(cache.put(request, resp.clone()));
    return resp;
  } catch (e) {
    return json({ error: (e && e.message) || 'breadth failed' }, 502);
  }
}

async function getUniverse(cache, waitUntil) {
  const key = new Request('https://cache.internal/breadth-universe-v1');
  const hit = await cache.match(key);
  if (hit) { try { return await hit.json(); } catch (e) {} }

  const [tseJson, otcJson] = await Promise.all([
    fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers: MIS_HDR }).then(r => r.json()).catch(() => []),
    fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', { headers: MIS_HDR }).then(r => r.json()).catch(() => []),
  ]);
  const pick = (rows, k) => {
    const out = [];
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const c = String(r[k] || '').trim();
      if (/^[1-9]\d{3}$/.test(c)) out.push(c);
    }
    return out;
  };
  const uni = { tse: pick(tseJson, 'Code'), otc: pick(otcJson, 'SecuritiesCompanyCode') };
  if (uni.tse.length && uni.otc.length) {
    const r = new Response(JSON.stringify(uni), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' } });
    waitUntil(cache.put(key, r.clone()));
  }
  return uni;
}

async function misFetch(chs) {
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(chs.join('|'))}&json=1&delay=0`;
  try {
    const r = await fetch(url, { headers: MIS_HDR });
    const j = await r.json();
    return (j && j.msgArray) || [];
  } catch (e) { return []; }
}

function num(x) {
  if (x == null) return null;
  const s = String(x).trim().replace(/,/g, '');
  if (s === '' || s === '-' || s === '--') return null;
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}
function price(m) {
  const z = num(m.z); if (z != null && z > 0) return z;
  const ask = num(String(m.a || '').split('_')[0]);
  const bid = num(String(m.b || '').split('_')[0]);
  if (ask != null && ask > 0 && bid != null && bid > 0) return (ask + bid) / 2;
  if (ask != null && ask > 0) return ask;   // 跌停鎖死:僅剩委賣
  if (bid != null && bid > 0) return bid;   // 漲停鎖死:僅剩委買
  const pz = num(m.pz); if (pz != null && pz > 0) return pz;
  const o = num(m.o); return (o != null && o > 0) ? o : null;
}
function aggregate(arr) {
  const S = () => ({ n: 0, up: 0, dn: 0, flat: 0, lu: 0, ld: 0, nt: 0 });
  const o = { tse: S(), otc: S(), all: S() };
  let time = '';
  const eps = 1e-6;
  for (const m of arr) {
    const mk = m.ex === 'otc' ? 'otc' : 'tse';
    const px = price(m), y = num(m.y), u = num(m.u), w = num(m.w);
    const s = o[mk], a = o.all; s.n++; a.n++;
    if (!time) { const tt = m.t || m['%'] || ''; if (tt) time = tt; }
    if (px == null || y == null) { s.nt++; a.nt++; continue; }
    if (u != null && px >= u - eps) { s.lu++; a.lu++; }
    if (w != null && px <= w + eps) { s.ld++; a.ld++; }
    if (px > y + eps) { s.up++; a.up++; }
    else if (px < y - eps) { s.dn++; a.dn++; }
    else { s.flat++; a.flat++; }
  }
  return { updated: new Date().toISOString(), time, tse: o.tse, otc: o.otc, all: o.all };
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(extra || {}) },
  });
}
