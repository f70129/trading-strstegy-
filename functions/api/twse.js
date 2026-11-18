/** Cloudflare Pages Function — 路徑 /api/twse（上市/上櫃個股、加權指數即時） */
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

  // 多檔查詢：chs=tse_2330,otc_6488,...（最多 120 檔）→ ex_ch 以 | 串接
  const chs = searchParams.get('chs');
  let exch;
  if (chs) {
    const list = chs.split(',').map(s => s.trim()).filter(Boolean).slice(0, 120);
    const ok = list.every(c => /^(tse|otc)_[0-9A-Za-z]{2,6}$/.test(c));
    if (!list.length || !ok) {
      return json({ error: 'chs must be comma list like tse_2330,otc_6488' }, 400, cors);
    }
    exch = list.map(c => `${c}.tw`).join('|');
  } else {
    const stockId = searchParams.get('id');
    if (!stockId || !/^[0-9A-Za-z]{2,6}$/.test(stockId)) {
      return json({ error: 'id required (listed stock e.g. 2330, index t00) or chs=...' }, 400, cors);
    }
    const market = searchParams.get('ex') === 'otc' ? 'otc' : 'tse';
    exch = `${market}_${stockId}.tw`;
  }

  const url =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp` +
    `?ex_ch=${encodeURIComponent(exch)}&json=1&delay=0`;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://mis.twse.com.tw/',
      },
    });
    const data = await r.json();
    return json(data, r.ok ? 200 : r.status, cors);
  } catch (e) {
    return json({ error: e.message || 'TWSE 連線失敗' }, 502, cors);
  }
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
