#!/usr/bin/env node
/**
 * js/smartmoney-core.js 單元測試（無需網路）
 *   node tests/smartmoney-core.test.js
 * 環境變數 SM_PARITY_OUT 指定跨語言比對輸出檔（預設 data/parity_js.json）
 */
const path = require('path');
const fs = require('fs');
const SM = require(path.join(__dirname, '..', 'js', 'smartmoney-core.js'));

let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };

ok('分類：TX 10 口 = big', SM.classify('TX', 10) === 'big');
ok('分類：TX 9 口 = mid / TX 1 口 = small / MTX = small', SM.classify('TX', 9) === 'mid' && SM.classify('TX', 1) === 'small' && SM.classify('MXF', 99) === 'small');
ok('自訂門檻 bigLot=20 → TX 15 口 = mid', SM.classify('TX', 15, SM.mergeParams({ bigLot: 20 })) === 'mid');
ok('契約權重', SM.contractWeight('MXF') === 0.25 && SM.contractWeight('TMFI6') === 0.025 && SM.contractWeight('TXF') === 1 && SM.contractWeight('ZZZ') === 0);
ok('Tick Rule', SM.tickSide(101, 100, 0) === 1 && SM.tickSide(99, 100, 0) === -1 && SM.tickSide(100, 100, -1) === -1 && SM.tickSide(100, null, 0) === 0);
const t = SM.parseTickTime('2026-09-07 08:45:30.500');
ok('時間解析（含毫秒）', t.minute === 525 && t.ms === 31530500 && t.date === '2026-09-07');
ok('時間解析（僅日期）', SM.parseTickTime('2026-09-07', 600).minute === 600);
ok('近月契約排除價差', SM.selectNearContract([{ contract_date: '202609/202610', volume: 999 }, { contract_date: '202609', volume: 10 }, { contract_date: '202610', volume: 5 }]) === '202609');

// 快照差量
const prev = { close: 24000, total_volume: 1000, total_amount: 1000 * 24000 * 200 };
const cur = { close: 24001, total_volume: 1100, volume: 5, TickType: 0, buy_price: 24000, sell_price: 24001, total_amount: prev.total_amount + 100 * 24000.9 * 200, date: '2026-09-07 09:00:10' };
const st = SM.snapshotToTrades(prev, cur, 'TXF');
ok('快照差量：取樣 5 口 + 未取樣 95 口(區間均價偏買)', st.length === 2 && st[0].volume === 5 && st[0].side === 1 && st[1].volume === 95 && st[1].side === 1 && st[1].forceSmall === true);
ok('未取樣量區間均價偏賣 → -1', SM.snapshotToTrades(prev, Object.assign({}, cur, { total_amount: prev.total_amount + 100 * 24000.1 * 200 }), 'TXF')[1].side === -1);
ok('TickType=2 → 內盤賣', SM.snapshotToTrades(prev, Object.assign({}, cur, { TickType: 2, total_amount: undefined }), 'TXF')[0].side === -1);
ok('首次快照（無 prev）不產生成交', SM.snapshotToTrades(null, cur, 'TXF').length === 0);
ok('累積量未變不產生成交', SM.snapshotToTrades(prev, Object.assign({}, cur, { total_volume: 1000 }), 'TXF').length === 0);
{
  const fb = new SM.FlowBook({});
  fb.addTrades(st);
  ok('FlowBook：取樣 5 口歸中單、未取樣 95 口不計入大小單', fb.totals.bigBuy === 0 && fb.totals.midBuy === 5 && fb.totals.smallBuy === 0 && fb.totals.unsBuy === 95 && fb.totals.trades === 1);
}

