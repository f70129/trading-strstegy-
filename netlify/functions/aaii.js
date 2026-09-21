/**
 * Netlify Function — AAII Investor Sentiment Survey 代理
 * 由伺服器端抓取 aaii.com（避開瀏覽器 CORS），解析本週看多/中立/看空 %。
 * 週更（每週四）美國散戶情緒調查，屬「反向指標」；本看板僅作情緒參考卡，不介入盤中進出場。
 *   /.netlify/functions/aaii            → { ok, asof, bullish, neutral, bearish, spread, source }
 *   /.netlify/functions/aaii?debug=1    → 另附抓到的原始片段，供「檢核」頁比對欄位
 *   /.netlify/functions/aaii?health=1   → 健康檢查
 */
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'GET only' }, cors);

  const params = event.queryStringParameters || {};
  if (params.health === '1') return respond(200, { ok: true, provider: 'netlify-aaii' }, cors);
  const debug = params.debug === '1';

  // 依序嘗試多個來源；哪個先解析成功就用哪個
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
        return respond(200, body, cors);
      }
      if (debug) return respond(200, { ok: false, source: url, error: '無法從頁面解析出情緒數字（可能為 JS 動態渲染）', status: r.status, len: text.length, rawSnippet: snippet(text), tried }, cors);
    } catch (e) {
      tried.push({ url, error: e.message });
    }
  }
  return respond(502, { ok: false, error: 'AAII 來源無法解析（網站改版或動態渲染）；請在看板改用「手動輸入」', tried }, cors);
};

/** 從 HTML/JSON 文字中容錯解析 Bullish / Neutral / Bearish 百分比與日期 */
function parseAAII(text) {
  if (!text) return null;
  const pct = (label) => {
    // 例："Bullish 43.5%"、"Bullish</...>43.5%"、"\"bullish\":0.435"、"Bullish: 43.5"
    const patterns = [
      new RegExp(label + '[^0-9%]{0,80}?([0-9]{1,3}(?:\\.[0-9]+)?)\\s*%', 'i'),
      new RegExp('"?' + label + '"?\\s*[:=]\\s*"?([0-9]{1,3}(?:\\.[0-9]+)?)', 'i'),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        let v = parseFloat(m[1]);
        if (v > 0 && v <= 1) v *= 100; // 0.435 → 43.5
        if (v >= 0 && v <= 100) return Math.round(v * 10) / 10;
      }
    }
    return null;
  };
  const bullish = pct('bullish');
  const neutral = pct('neutral');
  const bearish = pct('bearish');
  // 至少要抓到多空兩端，且總和大致合理，才算有效
  if (bullish == null || bearish == null) return null;
  const sum = bullish + (neutral || 0) + bearish;
  if (sum < 80 || sum > 120) return null;
  // 日期：抓 "as of MM/DD/YYYY" 或 "Week ending MM/DD/YYYY" 或 ISO
  let asof = null;
  const dm = text.match(/(?:as of|week ending|ending|reported)[^0-9]{0,20}([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i)
    || text.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  if (dm) asof = dm[1];
  const spread = Math.round((bullish - bearish) * 10) / 10;
  return { bullish, neutral: neutral == null ? Math.round((100 - bullish - bearish) * 10) / 10 : neutral, bearish, spread, asof };
}

function snippet(text) {
  // 取含 bullish 附近的一段，方便看欄位樣貌
  const i = text.toLowerCase().indexOf('bullish');
  if (i >= 0) return text.slice(Math.max(0, i - 120), i + 400);
  return text.slice(0, 500);
}

function respond(status, body, cors) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(body) };
}
