/** Cloudflare Pages Function — 路徑 /api/aaii（與 Netlify 二擇一部署即可）
 * 伺服器端抓取 AAII 散戶情緒調查（避開瀏覽器 CORS），容錯解析看多/中立/看空 %。 */
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
  if (searchParams.get('health') === '1') return json({ ok: true, provider: 'cloudflare-pages-aaii' }, 200, cors);
  const debug = searchParams.get('debug') === '1';

  const SOURCES = [
    'https://www.aaii.com/sentimentsurvey',
    'https://www.aaii.com/sentimentsurvey/sent_results',
  ];
  const tried = [];
  for (const url of SOURCES) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const text = await r.text();
      const parsed = parseAAII(text);
      tried.push({ url, status: r.status, ok: !!parsed, len: text.length });
      if (parsed) {
        const body = { ok: true, source: url, fetchedAt: new Date().toISOString(), ...parsed };
        if (debug) body.rawSnippet = snippet(text);
        return json(body, 200, cors);
      }
      if (debug) return json({ ok: false, source: url, error: '無法從頁面解析出情緒數字（可能為 JS 動態渲染）', status: r.status, len: text.length, rawSnippet: snippet(text), tried }, 200, cors);
    } catch (e) {
      tried.push({ url, error: e.message });
    }
  }
  return json({ ok: false, error: 'AAII 來源無法解析（網站改版或動態渲染）；請在看板改用「手動輸入」', tried }, 502, cors);
}

function parseAAII(text) {
  if (!text) return null;
  const pct = (label) => {
    const patterns = [
      new RegExp(label + '[^0-9%]{0,80}?([0-9]{1,3}(?:\\.[0-9]+)?)\\s*%', 'i'),
      new RegExp('"?' + label + '"?\\s*[:=]\\s*"?([0-9]{1,3}(?:\\.[0-9]+)?)', 'i'),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        let v = parseFloat(m[1]);
        if (v > 0 && v <= 1) v *= 100;
        if (v >= 0 && v <= 100) return Math.round(v * 10) / 10;
      }
    }
    return null;
  };
  const bullish = pct('bullish');
  const neutral = pct('neutral');
  const bearish = pct('bearish');
  if (bullish == null || bearish == null) return null;
  const sum = bullish + (neutral || 0) + bearish;
  if (sum < 80 || sum > 120) return null;
  let asof = null;
  const dm = text.match(/(?:as of|week ending|ending|reported)[^0-9]{0,20}([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i)
    || text.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  if (dm) asof = dm[1];
  const spread = Math.round((bullish - bearish) * 10) / 10;
  return { bullish, neutral: neutral == null ? Math.round((100 - bullish - bearish) * 10) / 10 : neutral, bearish, spread, asof };
}

function snippet(text) {
  const i = text.toLowerCase().indexOf('bullish');
  if (i >= 0) return text.slice(Math.max(0, i - 120), i + 400);
  return text.slice(0, 500);
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}
