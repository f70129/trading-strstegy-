/** Netlify Function — 台指期即時報價代理（TAIFEX 期交所） */
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

  const cid = (event.queryStringParameters || {}).cid || 'TXF';
  if (!/^[0-9A-Za-z]{2,6}$/.test(cid)) {
    return respond(400, { error: 'cid invalid' }, cors);
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
    return respond(r.ok ? 200 : r.status, data, cors);
  } catch (e) {
    return respond(502, { error: e.message || 'TAIFEX 連線失敗' }, cors);
  }
};

function respond(status, body, cors) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify(body),
  };
}
