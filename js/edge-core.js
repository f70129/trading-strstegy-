/*
 * 台指期機率優勢引擎（瀏覽器 / Node 共用）— 與 edge_engine.py 邏輯 1:1 對應
 * 回合 / Price to Beat → 多空訊號節點 → 邏輯迴歸 + 類比路徑(kNN) → 扣成本優勢 → walk-forward 樣本外檢驗
 * 一致性檢核：node tests/edge-parity.js
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EdgeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '1.0.0';
  const CONTRACTS = { TX: 200, MTX: 50, TMF: 10 };
  const DEFAULT_PARAMS = {
    sessionStart: '08:45', sessionEnd: '13:45', roundMin: 60, decisions: [15, 30, 45], threshold: 0.05,
    contract: 'MTX', feeNtd: 25, taxRate: 0.00002, slipPts: 1.0, sigmaDays: 20, minHistoryDays: 5,
    minTrainDays: 60, refitDays: 20, l2: 1.0, knnK: 60, knnWeight: 0.5, flowWin: 10,
  };
  const BASE_FEATURES = ['zRef', 'mom5', 'zDay', 'vwapDev', 'rangePos', 'gap'];
  const FLOW_FEATURES = ['flowBig', 'flowRetail'];
  const FEATURE_LABEL = {
    zRef: '距回合開盤 (z)', mom5: '5 分動能 (z)', zDay: '距當日開盤 (z)', vwapDev: 'VWAP 乖離 (z)',
    rangePos: '日內區間位置', gap: '開盤跳空 (z)', flowBig: '大單淨流向 (z)', flowRetail: '散戶淨流向 (z)',
  };

  const mergeParams = (p) => Object.assign({}, DEFAULT_PARAMS, p || {});
  const hhmm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  const minToHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const clip = (x, lo = -4, hi = 4) => (x < lo ? lo : x > hi ? hi : x);
  const round = (x, d = 0) => { if (x == null || !Number.isFinite(x)) return x; const f = Math.pow(10, d); return Math.round(x * f) / f; };

  function costPoints(price, p) {
    const pv = CONTRACTS[p.contract] || 50;
    return 2 * p.feeNtd / pv + 2 * price * p.taxRate + 2 * p.slipPts;
  }

  // ------------------------------------------------------------ CSV（1 分 K）
  function parseCsvDays(text, params) {
    const p = mergeParams(params);
    const s0 = hhmm(p.sessionStart), s1 = hhmm(p.sessionEnd);
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const col = (n) => head.indexOf(n);
    const byDay = {};
    for (let li = 1; li < lines.length; li++) {
      const c = lines[li].split(',').map((x) => x.trim());
      const get = (n) => (col(n) >= 0 ? c[col(n)] : '');
      let ts = get('datetime') || get('timestamp') || `${get('date')} ${get('time')}`;
      ts = ts.replace(/\//g, '-').replace('T', ' ').trim();
      const parts = ts.split(/\s+/);
      if (parts.length < 2) continue;
      const hm = parts[1].split(':');
      const minute = Number(hm[0]) * 60 + Number(hm[1]);
      const o = Number(get('open')), h = Number(get('high')), l = Number(get('low')), cl = Number(get('close'));
      if (![minute, o, h, l, cl].every(Number.isFinite) || get('close') === '') continue;
      if (minute < s0 || minute > s1) continue;
      const vol = Number(get('volume') || get('vol') || 0) || 0;
      (byDay[parts[0]] = byDay[parts[0]] || []).push({ minute, open: o, high: h, low: l, close: cl, vol });
    }
    return Object.keys(byDay).sort().map((d) => ({ date: d, bars: byDay[d].sort((a, b) => a.minute - b.minute), hasFlow: false }))
      .filter((d) => d.bars.length >= 30);
  }

  /** SmartMoney.buildBars 的輸出 → 精簡 1 分 K（含大單 / 散戶淨流向） */
  function compactBars(smBars) {
    return smBars.map((b) => ({
      minute: b.minute, open: b.open, high: b.high, low: b.low, close: b.close, vol: b.vol,
      bigNet: round(b.bigBuy - b.bigSell, 3), retailNet: round(b.smallBuy - b.smallSell, 3),
    }));
  }

  // ------------------------------------------------------------ 合成資料（示範用）
  function syntheticDays(nDays = 300, seed = 7, edge = 0.0, sigma = 6.0, startPrice = 22000) {
    let a = seed >>> 0;
    const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = (mu, sd) => { let u = 0; while (u === 0) u = rnd(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
    const s0 = hhmm('08:45'), s1 = hhmm('13:45');
    let px = startPrice;
    const days = [];
    for (let d = 0; d < nDays; d++) {
      px += gauss(0, sigma * 8);
      const bars = [];
      let fs = 0;
      for (let m = s0; m <= s1; m++) {
        fs = 0.9 * fs + gauss(0, 1);
        const big = fs * 20 + gauss(0, 10);
        const retail = -0.3 * big + gauss(0, 15);
        const drift = edge * sigma * fs / 2.3;
        const o = px; let hi = o, lo = o;
        for (let k = 0; k < 4; k++) { px += gauss(drift / 4, sigma / 2); hi = Math.max(hi, px); lo = Math.min(lo, px); }
        const c = Math.round(px); px = c;
        bars.push({ minute: m, open: Math.round(o), high: Math.round(hi), low: Math.round(lo), close: c, vol: 500 + rnd() * 500, bigNet: round(big, 3), retailNet: round(retail, 3) });
      }
      days.push({ date: `S${String(d).padStart(4, '0')}`, bars, hasFlow: true });
    }
    return days;
  }

  // ------------------------------------------------------------ 特徵 / 樣本
  function daySigma(bars) {
    let s = 0, n = 0;
    for (let i = 1; i < bars.length; i++) { const d = bars[i].close - bars[i - 1].close; s += d * d; n++; }
    return [s, n];
  }
  function flowSigma(bars, key) {
    let s = 0, n = 0;
    for (const b of bars) { const v = b[key]; if (v == null) continue; s += v * v; n++; }
    return [s, n];
  }

  class DayContext {
    constructor(bars) {
      this.bars = bars; this.cumPv = []; this.cumV = []; this.hi = []; this.lo = [];
      let pv = 0, v = 0, hi = -Infinity, lo = Infinity;
      for (const b of bars) {
        const w = b.vol || 1.0;
        const tp = (b.high + b.low + b.close) / 3;
        pv += tp * w; v += w; hi = Math.max(hi, b.high); lo = Math.min(lo, b.low);
        this.cumPv.push(pv); this.cumV.push(v); this.hi.push(hi); this.lo.push(lo);
      }
    }
    lastIndexBefore(minute) {
      let best = null;
      for (let i = 0; i < this.bars.length; i++) { if (this.bars[i].minute < minute) best = i; else break; }
      return best;
    }
  }

  function computeFeatures(ctx, i, ref, roundStart, dayOpen, prevClose, sig, fsigBig, fsigRet, hasFlow, p) {
    const bars = ctx.bars, b = bars[i], px = b.close;
    const s0 = hhmm(p.sessionStart);
    const elapsedRound = Math.max(1, b.minute + 1 - roundStart);
    const elapsedDay = Math.max(1, b.minute + 1 - s0);
    const j = Math.max(0, i - 5);
    const vwap = ctx.cumV[i] > 0 ? ctx.cumPv[i] / ctx.cumV[i] : px;
    const rng = ctx.hi[i] - ctx.lo[i];
    const f = {
      zRef: clip((px - ref) / (sig * Math.sqrt(elapsedRound))),
      mom5: i > j ? clip((px - bars[j].close) / (sig * Math.sqrt(Math.max(1, i - j)))) : 0,
      zDay: clip((px - dayOpen) / (sig * Math.sqrt(elapsedDay))),
      vwapDev: clip((px - vwap) / (sig * Math.sqrt(10))),
      rangePos: rng > 0 ? ((px - ctx.lo[i]) / rng - 0.5) * 2 : 0,
      gap: prevClose ? clip((dayOpen - prevClose) / (sig * Math.sqrt(300))) : 0,
    };
    if (hasFlow) {
      const W = p.flowWin, lo = Math.max(0, i - W + 1);
      let wb = 0, wr = 0;
      for (let k = lo; k <= i; k++) { wb += bars[k].bigNet || 0; wr += bars[k].retailNet || 0; }
      const n = i - lo + 1;
      f.flowBig = fsigBig > 0 ? clip(wb / (fsigBig * Math.sqrt(n))) : 0;
      f.flowRetail = fsigRet > 0 ? clip(wr / (fsigRet * Math.sqrt(n))) : 0;
    }
    return f;
  }

  function roundsOfDay(p) {
    const s0 = hhmm(p.sessionStart), s1 = hhmm(p.sessionEnd), W = Number(p.roundMin);
    const maxDec = Math.max(...p.decisions);
    const out = [];
    for (let s = s0; s < s1; s += W) { const e = Math.min(s + W, s1); if (e - s >= maxDec + 1) out.push([s, e]); }
    return out;
  }

  function buildSamples(days, p) {
    const hasFlow = days.length > 0 && days.every((d) => d.hasFlow);
    const feats = BASE_FEATURES.concat(hasFlow ? FLOW_FEATURES : []);
    const s1 = hhmm(p.sessionEnd);
    const hist = [], samples = [];
    let prevClose = null;
    const rounds = roundsOfDay(p);
    for (const d of days) {
      const bars = d.bars;
      if (hist.length >= p.minHistoryDays) {
        const recent = hist.slice(-p.sigmaDays);
        const sum = (k) => recent.reduce((a, h) => a + h[k], 0);
        const nn = sum(1);
        const sig = nn ? Math.sqrt(sum(0) / nn) : 0;
        const fb = Math.sqrt(sum(2) / Math.max(1, sum(3)));
        const fr = Math.sqrt(sum(4) / Math.max(1, sum(5)));
        if (sig > 0) {
          const ctx = new DayContext(bars);
          const dayOpen = bars[0].open;
          for (const [rs, re] of rounds) {
            const inRound = [];
            bars.forEach((b, k) => { if ((rs <= b.minute && b.minute < re) || (re === s1 && b.minute === s1)) inRound.push(k); });
            if (inRound.length < 5) continue;
            const ref = bars[inRound[0]].open, exitPx = bars[inRound[inRound.length - 1]].close;
            for (const dec of p.decisions) {
              const i = ctx.lastIndexBefore(rs + dec);
              if (i == null || i < inRound[0] || i >= inRound[inRound.length - 1]) continue;
              const px = bars[i].close;
              const f = computeFeatures(ctx, i, ref, rs, dayOpen, prevClose, sig, fb, fr, hasFlow, p);
              const fwd = exitPx - px;
              samples.push({
                date: d.date, round: `${minToHHMM(rs)}-${minToHHMM(re)}`, dec, time: minToHHMM(bars[i].minute + 1),
                px, ref, exit: exitPx, fwd, y: fwd > 0 ? 1 : fwd < 0 ? 0 : null, x: feats.map((k) => f[k]),
              });
            }
          }
        }
      }
      const [a, b] = daySigma(bars), [fa, fb2] = flowSigma(bars, 'bigNet'), [ra, rb] = flowSigma(bars, 'retailNet');
      hist.push([a, b, fa, fb2, ra, rb]);
      prevClose = bars[bars.length - 1].close;
    }
    return { samples, feats };
  }

  // ------------------------------------------------------------ 模型
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.slice().concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) continue;
      const inv = 1 / M[c][c];
      for (let r = 0; r < n; r++) {
        if (r !== c && M[r][c] !== 0) { const f = M[r][c] * inv; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
      }
    }
    return M.map((row, i) => (Math.abs(row[i]) > 1e-12 ? row[n] / row[i] : 0));
  }
  const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

  function fitLogistic(X, y, l2 = 1.0, iters = 30) {
    const k = X[0].length, n = X.length;
    const mu = [], sd = [];
    for (let j = 0; j < k; j++) {
      let s = 0; for (const r of X) s += r[j]; mu.push(s / n);
      let v = 0; for (const r of X) v += (r[j] - mu[j]) ** 2;
      sd.push(Math.sqrt(v / Math.max(1, n - 1)) || 1.0);
    }
    const Z = X.map((r) => [1].concat(r.map((v, j) => (v - mu[j]) / sd[j])));
    let w = new Array(k + 1).fill(0);
    for (let it = 0; it < iters; it++) {
      const g = new Array(k + 1).fill(0);
      const H = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0));
      for (let s = 0; s < Z.length; s++) {
        const zi = Z[s];
        let lin = 0; for (let a = 0; a <= k; a++) lin += w[a] * zi[a];
        const pi = sigmoid(lin), r = y[s] - pi, wt = pi * (1 - pi);
        for (let a = 0; a <= k; a++) {
          g[a] += r * zi[a];
          const za = zi[a] * wt, Ha = H[a];
          for (let b = a; b <= k; b++) Ha[b] += za * zi[b];
        }
      }
      for (let a = 0; a <= k; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];
      for (let a = 1; a <= k; a++) { g[a] -= l2 * w[a]; H[a][a] += l2; }
      const step = solve(H, g);
      w = w.map((v, i) => v + step[i]);
      if (Math.max(...step.map(Math.abs)) < 1e-7) break;
    }
    return { w, mu, sd };
  }
  function predictLogistic(m, x) {
    const contrib = x.map((v, j) => m.w[j + 1] * ((v - m.mu[j]) / m.sd[j]));
    return [sigmoid(m.w[0] + contrib.reduce((a, b) => a + b, 0)), contrib];
  }

  /** 類比路徑：標準化特徵空間中最像的 K 個歷史情境，數多頭 / 空頭路徑 */
  class KnnPaths {
    constructor(X, y, mu, sd, k = 60) {
      this.k = k; this.ok = X.length >= k; this.mu = mu; this.sd = sd;
      const dim = mu.length;
      this.n = X.length; this.dim = dim;
      this.Z = new Float64Array(X.length * dim);
      for (let i = 0; i < X.length; i++) for (let j = 0; j < dim; j++) this.Z[i * dim + j] = (X[i][j] - mu[j]) / sd[j];
      this.y = Float64Array.from(y);
      this.d = new Float64Array(X.length);
      this.idx = new Uint32Array(X.length);
    }
    predict(x) {
      if (!this.ok) return [null, 0, 0];
      const { dim, n, Z, d, k } = this;
      const z = x.map((v, j) => (v - this.mu[j]) / this.sd[j]);
      for (let i = 0; i < n; i++) { let s = 0; const o = i * dim; for (let j = 0; j < dim; j++) { const t = Z[o + j] - z[j]; s += t * t; } d[i] = s; }
      // 第 k 小的距離（quickselect on index array）
      const idx = this.idx; for (let i = 0; i < n; i++) idx[i] = i;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const pv = d[idx[(lo + hi) >> 1]];
        let i = lo, j = hi;
        while (i <= j) { while (d[idx[i]] < pv) i++; while (d[idx[j]] > pv) j--; if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; } }
        if (k - 1 <= j) hi = j; else if (k - 1 >= i) lo = i; else break;
      }
      let bull = 0; for (let i = 0; i < k; i++) bull += this.y[idx[i]];
      return [(bull + 1) / (k + 2), bull, k - bull];
    }
  }
  const ensemble = (pl, pk, wk) => (pk == null ? pl : (1 - wk) * pl + wk * pk);

  // ------------------------------------------------------------ Walk-forward
  async function walkForward(samples, p, onProgress) {
    const dates = Array.from(new Set(samples.map((s) => s.date))).sort();
    if (dates.length <= p.minTrainDays) throw new Error(`交易日太少：${dates.length} 天（需 > 最少訓練天數 ${p.minTrainDays}）`);
    const byDate = {};
    for (const s of samples) (byDate[s.date] = byDate[s.date] || []).push(s);
    const out = [];
    for (let i = p.minTrainDays; i < dates.length; i += p.refitDays) {
      const train = [];
      for (const d of dates.slice(0, i)) for (const s of byDate[d]) if (s.y != null) train.push(s);
      const X = train.map((s) => s.x), y = train.map((s) => s.y);
      const m = fitLogistic(X, y, p.l2);
      const knn = new KnnPaths(X, y, m.mu, m.sd, p.knnK);
      for (const d of dates.slice(i, i + p.refitDays)) {
        for (const s of byDate[d]) {
          const [pl] = predictLogistic(m, s.x);
          const [pk, bull, bear] = knn.predict(s.x);
          out.push(Object.assign({}, s, { pLog: pl, pKnn: pk, bull, bear, p: ensemble(pl, pk, p.knnWeight) }));
        }
      }
      if (onProgress) await onProgress(Math.min(1, (i + p.refitDays - p.minTrainDays) / (dates.length - p.minTrainDays)));
    }
    return out;
  }

  function simulateTrades(preds, p, threshold) {
    const th = threshold == null ? p.threshold : threshold;
    const pv = CONTRACTS[p.contract] || 50;
    const taken = new Set(), trades = [];
    for (const s of preds) {
      const key = s.date + '|' + s.round;
      if (taken.has(key)) continue;
      const edge = s.p - 0.5;
      if (Math.abs(edge) < th || (th === 0 && edge === 0)) continue;
      const side = edge > 0 ? 1 : -1;
      const gross = side * s.fwd, net = gross - costPoints(s.px, p);
      taken.add(key);
      trades.push({ date: s.date, round: s.round, time: s.time, side, p: round(s.p, 4), entry: s.px, exit: s.exit, ref: s.ref,
        grossPts: round(gross, 2), netPts: round(net, 2), netNtd: Math.round(net * pv) });
    }
    return trades;
  }

  function tradeStats(trades, p) {
    const n = trades.length;
    if (!n) return { n: 0 };
    const pv = CONTRACTS[p.contract] || 50;
    const net = trades.map((t) => t.netPts), gross = trades.map((t) => t.grossPts);
    const wins = net.filter((x) => x > 0), losses = net.filter((x) => x <= 0);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const mean = sum(net) / n;
    const sd = n > 1 ? Math.sqrt(net.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
    const byDay = {};
    for (const t of trades) byDay[t.date] = (byDay[t.date] || 0) + t.netPts;
    const dv = Object.values(byDay), dm = sum(dv) / dv.length;
    const dsd = dv.length > 1 ? Math.sqrt(dv.reduce((a, x) => a + (x - dm) ** 2, 0) / (dv.length - 1)) : 0;
    let eq = 0, peak = 0, mdd = 0;
    for (const x of net) { eq += x; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
    const sl = sum(losses);
    return {
      n, winRate: round(wins.length / n, 4), grossWinRate: round(gross.filter((x) => x > 0).length / n, 4),
      avgGrossPts: round(sum(gross) / n, 3), avgNetPts: round(mean, 3), totalNetPts: round(sum(net), 1), totalNetNtd: Math.round(sum(net) * pv),
      avgWinPts: wins.length ? round(sum(wins) / wins.length, 2) : 0, avgLossPts: losses.length ? round(sl / losses.length, 2) : 0,
      profitFactor: losses.length && sl < 0 ? round(sum(wins) / -sl, 3) : null,
      tStat: sd > 0 ? round(mean / (sd / Math.sqrt(n)), 3) : null, sharpeAnnual: dsd > 0 ? round(dm / dsd * Math.sqrt(250), 3) : null,
      maxDrawdownPts: round(mdd, 1), maxDrawdownNtd: Math.round(mdd * pv), tradingDays: dv.length,
    };
  }

  function probMetrics(preds) {
    const lab = preds.filter((s) => s.y != null);
    const n = lab.length;
    if (!n) return { n: 0 };
    const brier = (k) => lab.reduce((a, s) => a + (s[k] - s.y) ** 2, 0) / n;
    const ll = (k) => -lab.reduce((a, s) => a + Math.log(Math.max(1e-6, s.y ? s[k] : 1 - s[k])), 0) / n;
    const out = {
      n, baseRateUp: round(lab.reduce((a, s) => a + s.y, 0) / n, 4), brierCoin: 0.25,
      brierModel: round(brier('p'), 5), brierLogit: round(brier('pLog'), 5), logLossCoin: round(Math.log(2), 5), logLossModel: round(ll('p'), 5),
      hitRate: round(lab.filter((s) => (s.p > 0.5) === (s.y === 1)).length / n, 4),
    };
    if (lab.every((s) => s.pKnn != null)) out.brierKnn = round(brier('pKnn'), 5);
    out.skill = round(1 - out.brierModel / 0.25, 5);
    return out;
  }

  function calibration(preds, edges = [0, 0.35, 0.4, 0.45, 0.48, 0.5, 0.52, 0.55, 0.6, 0.65, 1.0001]) {
    const out = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1];
      const grp = preds.filter((s) => lo <= s.p && s.p < hi);
      if (!grp.length) continue;
      const lab = grp.filter((s) => s.y != null);
      out.push({ lo, hi: Math.min(hi, 1), n: grp.length, predicted: round(grp.reduce((a, s) => a + s.p, 0) / grp.length, 4),
        realized: lab.length ? round(lab.reduce((a, s) => a + s.y, 0) / lab.length, 4) : null,
        avgFwdPts: round(grp.reduce((a, s) => a + s.fwd, 0) / grp.length, 2) });
    }
    return out;
  }

  function thresholdTable(preds, p) {
    return [0, 0.02, 0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20].map((th) => {
      const st = tradeStats(simulateTrades(preds, p, th), p);
      return { threshold: th, n: st.n, winRate: st.winRate, avgGrossPts: st.avgGrossPts, avgNetPts: st.avgNetPts, totalNetNtd: st.totalNetNtd, tStat: st.tStat, profitFactor: st.profitFactor };
    });
  }

  function equityCurve(trades) {
    const byDay = {};
    for (const t of trades) byDay[t.date] = (byDay[t.date] || 0) + t.netNtd;
    let eq = 0;
    return Object.keys(byDay).sort().map((d) => ({ date: d, equity: (eq += byDay[d]) }));
  }

  function kellyFraction(st) {
    if (!st.n || !st.avgLossPts || st.avgLossPts >= 0) return null;
    const b = st.avgWinPts / -st.avgLossPts;
    if (!b) return null;
    return round(Math.max(0, (st.winRate * b - (1 - st.winRate)) / b), 4);
  }

  function verdict(pm, st) {
    const reasons = []; let good = true;
    if (!(pm.skill > 0)) { good = false; reasons.push(`機率預測沒有勝過擲硬幣（Brier ${pm.brierModel} vs 0.25）`); }
    else reasons.push(`機率預測略勝擲硬幣（Brier skill ${pm.skill.toFixed(4)}）`);
    if (!st.n) { good = false; reasons.push('門檻下沒有任何交易'); }
    else {
      if (st.avgNetPts <= 0) { good = false; reasons.push(`扣成本後平均每筆 ${st.avgNetPts} 點（≤ 0）`); }
      const t = st.tStat || 0;
      if (t < 2) { good = false; reasons.push(`交易 t 值 ${t}（< 2，無法排除運氣）`); } else reasons.push(`交易 t 值 ${t}（≥ 2）`);
      if (st.n < 200) reasons.push(`樣本只有 ${st.n} 筆，大數法則尚未發揮`);
    }
    return { edgeFound: good, label: good ? '樣本外有統計顯著優勢（仍需紙上交易驗證）' : '未發現可交易的優勢', reasons };
  }

  async function runBacktest(days, params, source, onProgress) {
    const p = mergeParams(params);
    const t0 = Date.now();
    const { samples, feats } = buildSamples(days, p);
    if (!samples.length) throw new Error('沒有樣本（資料天數不足或回合設定過長）');
    const preds = await walkForward(samples, p, onProgress);
    const trades = simulateTrades(preds, p);
    const st = tradeStats(trades, p), pm = probMetrics(preds);
    const lab = samples.filter((s) => s.y != null);
    const final = fitLogistic(lab.map((s) => s.x), lab.map((s) => s.y), p.l2);
    const oos = Array.from(new Set(preds.map((s) => s.date))).sort();
    const lastBars = days[days.length - 1].bars;
    return {
      version: VERSION, updated: new Date().toISOString().slice(0, 16).replace('T', ' '), source,
      range: { from: days[0].date, to: days[days.length - 1].date, days: days.length, oosFrom: oos[0], oosTo: oos[oos.length - 1], oosDays: oos.length },
      params: p, costPtsRoundTrip: round(costPoints(lastBars[lastBars.length - 1].close, p), 2), pointValue: CONTRACTS[p.contract] || 50,
      samples: samples.length, oosSamples: preds.length, features: feats,
      probability: pm, trades: st, verdict: verdict(pm, st), kelly: kellyFraction(st),
      lattice: calibration(preds), thresholds: thresholdTable(preds, p),
      weights: feats.map((f, j) => ({ feature: f, label: FEATURE_LABEL[f] || f, coef: round(final.w[j + 1], 4) })),
      equity: equityCurve(trades), recentTrades: trades.slice(-40), allTrades: trades,
      elapsedSec: round((Date.now() - t0) / 1000, 1),
    };
  }

  return {
    VERSION, CONTRACTS, DEFAULT_PARAMS, BASE_FEATURES, FLOW_FEATURES, FEATURE_LABEL,
    mergeParams, hhmm, minToHHMM, costPoints, parseCsvDays, compactBars, syntheticDays,
    DayContext, computeFeatures, roundsOfDay, buildSamples, fitLogistic, predictLogistic, KnnPaths, ensemble,
    walkForward, simulateTrades, tradeStats, probMetrics, calibration, thresholdTable, equityCurve, kellyFraction, verdict, runBacktest, round,
  };
});
