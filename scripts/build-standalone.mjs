// 產生獨立版回測看板：把 js/smartmoney-core.js、js/edge-core.js 內嵌進 backtest.html → standalone/tx-edge-backtest.html
// 用法：node scripts/build-standalone.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let html = read('backtest.html');
const stamp = new Date().toISOString().slice(0, 10);
for (const src of ['js/smartmoney-core.js', 'js/edge-core.js']) {
  const tag = `<script src="${src}"></script>`;
  if (!html.includes(tag)) throw new Error(`backtest.html 找不到 ${tag}`);
  const code = read(src).replace(/<\/script/gi, '<\\/script');
  html = html.replace(tag, () => `<script>/* ${src}（內嵌） */\n${code}\n</script>`);
}
html = html
  .replace('<link rel="icon" href="icon.svg" type="image/svg+xml">\n', '')
  .replace('<link rel="apple-touch-icon" href="icon.svg">\n', '')
  .replace('<title>台指機率優勢回測</title>', `<title>台指機率優勢回測（獨立版）</title>\n<!-- 獨立版 build ${stamp}：由 scripts/build-standalone.mjs 產生，請勿直接編輯 -->`)
  .replace('<h1>🎯 台指期機率優勢回測</h1>', `<h1>🎯 台指期機率優勢回測 <span class="sub">獨立版 ${stamp}</span></h1>`);
if (/src="js\//.test(html)) throw new Error('仍有未內嵌的本地腳本');
mkdirSync(join(root, 'standalone'), { recursive: true });
const out = join(root, 'standalone', 'tx-edge-backtest.html');
writeFileSync(out, html);
console.log(`已產生 ${out}（${(html.length / 1024).toFixed(0)} KB）`);
