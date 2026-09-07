/**
 * 台指期「聰明錢」大單 / 小單流向引擎（核心邏輯，瀏覽器與 Node 共用）
 *
 * 用途：
 *   1. 逐筆成交依商品 + 口數分類：大單（大戶）、中單、小單（散戶：小台 / 微台 / 大台 1 口）
 *   2. 以 Tick Rule 判定主動買 / 主動賣（FinMind 逐筆資料沒有內外盤欄位）
 *   3. 聚合成 1 分 K，計算大戶淨流、散戶淨流、SMI（Smart Money Index）
 *   4. 產生順勢跟單訊號，並以模擬盤（PaperTrader）計算損益
 *   5. 回測 / 參數網格搜尋，找出最佳參數
 *
 * 設計原則：純函式、無 DOM、無網路；同一份邏輯在 smartmoney_engine.py 有 1:1 對應，
 *          tests/ 內有跨語言一致性檢核（同一組合成資料，兩邊損益必須完全相同）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SmartMoney = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.1.0';

  /** 契約規模換算為「大台等值口數」：大台 200 元/點、小台 50、微台 5 */
  const CONTRACT_WEIGHT = { TX: 1, MTX: 0.25, TMF: 0.025 };

  /** 快照 / 期交所代碼 → FinMind 逐筆代碼 */
  const PRODUCT_ALIAS = { TXF: 'TX', MXF: 'MTX', TMF: 'TMF', TX: 'TX', MTX: 'MTX' };

  const POINT_VALUE_NTD = 200; // 大台 1 點 = 200 元

  const DEFAULT_PARAMS = {
    bigLot: 10,          // 大台單筆 >= bigLot 口 → 大單（大戶）
    midLot: 3,           // 大台單筆 midLot..bigLot-1 口 → 中單（中實戶）
    windowMin: 10,       // 淨流量觀察窗（分鐘）
    zEntry: 1.5,         // SMI 進場門檻
    zExit: 0,            // SMI 反向穿越出場門檻（0 = 轉負/轉正即出場）
    stopPts: 30,         // 停損（點）
    targetPts: 60,       // 停利（點）
    retailWeight: 0.5,   // 散戶反向權重（SMI = zBig - retailWeight * zRetail）
    trendFilter: true,   // 價格需站在 VWAP 同側才進場
    costPts: 1.5,        // 每趟來回成本（手續費 + 期交稅 + 滑價），以點計
    cooldownMin: 5,      // 出場後冷卻分鐘
    maxTradesPerDay: 6,
    sessionStart: '08:45',
    sessionEnd: '13:45',
    entryCutoff: '13:00', // 之後不再新進場
    flatAt: '13:40',      // 強制平倉
    minBarsForZ: 10,      // 至少幾根 K 才開始計算 z-score
  };

  // ---------- 小工具 ----------
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function round(x, d) { const m = Math.pow(10, d || 0); return Math.round(x * m) / m; }
  function hhmmToMin(s) { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; }
  function minToHHMM(m) { const h = Math.floor(m / 60), mm = m % 60; return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); }
  function mergeParams(p) { return Object.assign({}, DEFAULT_PARAMS, p || {}); }

  function normalizeProduct(id) {
    const s = String(id || '').toUpperCase();
    if (PRODUCT_ALIAS[s]) return PRODUCT_ALIAS[s];
    // 快照代碼如 TXFI6 / MXFI6 / TMFI6
    const head = s.slice(0, 3);
    return PRODUCT_ALIAS[head] || s;
  }

  function contractWeight(product) {
    return CONTRACT_WEIGHT[normalizeProduct(product)] || 0;
  }

  /**
   * 解析 FinMind 逐筆的 date 欄位。
   * 可能格式："2026-09-05 08:45:00.123"、"2026-09-05 08:45:00"、"2026-09-05"（無時間）
   * 回傳 { date, minute(分鐘序, 0-1439), ms(當日毫秒) }
   */
  function parseTickTime(dateStr, fallbackMinute) {
    const s = String(dateStr || '').trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?/);
    if (!m) return { date: s.slice(0, 10), minute: fallbackMinute || 0, ms: (fallbackMinute || 0) * 60000 };
    if (m[2] == null) return { date: m[1], minute: fallbackMinute || 0, ms: (fallbackMinute || 0) * 60000 };
    const h = Number(m[2]), mi = Number(m[3]), se = Number(m[4] || 0);
    const frac = m[5] ? Number(('0.' + m[5])) : 0;
    return { date: m[1], minute: h * 60 + mi, ms: ((h * 60 + mi) * 60 + se) * 1000 + Math.round(frac * 1000) };
  }

  /**
   * 挑近月契約：排除價差單（contract_date 含 "/"），取成交量最大的 contract_date。
   */
  function selectNearContract(rows) {
    const vol = {};
    for (const r of rows) {
      const c = String(r.contract_date || '');
      if (!c || c.includes('/')) continue;
      vol[c] = (vol[c] || 0) + Number(r.volume || 0);
    }
    const keys = Object.keys(vol);
    if (!keys.length) return null;
    keys.sort((a, b) => vol[b] - vol[a] || (a < b ? -1 : 1));
    return keys[0];
  }

  /**
   * Tick Rule：上漲 tick = 主動買(+1)，下跌 tick = 主動賣(-1)，平盤沿用上一筆方向。
   */
  function tickSide(price, lastPrice, lastSide) {
    if (lastPrice == null) return 0;
    if (price > lastPrice) return 1;
    if (price < lastPrice) return -1;
    return lastSide || 0;
  }

  /**
   * 分類：'big' 大單、'mid' 中單、'small' 小單（散戶）
   * 規則（可調）：大台 >= bigLot 口 → big；大台 midLot..bigLot-1 → mid；
   *              大台 < midLot、小台、微台 一律 small。
   */
  function classify(product, volume, params) {
    const p = params || DEFAULT_PARAMS;
    const prod = normalizeProduct(product);
    const v = Number(volume) || 0;
    if (prod === 'TX') {
      if (v >= p.bigLot) return 'big';
      if (v >= p.midLot) return 'mid';
      return 'small';
    }
    return 'small';
  }

  /**
   * 把 FinMind TaiwanFuturesTick 原始列轉成統一的 trade 物件。
   * rowsByProduct: { TX: rows, MTX: rows, TMF: rows }（每個商品各自取近月）
   * 回傳依時間排序的 trades：{ ms, minute, product, price, volume, side }
   * 注意：side 只用「同商品」的價格序列判定（各商品各自跑 tick rule）。
   */
  function rowsToTrades(rowsByProduct, opts) {
    const o = Object.assign({ daySessionOnly: true, start: '08:45', end: '13:45' }, opts || {});
    const startMin = hhmmToMin(o.start), endMin = hhmmToMin(o.end);
    const out = [];
    for (const [productRaw, rows] of Object.entries(rowsByProduct || {})) {
      if (!rows || !rows.length) continue;
      const product = normalizeProduct(productRaw);
      const near = selectNearContract(rows);
      let lastPrice = null, lastSide = 0, idx = 0;
      const seq = [];
      for (const r of rows) {
        const c = String(r.contract_date || '');
        if (near && c !== near) continue;
        const t = parseTickTime(r.date, 0);
        seq.push({ t, r, i: idx++ });
      }
      // FinMind 通常已按時間排序；保險起見用穩定排序
      seq.sort((a, b) => a.t.ms - b.t.ms || a.i - b.i);
      for (const { t, r } of seq) {
        if (o.daySessionOnly && (t.minute < startMin || t.minute > endMin)) continue;
        const price = Number(r.price), volume = Number(r.volume) || 0;
        if (!Number.isFinite(price) || volume <= 0) continue;
        const side = tickSide(price, lastPrice, lastSide);
        lastPrice = price; lastSide = side;
        out.push({ ms: t.ms, minute: t.minute, product, price, volume, side });
      }
    }
    out.sort((a, b) => a.ms - b.ms);
    return out;
  }

  // ---------- 1 分 K 聚合 ----------
  function newBar(minute) {
    return {
      minute, time: minToHHMM(minute),
      open: null, high: -Infinity, low: Infinity, close: null,
      vol: 0, amt: 0,            // 大台價格成交量與金額（VWAP 用）
      bigBuy: 0, bigSell: 0,     // 大單（大台口數）
      midBuy: 0, midSell: 0,     // 中單（大台口數）
      smallBuy: 0, smallSell: 0, // 小單（換算為大台等值口數）
      bigTrades: 0, smallTrades: 0,
      unkBuy: 0, unkSell: 0,     // 無法判定方向者（side=0）
      unsBuy: 0, unsSell: 0,     // 即時快照未取樣到的量（不計入大小單）
    };
  }

  /**
   * FlowBook：即時累加逐筆並維護 1 分 K。
   * 只用 TX 的價格做 OHLC / VWAP（主商品）；小台微台只貢獻流量。
   */
  class FlowBook {
    constructor(params) {
      this.params = mergeParams(params);
      this.bars = [];
      this._byMinute = new Map();
      this.totals = { bigBuy: 0, bigSell: 0, midBuy: 0, midSell: 0, smallBuy: 0, smallSell: 0, unsBuy: 0, unsSell: 0, bigTrades: 0, smallTrades: 0, trades: 0 };
      this.lastPrice = null;
    }
    barFor(minute) {
      let b = this._byMinute.get(minute);
      if (!b) {
        b = newBar(minute);
        this._byMinute.set(minute, b);
        this.bars.push(b);
        if (this.bars.length > 1 && this.bars[this.bars.length - 2].minute > minute) {
          this.bars.sort((x, y) => x.minute - y.minute);
        }
      }
      return b;
    }
    addTrade(tr) {
      const p = this.params;
      const b = this.barFor(tr.minute);
      const product = normalizeProduct(tr.product);
      const w = contractWeight(product);
      if (!w) return;
      if (product === 'TX') {
        if (b.open == null) b.open = tr.price;
        b.high = Math.max(b.high, tr.price);
        b.low = Math.min(b.low, tr.price);
        b.close = tr.price;
        b.vol += tr.volume; b.amt += tr.volume * tr.price;
        this.lastPrice = tr.price;
      }
      const eq = tr.volume * w;
      const side = tr.side;
      const t = this.totals;
      if (tr.forceSmall) { // 快照未取樣量：只記錄，不影響大戶 / 散戶統計
        if (side >= 0) { b.unsBuy += eq; t.unsBuy += eq; } else { b.unsSell += eq; t.unsSell += eq; }
        return;
      }
      const cls = classify(product, tr.volume, p);
      t.trades++;
      if (cls === 'big') {
        b.bigTrades++; t.bigTrades++;
        if (side > 0) { b.bigBuy += eq; t.bigBuy += eq; } else if (side < 0) { b.bigSell += eq; t.bigSell += eq; } else { b.unkBuy += eq / 2; b.unkSell += eq / 2; }
      } else if (cls === 'mid') {
        if (side > 0) { b.midBuy += eq; t.midBuy += eq; } else if (side < 0) { b.midSell += eq; t.midSell += eq; }
      } else {
        b.smallTrades++; t.smallTrades++;
        if (side > 0) { b.smallBuy += eq; t.smallBuy += eq; } else if (side < 0) { b.smallSell += eq; t.smallSell += eq; }
      }
    }
    addTrades(trades) { for (const tr of trades) this.addTrade(tr); }
  }

  /** 把整天 trades 直接聚合成 bars（回測用） */
  function buildBars(trades, params) {
    const fb = new FlowBook(params);
    fb.addTrades(trades);
    // 填補沒有 TX 成交的分鐘 close（沿用前值），避免 series 出現 null
    let last = null;
    for (const b of fb.bars) {
      if (b.close == null) { b.open = b.high = b.low = b.close = last; } else last = b.close;
    }
    return fb.bars.filter(b => b.close != null);
  }

  // ---------- 指標序列 ----------
  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
  function std(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
  }

  /**
   * 對 bars 計算：
   *   bigNet / retailNet（每根 K 淨流）、winBig / winRetail（觀察窗累計）
   *   zBig / zRetail（以「今日至今每根淨流之標準差 * sqrt(W)」標準化）
   *   smi = zBig - retailWeight * zRetail
   *   vwap（大台）、cumBig / cumRetail（日累計）
   * 回傳與 bars 等長的陣列（前幾根不足 minBarsForZ 時 z = 0）。
   */
  function computeSeries(bars, params) {
    const p = mergeParams(params);
    const W = Math.max(1, p.windowMin | 0);
    const n = bars.length;
    const out = new Array(n);
    const bigNetArr = [], retNetArr = [];
    let cumBig = 0, cumRet = 0, cumAmt = 0, cumVol = 0;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const bigNet = b.bigBuy - b.bigSell;
      const retNet = b.smallBuy - b.smallSell;
      bigNetArr.push(bigNet); retNetArr.push(retNet);
      cumBig += bigNet; cumRet += retNet;
      cumAmt += b.amt; cumVol += b.vol;
      let winBig = 0, winRet = 0;
      for (let j = Math.max(0, i - W + 1); j <= i; j++) { winBig += bigNetArr[j]; winRet += retNetArr[j]; }
      let zBig = 0, zRet = 0;
      if (i + 1 >= p.minBarsForZ) {
        const sB = std(bigNetArr) * Math.sqrt(W);
        const sR = std(retNetArr) * Math.sqrt(W);
        zBig = sB > 1e-9 ? winBig / sB : 0;
        zRet = sR > 1e-9 ? winRet / sR : 0;
      }
      const smi = zBig - p.retailWeight * zRet;
      out[i] = {
        minute: b.minute, time: b.time, close: b.close,
        bigNet: round(bigNet, 3), retailNet: round(retNet, 3),
        winBig: round(winBig, 3), winRetail: round(winRet, 3),
        zBig: round(zBig, 4), zRetail: round(zRet, 4), smi: round(smi, 4),
        cumBig: round(cumBig, 3), cumRetail: round(cumRet, 3),
        vwap: cumVol > 0 ? round(cumAmt / cumVol, 2) : b.close,
      };
    }
    return out;
  }

  /**
   * 今日大戶心態評分（0-100）與文字判讀。
   * score = 50 + 60 * 大單淨買比 - 20 * 小單淨買比（散戶反向）
   */
  function sentiment(totals) {
    const t = totals || {};
    const bigTot = (t.bigBuy || 0) + (t.bigSell || 0);
    const smTot = (t.smallBuy || 0) + (t.smallSell || 0);
    const bigRatio = bigTot > 0 ? ((t.bigBuy || 0) - (t.bigSell || 0)) / bigTot : 0;
    const smRatio = smTot > 0 ? ((t.smallBuy || 0) - (t.smallSell || 0)) / smTot : 0;
    const score = clamp(50 + 60 * bigRatio - 20 * smRatio, 0, 100);
    let label, tone;
    if (bigTot < 20) { label = '樣本不足'; tone = 'neutral'; }
    else if (score >= 70) { label = '大戶強烈偏多'; tone = 'bull'; }
    else if (score >= 58) { label = '大戶偏多'; tone = 'bull'; }
    else if (score <= 30) { label = '大戶強烈偏空'; tone = 'bear'; }
    else if (score <= 42) { label = '大戶偏空'; tone = 'bear'; }
    else { label = '大戶中性 / 觀望'; tone = 'neutral'; }
    let divergence = '';
    if (bigTot >= 20 && smTot > 0) {
      if (bigRatio > 0.1 && smRatio < -0.1) divergence = '大戶買、散戶賣 → 聰明錢承接，偏多訊號';
      else if (bigRatio < -0.1 && smRatio > 0.1) divergence = '大戶賣、散戶買 → 散戶接刀，偏空訊號';
      else if (bigRatio > 0.1 && smRatio > 0.1) divergence = '大戶散戶同步買，追價需留意過熱';
      else if (bigRatio < -0.1 && smRatio < -0.1) divergence = '大戶散戶同步賣，弱勢盤';
    }
    return {
      score: round(score, 1), label, tone,
      bigRatio: round(bigRatio, 4), retailRatio: round(smRatio, 4),
      bigTotal: round(bigTot, 2), retailTotal: round(smTot, 2), divergence,
    };
  }

  // ---------- 模擬盤 ----------
  /**
   * PaperTrader：以 1 分 K 收盤價 + 指標做順勢跟單。
   * onBar(bar, ind) 回傳事件陣列 [{type:'entry'|'exit', side, price, time, reason, pnl?}]
   * 損益以「點」計，已扣 costPts。
   */
  class PaperTrader {
    constructor(params) {
      this.p = mergeParams(params);
      this.pos = null;   // { side: 1|-1, entry, time, minute, bars }
      this.trades = [];
      this.lastExitMinute = -1e9;
      this.dayTrades = 0;
      this.equity = 0;
      this.peak = 0; this.maxDD = 0;
      this._entryCut = hhmmToMin(this.p.entryCutoff);
      this._flatAt = hhmmToMin(this.p.flatAt);
    }
    _close(bar, price, reason) {
      const pos = this.pos;
      const gross = (price - pos.entry) * pos.side;
      const pnl = round(gross - this.p.costPts, 2);
      const tr = { side: pos.side, entry: pos.entry, exit: price, entryTime: pos.time, exitTime: bar.time, bars: pos.bars, pnl, reason };
      this.trades.push(tr);
      this.equity = round(this.equity + pnl, 2);
      this.peak = Math.max(this.peak, this.equity);
      this.maxDD = Math.max(this.maxDD, round(this.peak - this.equity, 2));
      this.pos = null;
      this.lastExitMinute = bar.minute;
      return { type: 'exit', side: tr.side, price, time: bar.time, reason, pnl, trade: tr };
    }
    onBar(bar, ind) {
      const p = this.p, ev = [];
      const px = bar.close;
      if (px == null) return ev;
      if (this.pos) {
        const pos = this.pos; pos.bars++;
        // 停損 / 停利：用該分鐘高低價判定（觸價成交於停損/停利價）
        const stopPx = pos.entry - pos.side * p.stopPts;
        const tgtPx = pos.entry + pos.side * p.targetPts;
        const hitStop = pos.side > 0 ? bar.low <= stopPx : bar.high >= stopPx;
        const hitTgt = pos.side > 0 ? bar.high >= tgtPx : bar.low <= tgtPx;
        if (hitStop) { ev.push(this._close(bar, stopPx, 'stop')); return ev; }
        if (hitTgt) { ev.push(this._close(bar, tgtPx, 'target')); return ev; }
        if (bar.minute >= this._flatAt) { ev.push(this._close(bar, px, 'flat')); return ev; }
        const flip = pos.side > 0 ? ind.smi <= -p.zExit : ind.smi >= p.zExit;
        if (flip) { ev.push(this._close(bar, px, 'smi-flip')); return ev; }
        return ev;
      }
      // 無部位 → 檢查進場
      if (bar.minute >= this._entryCut) return ev;
      if (bar.minute - this.lastExitMinute < p.cooldownMin) return ev;
      if (this.dayTrades >= p.maxTradesPerDay) return ev;
      let side = 0;
      if (ind.smi >= p.zEntry) side = 1;
      else if (ind.smi <= -p.zEntry) side = -1;
      if (!side) return ev;
      if (p.trendFilter && ind.vwap != null) {
        if (side > 0 && px < ind.vwap) return ev;
        if (side < 0 && px > ind.vwap) return ev;
      }
      this.pos = { side, entry: px, time: bar.time, minute: bar.minute, bars: 0 };
      this.dayTrades++;
      ev.push({ type: 'entry', side, price: px, time: bar.time, reason: side > 0 ? '大戶淨買 SMI≥門檻' : '大戶淨賣 SMI≤-門檻', smi: ind.smi });
      return ev;
    }
    stats() {
      const t = this.trades, n = t.length;
      const wins = t.filter(x => x.pnl > 0), losses = t.filter(x => x.pnl <= 0);
      const gw = wins.reduce((s, x) => s + x.pnl, 0), gl = -losses.reduce((s, x) => s + x.pnl, 0);
      return {
        trades: n, pnlPts: round(this.equity, 2), pnlNTD: Math.round(this.equity * POINT_VALUE_NTD),
        winRate: n ? round(wins.length / n, 4) : 0,
        avgPts: n ? round(this.equity / n, 2) : 0,
        profitFactor: gl > 0 ? round(gw / gl, 3) : (gw > 0 ? 99 : 0),
        maxDD: this.maxDD,
        avgWin: wins.length ? round(gw / wins.length, 2) : 0,
        avgLoss: losses.length ? round(gl / losses.length, 2) : 0,
      };
    }
  }

  /** 單日回測：trades（逐筆）→ bars → series → PaperTrader */
  function backtestDay(trades, params) {
    const p = mergeParams(params);
    const bars = buildBars(trades, p);
    return backtestBars(bars, p);
  }

  function backtestBars(bars, params) {
    const p = mergeParams(params);
    const series = computeSeries(bars, p);
    const pt = new PaperTrader(p);
    const events = [];
    for (let i = 0; i < bars.length; i++) {
      for (const e of pt.onBar(bars[i], series[i])) events.push(e);
    }
    // 收盤仍有部位 → 以最後一根收盤平倉
    if (pt.pos && bars.length) {
      const last = bars[bars.length - 1];
      events.push(pt._close(last, last.close, 'eod'));
    }
    return { params: p, bars, series, events, trades: pt.trades, stats: pt.stats() };
  }

  /**
   * 多日網格搜尋。
   * days: [{ date, trades }]；grid: { bigLot:[..], windowMin:[..], zEntry:[..], stopPts:[..], targetPts:[..], retailWeight:[..], trendFilter:[..] }
   * 排名依據：總損益(點) 為主，同分看 profitFactor、maxDD。
   */
  function gridSearch(days, grid, base) {
    const g = Object.assign({
      bigLot: [5, 10, 20], windowMin: [5, 10, 15], zEntry: [1, 1.5, 2],
      stopPts: [20, 30], targetPts: [40, 60], retailWeight: [0.5], trendFilter: [true],
    }, grid || {});
    const keys = Object.keys(g);
    const combos = [];
    (function rec(i, cur) {
      if (i === keys.length) { combos.push(Object.assign({}, cur)); return; }
      for (const v of g[keys[i]]) { cur[keys[i]] = v; rec(i + 1, cur); }
    })(0, {});
    // bars 只跟 bigLot / midLot 有關 → 快取
    const barCache = new Map();
    const barsFor = (day, bigLot) => {
      const k = day.date + '|' + bigLot;
      if (!barCache.has(k)) barCache.set(k, buildBars(day.trades, mergeParams(Object.assign({}, base, { bigLot }))));
      return barCache.get(k);
    };
    const results = [];
    for (const c of combos) {
      const p = mergeParams(Object.assign({}, base, c));
      let pnl = 0, n = 0, wins = 0, gw = 0, gl = 0, dd = 0, eq = 0, peak = 0, posDays = 0;
      const perDay = [];
      for (const day of days) {
        const r = backtestBars(barsFor(day, p.bigLot), p);
        pnl += r.stats.pnlPts; n += r.stats.trades;
        for (const t of r.trades) {
          if (t.pnl > 0) { wins++; gw += t.pnl; } else gl -= t.pnl;
          eq = round(eq + t.pnl, 2); peak = Math.max(peak, eq); dd = Math.max(dd, round(peak - eq, 2)); // 逐筆回撤
        }
        if (r.stats.pnlPts > 0) posDays++;
        perDay.push({ date: day.date, pnl: r.stats.pnlPts, trades: r.stats.trades });
      }
      results.push({
        params: c, pnlPts: round(pnl, 2), pnlNTD: Math.round(pnl * POINT_VALUE_NTD), trades: n,
        winRate: n ? round(wins / n, 4) : 0, profitFactor: gl > 0 ? round(gw / gl, 3) : (gw > 0 ? 99 : 0),
        maxDD: round(dd, 2), avgPts: n ? round(pnl / n, 2) : 0, posDays, days: days.length, perDay,
      });
    }
    results.sort((a, b) => b.pnlPts - a.pnlPts || b.profitFactor - a.profitFactor || a.maxDD - b.maxDD);
    return results;
  }

  // ---------- 即時快照 → 取樣成交 ----------
  /**
   * FinMind taiwan_futures_snapshot 約 10 秒一筆，欄位：close, volume(最後一筆成交量),
   * total_volume(累積), buy_price/sell_price(最佳買賣價), TickType(成交種類 1=外盤 2=內盤 0=無法判定)
   *
   * 每次輪詢只看得到「最後一筆」成交的口數與方向 → 用它做分類（取樣），
   * 其餘累積量差額（delta - lastVolume）方向以 quote rule / tick rule 推估，歸入「未取樣」且以小單處理。
   * 回傳 trades 陣列（0~2 筆）。
   */
  function snapshotToTrades(prev, snap, product, opts) {
    const o = Object.assign({ minute: null, attributeRemainder: true }, opts || {});
    if (!snap) return [];
    const price = Number(snap.close);
    const tv = Number(snap.total_volume);
    const lastVol = Number(snap.volume) || 0;
    if (!Number.isFinite(price) || !Number.isFinite(tv)) return [];
    const t = parseTickTime(snap.date, 0);
    const minute = o.minute != null ? o.minute : t.minute;
    const prevTv = prev ? Number(prev.total_volume) : NaN;
    const delta = Number.isFinite(prevTv) ? tv - prevTv : 0;
    if (!prev || delta <= 0) return [];
    let side = 0;
    const tt = Number(snap.TickType != null ? snap.TickType : snap.tick_type);
    if (tt === 1) side = 1; else if (tt === 2) side = -1;
    if (!side) {
      const bp = Number(snap.buy_price), sp = Number(snap.sell_price);
      if (Number.isFinite(bp) && Number.isFinite(sp) && bp > 0 && sp > 0) {
        if (price >= sp) side = 1; else if (price <= bp) side = -1;
      }
    }
    if (!side) side = tickSide(price, Number(prev.close), prev._side || 0);
    snap._side = side;
    const out = [];
    const sampled = Math.min(Math.max(lastVol, 0), delta);
    if (sampled > 0) out.push({ ms: t.ms, minute, product: normalizeProduct(product), price, volume: sampled, side, sampled: true });
    const rest = delta - sampled;
    if (rest > 0 && o.attributeRemainder) {
      // 未取樣量的方向：用區間均價 (Δtotal_amount / Δtotal_volume) 相對買賣中價判定，較「末筆方向」更能代表整段成交
      const restSide = intervalSide(prev, snap, delta) || side;
      out.push({ ms: t.ms, minute, product: normalizeProduct(product), price, volume: rest, side: restSide, sampled: false, forceSmall: true });
    }
    return out;
  }

  /** 由兩次快照的累積金額 / 累積量差，估算區間均價並與中價比較 → +1 / -1 / 0 */
  function intervalSide(prev, snap, delta) {
    const a0 = Number(prev.total_amount), a1 = Number(snap.total_amount);
    if (!Number.isFinite(a0) || !Number.isFinite(a1) || !(delta > 0)) return 0;
    const dAmt = a1 - a0;
    if (!(dAmt > 0)) return 0;
    // 金額欄位可能已乘上契約乘數；用「累積金額 / 累積量 / 收盤價」推估倍率
    const tv = Number(snap.total_volume), px = Number(snap.close);
    if (!(tv > 0) || !(px > 0)) return 0;
    let scale = (a1 / tv) / px;
    scale = scale > 100 ? 200 : scale > 25 ? 50 : scale > 2.5 ? 5 : 1;
    const avg = dAmt / delta / scale;
    const bp = Number(snap.buy_price), sp = Number(snap.sell_price);
    const mid = (Number.isFinite(bp) && Number.isFinite(sp) && bp > 0 && sp > 0) ? (bp + sp) / 2 : Number(prev.close);
    if (!Number.isFinite(mid) || !(mid > 0)) return 0;
    const tol = 0.05; // 5% 檔差以內視為中性
    if (avg > mid + tol) return 1;
    if (avg < mid - tol) return -1;
    return 0;
  }

  // ---------- 近月契約代碼（TAIFEX：A-L = 1-12 月，尾碼為西元年個位）----------
  const MONTH_LETTERS = 'ABCDEFGHIJKL';
  /** 期貨月碼：year 西元年、month0 為 0-11 → 例 (2026,8)=I6 */
  function futuresMonthCode(year, month0) { return MONTH_LETTERS[month0] + String(year % 10); }
  /**
   * 近月契約代碼：prefix 為 TXF/MXF/TMF，date 為 Date（預設 now）。
   * 結算日（第三個週三）14:00 後改用次月。例：2026-09-07 → TXFI6
   */
  function nearMonthContract(prefix, date) {
    const d = date || new Date();
    let y = d.getFullYear(), m = d.getMonth();
    const first = new Date(y, m, 1);
    const wed = 1 + ((3 - first.getDay() + 7) % 7) + 14; // 當月第三個週三的日期
    const settled = d.getDate() > wed || (d.getDate() === wed && d.getHours() >= 14);
    if (settled) { m++; if (m > 11) { m = 0; y++; } }
    return prefix + futuresMonthCode(y, m);
  }
  /** 契約代碼排序鍵（依到期先後）：TXFI6 → 6*12+8 */
  function contractExpiryKey(code) {
    const m = String(code).match(/([A-L])(\d)$/);
    if (!m) return 1e9;
    return Number(m[2]) * 12 + MONTH_LETTERS.indexOf(m[1]);
  }

  // ---------- FinMind 盤中逐筆（dataset=TaiwanFutOptTick，data_id 如 TXFI6）----------
  /**
   * 每列格式（依 FinMind 官方套件 docstring）：
   *   { date:'2026-09-07', Time:'11:07:59.569', Close:[47376,47377] 或 47376, Volume:[1,5] 或 1, futopt_id:'TXFR1', TickType:1 }
   * Close / Volume 可能是陣列、單值或 JSON 字串；TickType 可能是單值或陣列（1=外盤買 2=內盤賣 0=無法判定）。
   * 每次輪詢會回傳當日至今全部逐筆 → 用 cursor 去重：{ n: 已處理列數, key: 最後一列的識別, lastPrice, lastSide }
   * 回傳 { trades, cursor }。
   */
  function toList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('[')) { try { const a = JSON.parse(t); if (Array.isArray(a)) return a; } catch (_) { /* fallthrough */ } }
      if (t.includes(',')) return t.replace(/[\[\]]/g, '').split(',').map(x => Number(x.trim()));
      return [Number(t)];
    }
    if (v == null) return [];
    return [Number(v)];
  }
  function parseFutOptTime(dateStr, timeStr, fallbackMinute) {
    const d = String(dateStr || '').slice(0, 10);
    let t = String(timeStr == null ? '' : timeStr).trim();
    if (!t && /\d{2}:\d{2}/.test(String(dateStr))) return parseTickTime(dateStr, fallbackMinute);
    if (/^\d{5,9}$/.test(t)) { // HHMMSS 或 HHMMSSmmm（可能少前導 0）
      t = t.padStart(t.length <= 6 ? 6 : 9, '0');
      t = `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}${t.length > 6 ? '.' + t.slice(6) : ''}`;
    }
    return parseTickTime(`${d} ${t}`, fallbackMinute);
  }
  function rowKey(r, i) { return `${r.Time ?? r.time ?? r.date ?? ''}|${r.price ?? r.Close ?? ''}|${i}`; }
  function parseFutOptTickRows(rows, product, cursor, opts) {
    const o = Object.assign({ daySessionOnly: false, start: '08:45', end: '13:45' }, opts || {});
    const c = Object.assign({ n: 0, key: null, lastPrice: null, lastSide: 0 }, cursor || {});
    const list = Array.isArray(rows) ? rows : [];
    const prod = normalizeProduct(product);
    const startMin = hhmmToMin(o.start), endMin = hhmmToMin(o.end);
    // 去重：資料為累加式；若列數變少（換日 / 重置）則從頭處理
    let from = c.n;
    if (list.length < c.n || (c.n > 0 && c.key != null && rowKey(list[c.n - 1] || {}, c.n - 1) !== c.key)) from = 0;
    if (from === 0) { c.lastPrice = null; c.lastSide = 0; }
    const trades = [];
    for (let i = from; i < list.length; i++) {
      const r = list[i];
      const closes = toList(r.Close ?? r.close ?? r.price ?? r.deal_price);
      const vols = toList(r.Volume ?? r.volume ?? r.qty ?? r.deal_volume);
      const tts = toList(r.TickType ?? r.tick_type ?? 0);
      const t = parseFutOptTime(r.date, r.Time ?? r.time, 0);
      if (o.daySessionOnly && (t.minute < startMin || t.minute > endMin)) continue;
      const n = Math.max(closes.length, vols.length);
      for (let k = 0; k < n; k++) {
        const price = Number(closes[Math.min(k, closes.length - 1)]);
        const volume = Number(vols[Math.min(k, vols.length - 1)]);
        if (!Number.isFinite(price) || !(volume > 0)) continue;
        const tt = Number(tts.length ? tts[Math.min(k, tts.length - 1)] : 0);
        let side = tt === 1 ? 1 : tt === 2 ? -1 : 0;
        if (!side) side = tickSide(price, c.lastPrice, c.lastSide);
        c.lastPrice = price; c.lastSide = side;
        trades.push({ ms: t.ms, minute: t.minute, product: prod, price, volume, side });
      }
    }
    c.n = list.length;
    c.key = list.length ? rowKey(list[list.length - 1], list.length - 1) : null;
    return { trades, cursor: c };
  }

  /**
   * FinMind TaiwanFuturesTick（期貨交易明細表）增量解析，作為盤中逐筆的備援來源。
   * 每列：{ date:'2026-09-07 11:50:29.123', futures_id:'TX', contract_date:'202609', price, volume }
   * 無 TickType → 一律 Tick Rule。cursor 與 parseFutOptTickRows 相同語意。
   */
  function parseFuturesTickRows(rows, product, cursor, opts) {
    const o = Object.assign({ daySessionOnly: false, start: '08:45', end: '13:45' }, opts || {});
    const c = Object.assign({ n: 0, key: null, lastPrice: null, lastSide: 0, near: null }, cursor || {});
    const list = Array.isArray(rows) ? rows : [];
    const prod = normalizeProduct(product);
    const startMin = hhmmToMin(o.start), endMin = hhmmToMin(o.end);
    // 近月契約：資料量還小時每次重算，避免開盤初期樣本不足選錯
    if (!c.near || c.n < 200) c.near = selectNearContract(list);
    let from = c.n;
    if (list.length < c.n || (c.n > 0 && c.key != null && rowKey(list[c.n - 1] || {}, c.n - 1) !== c.key)) from = 0;
    if (from === 0) { c.lastPrice = null; c.lastSide = 0; c.near = selectNearContract(list); }
    const trades = [];
    for (let i = from; i < list.length; i++) {
      const r = list[i];
      const cd = String(r.contract_date || '');
      if (c.near && cd && cd !== c.near) continue;
      const t = parseTickTime(r.date, 0);
      if (o.daySessionOnly && (t.minute < startMin || t.minute > endMin)) continue;
      const price = Number(r.price), volume = Number(r.volume) || 0;
      if (!Number.isFinite(price) || volume <= 0) continue;
      const side = tickSide(price, c.lastPrice, c.lastSide);
      c.lastPrice = price; c.lastSide = side;
      trades.push({ ms: t.ms, minute: t.minute, product: prod, price, volume, side });
    }
    c.n = list.length;
    c.key = list.length ? rowKey(list[list.length - 1], list.length - 1) : null;
    return { trades, cursor: c };
  }

  // ---------- 合成資料（測試 / 示範）----------
  /** mulberry32：與 Python 版完全相同的 32 位元 PRNG（跨語言一致性檢核用） */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
      t = (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0)) >>> 0;
      t = (t ^ (t >>> 14)) >>> 0;
      return t / 4294967296;
    };
  }

  /**
   * 產生一天合成逐筆：帶趨勢與「大戶先行」結構（大單方向領先價格），
   * 供單元測試與示範模式使用。回傳 { rows: rowsByProduct（FinMind 原始列格式）, regime: 每分鐘的隱含趨勢(+1/0/-1) }
   */
  function syntheticDay(seed, opts) {
    const o = Object.assign({ date: '2026-09-07', basePrice: 24000, minutes: 300, tradesPerMin: 40, drift: 0.15, regimeLen: 45 }, opts || {});
    const rnd = mulberry32(seed);
    const rows = { TX: [], MTX: [], TMF: [] };
    let px = o.basePrice, regime = 0, regimeLeft = 0;
    const startMin = hhmmToMin('08:45');
    const regimes = [];
    for (let m = 0; m < o.minutes; m++) {
      if (regimeLeft <= 0) { regime = rnd() < 0.5 ? -1 : 1; if (rnd() < 0.3) regime = 0; regimeLeft = o.regimeLen + Math.floor(rnd() * 20); }
      regimeLeft--;
      regimes.push(regime);
      const minute = startMin + m;
      const hh = String(Math.floor(minute / 60)).padStart(2, '0'), mm = String(minute % 60).padStart(2, '0');
      const n = o.tradesPerMin + Math.floor(rnd() * 10);
      for (let k = 0; k < n; k++) {
        const ss = String(Math.floor((k / n) * 60)).padStart(2, '0');
        const ts = `${o.date} ${hh}:${mm}:${ss}`;
        const prodR = rnd();
        const product = prodR < 0.5 ? 'TX' : prodR < 0.85 ? 'MTX' : 'TMF';
        let volume, aggressor;
        if (product === 'TX') {
          const r = rnd();
          volume = r < 0.75 ? 1 + Math.floor(rnd() * 2) : r < 0.93 ? 3 + Math.floor(rnd() * 6) : 10 + Math.floor(rnd() * 30);
          // 大單跟隨 regime（聰明錢），小單反向偏誤
          const bias = volume >= 10 ? 0.7 : volume >= 3 ? 0.55 : 0.42;
          aggressor = rnd() < (regime > 0 ? bias : regime < 0 ? 1 - bias : 0.5) ? 1 : -1;
        } else {
          volume = 1 + Math.floor(rnd() * 4);
          const bias = 0.42;
          aggressor = rnd() < (regime > 0 ? bias : regime < 0 ? 1 - bias : 0.5) ? 1 : -1;
        }
        // 價格衝擊與口數(名目)成正比：大單才推得動價格；另加背景趨勢與隨機雜訊
        const w = product === 'TX' ? 1 : product === 'MTX' ? 0.25 : 0.025;
        const impactP = Math.min(0.85, 0.04 * volume * w);
        let step = rnd() < impactP ? aggressor : 0;
        if (rnd() < o.drift * 0.2) step += regime;
        if (rnd() < 0.08) step += rnd() < 0.5 ? 1 : -1;
        px = px + step;
        rows[product].push({ date: ts, contract_date: '202609', futures_id: product, price: px, volume });
      }
    }
    return { rows, regime: regimes };
  }

  return {
    VERSION, CONTRACT_WEIGHT, PRODUCT_ALIAS, POINT_VALUE_NTD, DEFAULT_PARAMS,
    mergeParams, hhmmToMin, minToHHMM, normalizeProduct, contractWeight, parseTickTime,
    selectNearContract, tickSide, classify, rowsToTrades, FlowBook, buildBars,
    computeSeries, sentiment, PaperTrader, backtestDay, backtestBars, gridSearch,
    snapshotToTrades, intervalSide, parseFutOptTickRows, parseFuturesTickRows, parseFutOptTime, toList,
    futuresMonthCode, nearMonthContract, contractExpiryKey, mulberry32, syntheticDay, round,
  };
});
