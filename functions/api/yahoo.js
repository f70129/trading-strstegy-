/** Cloudflare Pages Function — /api/yahoo（Yahoo Chart 代理） */
export async function onRequest(context) {
  const { request } = context;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'GET') {
    return json({ error: 'GET only' }, 405, cors);
  }

  const { searchParams } = new URL(request.url);
  if (searchParams.get('health') === '1') {
    return json({ ok: true, provider: 'cloudflare-yahoo' }, 200, cors);
  }

  const symbol = searchParams.get('symbol') || '^GSPC';
  const interval = searchParams.get('interval') || '1d';
  if (!/^[0-9A-Za-z^._=-]{1,20}$/.test(symbol)) {
    return json({ error: 'symbol invalid' }, 400, cors);
  }

  const encoded = encodeURIComponent(symbol);
  let url;
  const period1 = searchParams.get('period1');
  const period2 = searchParams.get('period2');
  if (period1 && period2) {
    url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}` +
      `?interval=${encodeURIComponent(interval)}` +
      `&period1=${encodeURIComponent(period1)}` +
      `&period2=${encodeURIComponent(period2)}` +
      `&includePrePost=false`;
  } else {
    const range = searchParams.get('range') || '1y';
    url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}` +
      `?interval=${encodeURIComponent(interval)}` +
      `&range=${encodeURIComponent(range)}` +
      `&includePrePost=false`;
  }

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingDashboard/1.0)' },
    });
    const data = await r.json();
    if (data?.chart?.error) {
      return json({ error: data.chart.error.description || 'Yahoo 回傳錯誤' }, 502, cors);
    }
    return json(data, r.ok ? 200 : r.status, cors);
  } catch (e) {
    return json({ error: e.message || 'Yahoo 連線失敗' }, 502, cors);
  }
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