// 盤中逐筆 TaiwanFutOptTick 解析
{
  const rows = [
    { date: '2026-09-07', Time: '08:45:00.123', Close: [47300, 47301], Volume: [3, 12], futopt_id: 'TXFR1', TickType: 1 },
    { date: '2026-09-07', Time: '08:45:01.500', Close: '[47299]', Volume: '[2]', futopt_id: 'TXFR1', TickType: 2 },
    { date: '2026-09-07', Time: '084502', Close: 47299, Volume: 1, futopt_id: 'TXFR1', TickType: 0 },
  ];
  const r1 = SM.parseFutOptTickRows(rows, 'TXFR1', null);
  ok('逐筆解析：陣列 / 字串 / 單值三種格式共 4 筆', r1.trades.length === 4 && r1.trades[1].volume === 12 && r1.trades[1].side === 1 && r1.trades[2].side === -1);
  ok('逐筆解析：TickType=0 用 Tick Rule（平盤沿用前一筆賣）', r1.trades[3].side === -1 && r1.trades[3].minute === 525 && r1.trades[3].ms === 31502000);
  const r2 = SM.parseFutOptTickRows(rows.concat([{ date: '2026-09-07', Time: '08:45:03', Close: [47305], Volume: [20], TickType: 1 }]), 'TXFR1', r1.cursor);
  ok('逐筆解析：累加式回傳只處理新增列', r2.trades.length === 1 && r2.trades[0].volume === 20 && r2.cursor.n === 4);
  ok('逐筆解析：列數變少視為重置從頭處理', SM.parseFutOptTickRows(rows.slice(0, 1), 'TXFR1', r2.cursor).trades.length === 2);
  ok('逐筆解析：MXFR1 歸類小台', SM.parseFutOptTickRows(rows, 'MXFR1', null).trades[0].product === 'MTX');
  ok('時間格式 HHMMSSmmm', SM.parseFutOptTime('2026-09-07', '110759569').ms === ((11 * 60 + 7) * 60 + 59) * 1000 + 569);
}

// 備援逐筆 TaiwanFuturesTick 增量解析
{
  const rows = [
    { date: '2026-09-07 08:45:00.100', futures_id: 'TX', contract_date: '202609', price: 47300, volume: 3 },
    { date: '2026-09-07 08:45:01.200', futures_id: 'TX', contract_date: '202609', price: 47305, volume: 12 },
    { date: '2026-09-07 08:45:02.000', futures_id: 'TX', contract_date: '202610', price: 47400, volume: 2 },
    { date: '2026-09-07 08:45:03.000', futures_id: 'TX', contract_date: '202609', price: 47301, volume: 1 },
  ];
  const r1 = SM.parseFuturesTickRows(rows, 'TX', null);
  ok('明細表解析：取近月、排除遠月，Tick Rule 定方向', r1.trades.length === 3 && r1.cursor.near === '202609' && r1.trades[1].side === 1 && r1.trades[2].side === -1);
  const r2 = SM.parseFuturesTickRows(rows.concat([{ date: '2026-09-07 08:45:04.000', futures_id: 'TX', contract_date: '202609', price: 47310, volume: 20 }]), 'TX', r1.cursor);
  ok('明細表解析：累加式只處理新增列', r2.trades.length === 1 && r2.trades[0].volume === 20 && r2.trades[0].side === 1);
  ok('明細表解析：小台換算前歸類 MTX', SM.parseFuturesTickRows(rows, 'MTX', null).trades[0].product === 'MTX');
}

// 近月契約代碼
ok('近月契約碼 2026-09-07 = TXFI6', SM.nearMonthContract('TXF', new Date(2026, 8, 7)) === 'TXFI6');
ok('結算後改次月 2026-09-17 15:00 = TXFJ6', SM.nearMonthContract('TXF', new Date(2026, 8, 17, 15)) === 'TXFJ6');
ok('12月結算後跨年 = MXFA7', SM.nearMonthContract('MXF', new Date(2026, 11, 20)) === 'MXFA7');
ok('到期排序鍵遞增', SM.contractExpiryKey('TXFI6') < SM.contractExpiryKey('TXFJ6') && SM.contractExpiryKey('TXFJ6') < SM.contractExpiryKey('TXFC7'));

