/** Cloudflare Pages Function — 路徑 /api/telegram（Telegram 通知代理，POST {text, bot?, chat?}） */
export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const envBot = (env && env.TELEGRAM_BOT_TOKEN) || '';
  const envChat = (env && env.TELEGRAM_CHAT_ID) || '';
  if (request.method === 'GET') {
    const { searchParams } = new URL(request.url);
    if (searchParams.get('health') === '1') {
      return json({ ok: true, provider: 'cloudflare-telegram', hasEnvBot: !!envBot, hasEnvChat: !!envChat }, 200, cors);
    }
    return json({ error: 'POST only' }, 405, cors);
  }
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
  let body = {};
  try { body = await request.json(); } catch (_) { return json({ error: 'invalid json' }, 400, cors); }
  const bot = String(body.bot || envBot || '');
  const chat = String(body.chat || envChat || '');
  const text = String(body.text || '').slice(0, 4000);
  if (!text) return json({ error: 'text required' }, 400, cors);
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,60}$/.test(bot)) return json({ error: 'bot token 格式錯誤或未設定' }, 400, cors);
  if (!/^-?\d{4,20}$/.test(chat)) return json({ error: 'chat_id 格式錯誤或未設定' }, 400, cors);
  try {
    const r = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await r.json();
    return json(data, r.ok ? 200 : r.status, cors);
  } catch (e) {
    return json({ error: e.message || 'Telegram 連線失敗' }, 502, cors);
  }
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}
