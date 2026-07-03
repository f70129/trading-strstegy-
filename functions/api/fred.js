/** Cloudflare Pages Function — 路徑 /api/fred（與 Netlify 二擇一部署即可） */
export async function onRequest(context) {
  const { request, env } = context;
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
    return json({ ok: true, provider: 'cloudflare-pages', hasKey: !!env.FRED_API_KEY }, 200, cors);
  }

  const seriesId = searchParams.get('series_id');
  if (!seriesId) {
    return json({ error: 'series_id required' }, 400, cors);
  }

  const apiKey = env.FRED_API_KEY;
  if (!apiKey) {
    return json({ error: 'FRED_API_KEY 未設定（Pages → Settings → Environment variables）' }, 500, cors);
  }

  const limit = searchParams.get('limit') || '';
  const obsStart = searchParams.get('observation_start') || '';
  const obsEnd = searchParams.get('observation_end') || '';
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
      return json({ error: data.error_message }, 400, cors);
    }
    return json(data, r.ok ? 200 : r.status, cors);
  } catch (e) {
    return json({ error: e.message || 'FRED 連線失敗' }, 502, cors);
  }
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
