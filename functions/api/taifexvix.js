/** Cloudflare Pages Function — 路徑 /api/taifexvix
 *  臺指選擇權波動率指數 (VIXTWN) 歷史，來源：期交所 TAIFEX vixQuery。
 *  參數：?start=YYYY-MM-DD (可選，預設約近 8 個月)、?end=YYYY-MM-DD (可選，預設今天)
 *  回傳：{ data: [{ date: "YYYY-MM-DD", vix: Number }, ...] }（日期由舊到新）
 */
export async function onRequest(context) {
  const { request } = context;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405, cors);

  const { searchParams } = new URL(request.url);
  const toSlash = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, '/') : null);
  const today = new Date();
  const def = new Date(today.getTime() - 240 * 864e5);
  const fmt = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const start = toSlash(searchParams.get('start')) || fmt(def);
  const end = toSlash(searchParams.get('end')) || fmt(today);

  const body = new URLSearchParams({ queryStartDate: start, queryEndDate: end }).toString();

  try {
    const r = await fetch('https://www.taifex.com.tw/cht/3/vixQuery', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html',
        'Referer': 'https://www.taifex.com.tw/cht/3/vixQuery',
      },
      body,
    });
    const html = await r.text();
    // 表格列：日期(yyyy/MM/dd) 後接波動率指數數值
    const rows = [];
    const re = /(\d{4}\/\d{2}\/\d{2})\s*<\/td>\s*<td[^>]*>\s*([0-9]+(?:\.[0-9]+)?)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const v = parseFloat(m[2]);
      if (isFinite(v)) rows.push({ date: m[1].replace(/\//g, '-'), vix: v });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    return json({ data: rows, count: rows.length }, r.ok ? 200 : r.status, cors);
  } catch (e) {
    return json({ error: e.message || 'TAIFEX 連線失敗', data: [] }, 502, cors);
  }
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
