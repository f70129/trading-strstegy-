/** Netlify Function — FRED API 代理（部署 Netlify 後自動可用，無需手動填 Worker 網址） */
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
    return respond(200, { ok: true, provider: 'netlify', hasKey: !!process.env.FRED_API_KEY }, cors);
  }

  const seriesId = params.series_id;
  if (!seriesId) {
    return respond(400, { error: 'series_id required' }, cors);
  }

  const apiKey = params.key || process.env.FRED_API_KEY;
  if (!apiKey) {
    return respond(400, { error: 'FRED Key 未設定（設定面板填入，或 Netlify 環境變數 FRED_API_KEY）' }, cors);
  }

  const limit = params.limit || '';
  const obsStart = params.observation_start || '';
  const obsEnd = params.observation_end || '';
  let fredUrl =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${encodeURIComponent(apiKey)}` +
    `&file_type=json`;
  if (obsStart) {
    fredUrl += `&observation_start=${encodeURIComponent(obsStart)}&sort_order=asc`;
    if (obsEnd) fredUrl += `&observation_end=${encodeURIComponent(obsEnd)}`;
  } else {
    fredUrl += `&sort_order=desc&limit=${limit || '120'}`;
  }

  try {
    const r = await fetch(fredUrl);
    const data = await r.json();
    if (data.error_message) {
      return respond(400, { error: data.error_message }, cors);
    }
    return respond(r.ok ? 200 : r.status, data, cors);
  } catch (e) {
    return respond(502, { error: e.message || 'FRED 連線失敗' }, cors);
  }
};

function respond(status, body, cors) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify(body),
  };
}
