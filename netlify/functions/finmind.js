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
  const envToken = process.env.FINMIND_TOKEN || '';
  const queryToken = params.token || '';
  const token = queryToken || envToken;

  if (params.health === '1') {
    let tokenValid = false;
    if (token) {
      try {
        const probe = await fetch(
          'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockTradingDate&start_date=2026-01-01&end_date=2026-01-05',
          {
            headers: {
              'User-Agent': 'Mozilla/5.0',
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            },
          },
        );
        const probeJson = await probe.json();
        tokenValid = probe.ok && probeJson.status === 200;
      } catch (_) { /* ignore */ }
    }
    return respond(200, {
      ok: true,
      provider: 'netlify-finmind',
      hasToken: !!token,
      tokenValid,
      tokenSource: queryToken ? 'query' : envToken ? 'env' : 'none',
    }, cors);
  }

  if (!token) {
    return respond(400, {
      error: 'FinMind Token 未設定（Netlify 環境變數 FINMIND_TOKEN，或手機設定填入）',
      code: 'TOKEN_MISSING',
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
    if (!r.ok || data.status === 400 || /illegal/i.test(data.msg || '')) {
      return respond(400, {
        ...data,
        error: data.msg || data.error || 'FinMind 回傳錯誤',
        code: /illegal/i.test(data.msg || '') ? 'TOKEN_ILLEGAL' : 'FINMIND_ERROR',
      }, cors);
    }
    return respond(200, data, cors);
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
