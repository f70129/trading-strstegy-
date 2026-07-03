/** Netlify Function — Yahoo Finance Chart API 代理（S&P 季節性長歷史） */
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'GET only' }, cors);
  }

  const params = event.queryStringParameters || {};
  if (params.health === '1') {
    return respond(200, { ok: true, provider: 'netlify' }, cors);
  }

  const symbol = params.symbol || '^GSPC';
  const interval = params.interval || '1d';
  if (!/^[0-9A-Za-z^._-]{1,20}$/.test(symbol)) {
    return respond(400, { error: 'symbol invalid' }, cors);
  }

  const encoded = encodeURIComponent(symbol);
  let url;
  if (params.period1 && params.period2) {
    url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}` +
      `?interval=${encodeURIComponent(interval)}` +
      `&period1=${encodeURIComponent(params.period1)}` +
      `&period2=${encodeURIComponent(params.period2)}` +
      `&includePrePost=false`;
  } else {
    const range = params.range || '1y';
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
      return respond(502, { error: data.chart.error.description || 'Yahoo 回傳錯誤' }, cors);
    }
    return respond(r.ok ? 200 : r.status, data, cors);
  } catch (e) {
    return respond(502, { error: e.message || 'Yahoo 連線失敗' }, cors);
  }
};

function respond(status, body, cors) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify(body),
  };
}