// 漲跌家數（市場廣度）解析與過濾
{
  const rows = [
    { date: '2026-09-11 09:01:05', '上漲家數': 800, '下跌家數': 120, '指數': 24000 },
    { date: '2026-09-11 09:01:10', UpNum: 790, DownNum: 130 },
    { date: '2026-09-11 09:02:00', rise: 600, fall: 300 },
    { date: '2026-09-11 09:03:00', TradeVolume: 123, '漲跌家數': 450 },
  ];
  const b = SM.parseBreadthRows(rows);
  ok('漲跌家數解析：中文/英文/直接淨值欄位', b.byMinute[541] === 660 && b.byMinute[542] === 300 && b.byMinute[543] === 450);
  const trB = SM.rowsToTrades(SM.syntheticDay(7).rows);
  const barsB = SM.buildBars(trB, {});
  const blockLong = {}; barsB.forEach(x => blockLong[x.minute] = 9999);
  const rL = SM.backtestBars(barsB, SM.mergeParams({ breadthFilter: true, breadthLimit: 700 }), blockLong);
  ok('漲跌家數過濾：淨漲家數過多 → 不做多', rL.trades.filter(t => t.side > 0).length === 0);
  const blockShort = {}; barsB.forEach(x => blockShort[x.minute] = -9999);
  const rS = SM.backtestBars(barsB, SM.mergeParams({ breadthFilter: true, breadthLimit: 700 }), blockShort);
  ok('漲跌家數過濾：淨跌家數過多 → 不做空', rS.trades.filter(t => t.side < 0).length === 0);
  ok('漲跌家數過濾：關閉時不影響', SM.backtestBars(barsB, {}, blockLong).trades.length === SM.backtestDay(trB, {}).trades.length);
}

// 合成資料 → 回測
const syn = SM.syntheticDay(7);
const trades = SM.rowsToTrades(syn.rows);
ok('合成逐筆數量與排序', trades.length > 5000 && trades.every((x, i) => i === 0 || x.ms >= trades[i - 1].ms), `${trades.length} 筆`);
ok('夜盤過濾：daySessionOnly 排除 08:45 前 / 13:45 後', SM.rowsToTrades({ TX: [{ date: '2026-09-07 07:00:00', contract_date: '202609', price: 1, volume: 1 }, { date: '2026-09-07 09:00:00', contract_date: '202609', price: 1, volume: 1 }] }).length === 1);
const r = SM.backtestDay(trades, {});
ok('回測 bars/series', r.bars.length >= 290 && r.series.length === r.bars.length);
let agree = 0, n = 0;
r.series.forEach((s, i) => { if (syn.regime[i] && Math.abs(s.winBig) > 5) { n++; if (Math.sign(s.winBig) === syn.regime[i]) agree++; } });
ok(`大單淨流與隱含趨勢一致率 ${(agree / n * 100).toFixed(0)}% (> 58%)`, agree / n > 0.58);
ok('損益恆等式', Math.abs(r.trades.reduce((s, x) => s + x.pnl, 0) - r.stats.pnlPts) < 1e-6 && r.trades.every(x => Math.abs(((x.exit - x.entry) * x.side - 1.5) - x.pnl) < 1e-6));
ok('停損虧損上限', r.trades.filter(x => x.reason === 'stop').every(x => x.pnl >= -(30 + 1.5) - 1e-6));
ok('停利獲利 = 停利點數 − 成本', r.trades.filter(x => x.reason === 'target').every(x => Math.abs(x.pnl - (60 - 1.5)) < 1e-6));
ok('每日交易次數 ≤ maxTradesPerDay', r.trades.length <= 6);
ok('進場時間 < entryCutoff，且出場 ≤ flatAt', r.trades.every(x => SM.hhmmToMin(x.entryTime) < SM.hhmmToMin('13:00') && SM.hhmmToMin(x.exitTime) <= SM.hhmmToMin('13:40')));
ok('趨勢濾網：多單進場價 ≥ VWAP', r.events.filter(e => e.type === 'entry').every(e => { const s = r.series.find(x => x.time === e.time); return e.side > 0 ? e.price >= s.vwap : e.price <= s.vwap; }));
ok('關閉趨勢濾網 → 交易數不少於開啟時', SM.backtestDay(trades, { trendFilter: false }).trades.length >= r.trades.length);
const g = SM.gridSearch([{ date: 'a', trades }], { bigLot: [10], windowMin: [10], zEntry: [1.5], stopPts: [30], targetPts: [60] }, {});
ok('網格單組 = 單日回測', g.length === 1 && g[0].pnlPts === r.stats.pnlPts && g[0].trades === r.stats.trades);
const fb = new SM.FlowBook({}); fb.addTrades(trades);
const m = SM.sentiment(fb.totals);
ok('大戶心態評分', m.score >= 0 && m.score <= 100 && m.label !== '樣本不足', JSON.stringify(m));
ok('樣本不足判定', SM.sentiment({ bigBuy: 5, bigSell: 3 }).label === '樣本不足');
ok('背離文字：大戶買散戶賣', SM.sentiment({ bigBuy: 80, bigSell: 20, smallBuy: 20, smallSell: 80 }).divergence.includes('偏多'));

