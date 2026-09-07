/**
 * Netlify Function — Telegram 通知代理（smartmoney.html 訊號推播備援）
 *
 * 瀏覽器一般可直接呼叫 api.telegram.org（有 CORS），此函式用於：
 *   1. 手機 / 公司網路擋 telegram 網域時的備援
 *   2. 不想把 Bot Token 存在瀏覽器 → 在 Netlify 環境變數設 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 *
 * POST body: { text, bot?, chat? }   （bot / chat 未帶時使用環境變數）
 * GET ?health=1 → 回報是否已設定環境變數
 */
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const envBot = process.env.TELEGRAM_BOT_TOKEN || '';
  const envChat = process.env.TELEGRAM_CHAT_ID || '';

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.health === '1') {
      return respond(200, { ok: true, provider: 'netlify-telegram', hasEnvBot: !!envBot, hasEnvChat: !!envChat }, cors);
    }
    return respond(405, { error: 'POST only' }, cors);
  }
  if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' }, cors);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return respond(400, { error: 'invalid json' }, cors); }
  const bot = String(body.bot || envBot || '');
  const chat = String(body.chat || envChat || '');
  const text = String(body.text || '').slice(0, 4000);
  if (!text) return respond(400, { error: 'text required' }, cors);
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,60}$/.test(bot)) return respond(400, { error: 'bot token 格式錯誤或未設定' }, cors);
  if (!/^-?\d{4,20}$/.test(chat)) return respond(400, { error: 'chat_id 格式錯誤或未設定' }, cors);

  try {
    const r = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await r.json();
    return respond(r.ok ? 200 : r.status, data, cors);
  } catch (e) {
    return respond(502, { error: e.message || 'Telegram 連線失敗' }, cors);
  }
};

function respond(status, body, cors) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(body) };
}
