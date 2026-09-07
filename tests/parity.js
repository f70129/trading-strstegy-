#!/usr/bin/env node
/**
 * 跨語言一致性檢核：同一組合成資料，JS 引擎與 Python 引擎的回測結果必須完全相同。
 *   node tests/parity.js
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-parity-'));
const jsOut = path.join(tmp, 'js.json'), pyOut = path.join(tmp, 'py.json');
function run(cmd, env) {
  try { execSync(cmd, { env: Object.assign({}, process.env, env), stdio: 'pipe' }); }
  catch (e) { console.log(String(e.stdout || '')); console.log(String(e.stderr || '')); console.log(`❌ 指令失敗：${cmd}`); process.exit(1); }
}
run(`node ${path.join(root, 'tests', 'smartmoney-core.test.js')}`, { SM_PARITY_OUT: jsOut });
run(`python3 ${path.join(root, 'smartmoney_engine.py')} --selftest`, { SM_PARITY_OUT: pyOut });
const a = JSON.parse(fs.readFileSync(jsOut, 'utf8')), b = JSON.parse(fs.readFileSync(pyOut, 'utf8'));

let diffs = 0;
function cmp(pathStr, x, y) {
  if (typeof x === 'number' && typeof y === 'number') { if (Math.abs(x - y) > 1e-9) { diffs++; console.log(`❌ ${pathStr}: js=${x} py=${y}`); } return; }
  if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) { diffs++; console.log(`❌ ${pathStr}: 長度 ${x.length} vs ${y.length}`); return; } x.forEach((v, i) => cmp(`${pathStr}[${i}]`, v, y[i])); return; }
  if (x && y && typeof x === 'object' && typeof y === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) cmp(`${pathStr}.${k}`, x[k], y[k]); return; }
  if (x !== y) { diffs++; console.log(`❌ ${pathStr}: js=${JSON.stringify(x)} py=${JSON.stringify(y)}`); }
}
cmp('parity', a, b);
for (const k of Object.keys(a)) if (!['grid', 'futopt', 'futtick'].includes(k)) console.log(`seed ${k}: 逐筆 ${a[k].nTrades} 筆，交易 ${a[k].trades} 筆，損益 ${a[k].pnlPts} 點，SMI ${a[k].lastSmi}  ${diffs ? '' : '✅ JS = Python'}`);
console.log(`網格 ${a.grid.length} 組${diffs ? '' : ' ✅ 排名與損益一致'}`);
console.log(diffs ? `\n❌ 共 ${diffs} 處不一致` : '\n✅ 跨語言一致性檢核通過：JS 與 Python 引擎結果完全相同');
process.exit(diffs ? 1 : 0);
