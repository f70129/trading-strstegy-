// 一致性檢核：同一份資料，edge_engine.py 與 js/edge-core.js 的回測結果必須一致
// 用法：node tests/edge-parity.js
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const EC = require('../js/edge-core.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-parity-'));
const root = path.join(__dirname, '..');
const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(root)})
import edge_engine as E
out = {}
for name, edge, seed in (("flow", 0.35, 12), ("random", 0.0, 11)):
    days = E.synthetic_days(160, seed=seed, edge=edge)
    p = E.merge_params({"minTrainDays": 40, "refitDays": 20})
    r = E.run_backtest(days, p, name, ${JSON.stringify(path.join(dir, 'm.json'))})
    out[name] = {"days": days, "params": p, "result": r}
json.dump(out, open(${JSON.stringify(path.join(dir, 'fx.json'))}, "w"))
`;
execFileSync('python3', ['-c', py], { stdio: 'inherit' });
const fx = JSON.parse(fs.readFileSync(path.join(dir, 'fx.json'), 'utf8'));

let fails = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? '✅' : '❌') + ' ' + name + ' ' + extra); if (!cond) fails++; };
const near = (a, b, tol) => (a == null && b == null) || Math.abs(a - b) <= tol;

(async () => {
  for (const name of Object.keys(fx)) {
    const { days, params, result: P } = fx[name];
    const J = await EC.runBacktest(days, params, name);
    ok(`[${name}] 樣本數`, J.samples === P.samples && J.oosSamples === P.oosSamples, `${J.samples}/${P.samples}`);
    ok(`[${name}] Brier`, near(J.probability.brierModel, P.probability.brierModel, 1e-4), `${J.probability.brierModel} / ${P.probability.brierModel}`);
    ok(`[${name}] 交易筆數`, Math.abs(J.trades.n - P.trades.n) <= 1, `${J.trades.n} / ${P.trades.n}`);
    ok(`[${name}] 平均淨點數`, near(J.trades.avgNetPts, P.trades.avgNetPts, 0.05), `${J.trades.avgNetPts} / ${P.trades.avgNetPts}`);
    ok(`[${name}] t 值`, near(J.trades.tStat, P.trades.tStat, 0.05), `${J.trades.tStat} / ${P.trades.tStat}`);
    ok(`[${name}] 權重`, J.weights.every((w, i) => near(w.coef, P.weights[i].coef, 1e-3)));
    ok(`[${name}] 結論`, J.verdict.edgeFound === P.verdict.edgeFound, J.verdict.label);
  }
  // CSV 解析
  const csv = 'datetime,open,high,low,close,volume\n' + Array.from({ length: 40 }, (_, i) => {
    const m = 525 + i; return `2026/11/10 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')},${100 + i},${101 + i},${99 + i},${100 + i},5`;
  }).join('\n') + '\n2026/11/10 15:00,1,1,1,1,1';
  const cd = EC.parseCsvDays(csv);
  ok('CSV 解析（只取日盤）', cd.length === 1 && cd[0].bars.length === 40 && cd[0].date === '2026-11-10');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
  process.exit(fails ? 1 : 0);
})();
