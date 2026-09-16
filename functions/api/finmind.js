/** Cloudflare Pages Function — /api/finmind（與 Netlify finmind.js 行為一致） */
export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'GET') {
    return json({ error: 'GET only' }, 405, cors);
  }

  const { searchParams } = new URL(request.url);
  const envToken = env.FINMIND_TOKEN || '';
  const queryToken = searchParams.get('token') || '';
  const token = queryToken || envToken;

  if (searchParams.get('health') === '1') {
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
    return json({
      ok: true,
      provider: 'cloudflare-finmind',
      hasToken: !!token,
      tokenValid,
      tokenSource: queryToken ? 'query' : envToken ? 'env' : 'none',
    }, 200, cors);
  }

  const ALLOWED_ENDPOINTS = ['data', 'taiwan_futures_snapshot', 'taiwan_options_snapshot', 'taiwan_stock_tick_snapshot'];
  const endpointParam = searchParams.get('endpoint') || 'data';
  const endpoint = ALLOWED_ENDPOINTS.includes(endpointParam) ? endpointParam : 'data';
  const qs = new URLSearchParams();
  for (const [k, v] of searchParams) {
    if (k !== 'token' && k !== 'endpoint') qs.set(k, v);
  }

  const url = `https://api.finmindtrade.com/api/v4/${endpoint}?${qs.toString()}`;
  try {
    let useToken = queryToken || envToken;
    let data = await callFinMind(url, useToken);
    const needAnonRetry = (d) =>
      d.status === 400
      || d.status === 402
      || /illegal|upper limit/i.test(d.msg || d.error || '');
    if (useToken && needAnonRetry(data)) {
      data = await callFinMind(url, '');
    }
    if (data.status === 400 || /illegal/i.test(data.msg || data.error || '')) {
      return json({
        ...data,
        error: data.msg || data.error || 'FinMind 回傳錯誤',
        code: /illegal/i.test(data.msg || '') ? 'TOKEN_ILLEGAL' : 'FINMIND_ERROR',
      }, 400, cors);
    }
    if (!data.error && (data.status === 200 || Array.isArray(data.data))) {
      return json(data, 200, cors);
    }
    return json({
      ...data,
      error: data.msg || data.error || 'FinMind 回傳錯誤',
      code: 'FINMIND_ERROR',
    }, 400, cors);
  } catch (e) {
    return json({ error: e.message || 'FinMind 連線失敗' }, 502, cors);
  }
}

async function callFinMind(url, token) {
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers });
  return r.json();
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
