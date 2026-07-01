/** Netlify Function — FinMind 代理（手機免填 IP，Token 由前端帶入） */
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'GET only' }, cors);
  }

  const params = event.queryStringParameters || {};
  if (params.health === '1') {
    return respond(200, {
      ok: true,
      provider: 'netlify-finmind',
      hasToken: !!(params.token || process.env.FINMIND_TOKEN),
    }, cors);
  }

  const token = params.token || process.env.FINMIND_TOKEN;
  if (!token) {
    return respond(400, {
      error: 'FinMind Token 未設定（Netlify 環境變數 FINMIND_TOKEN，或手機設定填入）',
    }, cors);
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'token') qs.set(k, v);
  }

  const url = `https://api.finmindtrade.com/api/v4/data?${qs.toString()}`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await r.json();
    return respond(r.ok ? 200 : r.status, data, cors);
  } catch (e) {
    return respond(502, { error: e.message || 'FinMind 連線失敗' }, cors);
  }
};

function respond(status, body, cors) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify(body),
  };
}
