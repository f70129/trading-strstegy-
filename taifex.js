/** Cloudflare Pages Function — 路徑 /api/finmind */
export async function onRequest(context) {
  const { request } = context;
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
  if (searchParams.get('health') === '1') {
    return json({ ok: true, provider: 'cloudflare-finmind' }, 200, cors);
  }

  const token = searchParams.get('token');
  if (!token) {
    return json({ error: 'token required' }, 400, cors);
  }

  const qs = new URLSearchParams();
  for (const [k, v] of searchParams) {
    if (k !== 'token') qs.set(k, v);
  }

  const url = `https://api.finmindtrade.com/api/v4/data?${qs.toString()}`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await r.json();
    return json(data, r.ok ? 200 : r.status, cors);
  } catch (e) {
    return json({ error: e.message || 'FinMind 連線失敗' }, 502, cors);
  }
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
