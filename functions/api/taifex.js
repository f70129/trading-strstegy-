/** Cloudflare Pages Function — 路徑 /api/taifex（台指期即時，TAIFEX 期交所） */
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
  const cid = searchParams.get('cid') || 'TXF';
  if (!/^[0-9A-Za-z]{2,6}$/.test(cid)) {
    return json({ error: 'cid invalid' }, 400, cors);
  }

  try {
    const r = await fetch('https://mis.taifex.com.tw/futures/api/getQuoteList', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Referer': 'https://mis.taifex.com.tw/',
      },
      body: JSON.stringify({
        MarketType: '0', SymbolType: 'F', KindID: '1',
        CID: cid, ExpireMonth: '', RowSize: '全部',
        PageNo: '', SortColumn: '', AscDesc: 'A',
      }),
    });
    const data = await r.json();
    return json(data, r.ok ? 200 : r.status, cors);
  } catch (e) {
    return json({ error: e.message || 'TAIFEX 連線失敗' }, 502, cors);
  }
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
