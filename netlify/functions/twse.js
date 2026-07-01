/** Netlify Function — TWSE 即時報價代理（上市/上櫃個股、加權指數） */
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
  const stockId = params.id;
  if (!stockId || !/^[0-9A-Za-z]{2,6}$/.test(stockId)) {
    return respond(400, { error: 'id required (listed stock e.g. 2330, index t00)' }, cors);
  }
  const market = params.ex === 'otc' ? 'otc' : 'tse';

  const url =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp` +
    `?ex_ch=${market}_${encodeURIComponent(stockId)}.tw&json=1&delay=0`;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://mis.twse.com.tw/',
      },
    });
    const data = await r.json();
    return respond(r.ok ? 200 : r.status, data, cors);
  } catch (e) {
    return respond(502, { error: e.message || 'TWSE 連線失敗' }, cors);
  }
};

function respond(status, body, cors) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify(body),
  };
}