// 跨語言比對輸出
const parity = {};
for (const seed of [1, 2, 3, 7, 42, 99]) {
  const tr = SM.rowsToTrades(SM.syntheticDay(seed).rows);
  const rr = SM.backtestDay(tr, {});
  const b = new SM.FlowBook({}); b.addTrades(tr);
  const totals = {}; for (const [k, v] of Object.entries(b.totals)) totals[k] = SM.round(v, 3);
  parity[String(seed)] = { trades: rr.stats.trades, pnlPts: rr.stats.pnlPts, nTrades: tr.length, lastSmi: rr.series[rr.series.length - 1].smi, totals };
}
const days = [1, 2, 3].map(s => ({ date: 'd' + s, trades: SM.rowsToTrades(SM.syntheticDay(s).rows) }));
const gg = SM.gridSearch(days, { bigLot: [5, 10], windowMin: [5, 10], zEntry: [1, 1.5], stopPts: [30], targetPts: [60] }, {});
parity.futtick = SM.parseFuturesTickRows([
  { date: '2026-09-07 08:45:00.100', futures_id: 'TX', contract_date: '202609', price: 47300, volume: 3 },
  { date: '2026-09-07 08:45:01.200', futures_id: 'TX', contract_date: '202609', price: 47305, volume: 12 },
  { date: '2026-09-07 08:45:02.000', futures_id: 'TX', contract_date: '202610', price: 47400, volume: 2 },
  { date: '2026-09-07 08:45:03.000', futures_id: 'TX', contract_date: '202609', price: 47301, volume: 1 },
], 'TX', null).trades;
parity.futopt = SM.parseFutOptTickRows([
  { date: '2026-09-07', Time: '08:45:00.123', Close: [47300, 47301], Volume: [3, 12], TickType: 1 },
  { date: '2026-09-07', Time: '08:45:01.500', Close: '[47299]', Volume: '[2]', TickType: 2 },
  { date: '2026-09-07', Time: '084502', Close: 47299, Volume: 1, TickType: 0 },
], 'TXFR1', null).trades;
parity.grid = gg.map(x => ({ params: x.params, pnlPts: x.pnlPts, trades: x.trades, maxDD: x.maxDD }));
const out = process.env.SM_PARITY_OUT || path.join(__dirname, '..', 'data', 'parity_js.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(parity, null, 1));
console.log(`\n單元測試完成，失敗 ${fails} 項；跨語言比對輸出 ${out}`);
process.exit(fails ? 1 : 0);
