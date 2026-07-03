// =====================================================
// 季節性型態 · Seasonal Pattern (2000–2025)
// 台股加權 & S&P 500 · STA 風格（預設台股，S&P 按需載入）
// =====================================================

const SEASONAL_START = '2000-01-01';
const SEASONAL_END = '2025-12-31';
const SEASONAL_MAX_DAYS = 262;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LABELS_ZH = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

let _seasonalChart = null;
let _seasonalData = { twii: null, sp500: null };
let _seasonalErrors = { twii: null, sp500: null };
let _seasonalMarket = 'twii';
let _showYearLines = true;
let _sp500Loading = false;
const WEEK_LABELS = ['第1週', '第2週', '第3週', '第4週'];

const MARKETS = {
  twii: {
    id: 'twii',
    name: '台股加權',
    electionMode: 'tw',
    fetch: () => fetchTaiexIndexHistorical(SEASONAL_START, SEASONAL_END),
  },
  sp500: {
    id: 'sp500',
    name: 'S&P 500',
    electionMode: 'us',
    fetch: () => fetchSp500Historical(SEASONAL_START, SEASONAL_END),
  },
};

function usElectionType(year) {
  if (year % 4 === 0) return 'presidential';
  if (year % 2 === 0) return 'midterm';
  return 'off';
}

function twElectionType(year) {
  if (year % 4 === 0) return 'presidential';
  if (year % 4 === 2) return 'local';
  return 'off';
}

function electionTypeFor(marketId, year) {
  return marketId === 'twii' ? twElectionType(year) : usElectionType(year);
}

function electionLabel(type, marketId) {
  if (type === 'presidential') return marketId === 'twii' ? '總統/立委選舉年' : '美國總統選舉年';
  if (type === 'midterm') return '美國期中選舉年';
  if (type === 'local') return '台灣九合一地方選舉年';
  return '非選舉年';
}

function groupBarsByYear(bars) {
  const years = {};
  for (const b of bars) {
    const y = parseInt(b.date.slice(0, 4), 10);
    if (y < 2000 || y > 2025) continue;
    if (!years[y]) years[y] = [];
    years[y].push(b);
  }
  Object.values(years).forEach(arr => arr.sort((a, b) => a.date.localeCompare(b.date)));
  return years;
}

function buildYearCurve(yearBars) {
  if (!yearBars || yearBars.length < 5) return null;
  const base = yearBars[0].close;
  return yearBars.map((b, i) => ({
    i,
    date: b.date,
    month: parseInt(b.date.slice(5, 7), 10),
    pct: ((b.close / base) - 1) * 100,
  }));
}

function averageCurves(curves) {
  const sums = new Array(SEASONAL_MAX_DAYS).fill(0);
  const counts = new Array(SEASONAL_MAX_DAYS).fill(0);
  for (const c of curves) {
    if (!c) continue;
    c.forEach((pt, i) => {
      if (i < SEASONAL_MAX_DAYS) {
        sums[i] += pt.pct;
        counts[i]++;
      }
    });
  }
  const out = [];
  for (let i = 0; i < SEASONAL_MAX_DAYS; i++) {
    if (counts[i]) out.push(sums[i] / counts[i]);
  }
  return out;
}

function monthTickIndices(maxLen) {
  const ticks = [];
  const step = Math.max(18, Math.floor(maxLen / 12));
  for (let i = 0; i < 12; i++) ticks.push(Math.min(i * step, maxLen - 1));
  return ticks;
}

function weekOfMonth(day) {
  if (day <= 7) return 1;
  if (day <= 14) return 2;
  if (day <= 21) return 3;
  return 4;
}

function currentWeekOfMonth() {
  return weekOfMonth(new Date().getDate());
}

function finalizePeriodStat(s) {
  return {
    ...s,
    upPct: s.total ? (s.up / s.total) * 100 : null,
    downPct: s.total ? (s.down / s.total) * 100 : null,
    avgRet: s.total ? s.sumRet / s.total : null,
    presUpPct: s.presTotal ? (s.presUp / s.presTotal) * 100 : null,
    midUpPct: s.midTotal ? (s.midUp / s.midTotal) * 100 : null,
  };
}

function emptyPeriodStat() {
  return { up: 0, down: 0, total: 0, sumRet: 0, presUp: 0, presTotal: 0, midUp: 0, midTotal: 0 };
}

function recordPeriodReturn(stat, ret, et) {
  stat.total++;
  stat.sumRet += ret;
  if (ret >= 0) stat.up++; else stat.down++;
  if (et === 'presidential') {
    stat.presTotal++;
    if (ret >= 0) stat.presUp++;
  }
  if (et === 'midterm' || et === 'local') {
    stat.midTotal++;
    if (ret >= 0) stat.midUp++;
  }
}

function computeMonthlyStats(yearsMap, marketId) {
  const stats = MONTH_LABELS_ZH.map((label, idx) => ({
    month: idx + 1,
    label,
    ...emptyPeriodStat(),
  }));

  for (const [ys, bars] of Object.entries(yearsMap)) {
    const year = parseInt(ys, 10);
    const et = electionTypeFor(marketId, year);
    for (let m = 1; m <= 12; m++) {
      const mb = bars.filter(b => parseInt(b.date.slice(5, 7), 10) === m);
      if (mb.length < 2) continue;
      const ret = (mb[mb.length - 1].close / mb[0].close - 1) * 100;
      recordPeriodReturn(stats[m - 1], ret, et);
    }
  }

  return stats.map(finalizePeriodStat);
}

function computeWeeklyStats(yearsMap, marketId) {
  const grid = MONTH_LABELS_ZH.map((label, idx) =>
    WEEK_LABELS.map((weekLabel, wi) => ({
      month: idx + 1,
      week: wi + 1,
      monthLabel: label,
      weekLabel,
      ...emptyPeriodStat(),
    }))
  );

  for (const [ys, bars] of Object.entries(yearsMap)) {
    const year = parseInt(ys, 10);
    const et = electionTypeFor(marketId, year);
    for (let m = 1; m <= 12; m++) {
      for (let w = 1; w <= 4; w++) {
        const wb = bars.filter(b => {
          const day = parseInt(b.date.slice(8, 10), 10);
          return parseInt(b.date.slice(5, 7), 10) === m && weekOfMonth(day) === w;
        });
        if (wb.length < 2) continue;
        const ret = (wb[wb.length - 1].close / wb[0].close - 1) * 100;
        recordPeriodReturn(grid[m - 1][w - 1], ret, et);
      }
    }
  }

  return grid.map(row => row.map(finalizePeriodStat));
}

function analyzeSeasonal(bars, marketId) {
  const yearsMap = groupBarsByYear(bars);
  const yearNums = Object.keys(yearsMap).map(Number).sort((a, b) => a - b);
  if (yearNums.length < 2) {
    throw new Error(`樣本年數不足（僅 ${yearNums.length} 年）`);
  }
  const curves = {};
  for (const y of yearNums) curves[y] = buildYearCurve(yearsMap[y]);

  const allCurves = yearNums.map(y => curves[y]).filter(Boolean);
  const presCurves = yearNums.filter(y => electionTypeFor(marketId, y) === 'presidential').map(y => curves[y]).filter(Boolean);
  const midCurves = yearNums.filter(y => {
    const t = electionTypeFor(marketId, y);
    return t === 'midterm' || t === 'local';
  }).map(y => curves[y]).filter(Boolean);

  const recent20 = yearNums.filter(y => y >= 2005 && y <= 2024);

  const now = new Date();
  const cy = now.getFullYear();
  const cm = now.getMonth() + 1;
  let ytdPct = null;
  if (yearsMap[cy] && yearsMap[cy].length > 1) {
    const ybars = yearsMap[cy];
    ytdPct = ((ybars[ybars.length - 1].close / ybars[0].close) - 1) * 100;
  }

  const avgAll = averageCurves(allCurves);
  const avgPres = averageCurves(presCurves);
  const avgMid = averageCurves(midCurves);
  const monthly = computeMonthlyStats(yearsMap, marketId);
  const weekly = computeWeeklyStats(yearsMap, marketId);

  const maxLen = avgAll.length;
  const dayIdx = Math.min(maxLen - 1, Math.floor((cm - 1) / 12 * maxLen));
  const seasonalAtNow = avgAll[dayIdx] ?? 0;

  return {
    yearsMap,
    yearNums,
    curves,
    recent20,
    avgAll,
    avgPres,
    avgMid,
    monthly,
    weekly,
    ytdPct,
    seasonalAtNow,
    currentYearType: electionTypeFor(marketId, cy),
    currentMonth: cm,
    maxLen,
    sampleYears: yearNums.length,
    barCount: bars.length,
    dataFrom: bars[0]?.date,
    dataTo: bars[bars.length - 1]?.date,
  };
}

function seasonalAiAdvice(market, analysis) {
  const m = analysis.monthly[analysis.currentMonth - 1];
  const et = analysis.currentYearType;
  const lines = [];
  const mkt = MARKETS[market].name;

  lines.push(`📊 ${mkt} · ${analysis.sampleYears} 年真實樣本（${analysis.dataFrom || '—'}～${analysis.dataTo || '—'}）`);

  if (m && m.total) {
    const bias = m.upPct >= 55 ? '偏多' : m.upPct <= 45 ? '偏空' : '中性';
    lines.push(`【${m.label}】歷史上漲 ${m.upPct.toFixed(0)}% / 跌 ${m.downPct.toFixed(0)}%（${m.total} 次樣本，月均 ${m.avgRet >= 0 ? '+' : ''}${m.avgRet.toFixed(2)}%）→ ${bias}`);
    const cw = analysis.weekly?.[analysis.currentMonth - 1]?.[currentWeekOfMonth() - 1];
    if (cw && cw.total) {
      const wb = cw.upPct >= 55 ? '偏多' : cw.upPct <= 45 ? '偏空' : '中性';
      lines.push(`【${m.label}${WEEK_LABELS[currentWeekOfMonth() - 1]}】上漲 ${cw.upPct.toFixed(0)}% / 跌 ${cw.downPct.toFixed(0)}%（${cw.total} 次）→ ${wb}`);
    }
    if (m.presUpPct != null && et === 'presidential') {
      lines.push(`　└ 總統選舉年 ${m.label} 上漲機率 ${m.presUpPct.toFixed(0)}%（${m.presTotal} 次）`);
    }
    if (m.midUpPct != null && (et === 'midterm' || et === 'local')) {
      lines.push(`　└ ${market === 'twii' ? '九合一' : '期中'}選舉年 ${m.label} 上漲機率 ${m.midUpPct.toFixed(0)}%（${m.midTotal} 次）`);
    }
  }

  lines.push(`【選舉週期】今年為「${electionLabel(et, market)}」`);

  if (analysis.ytdPct != null) {
    const diff = analysis.ytdPct - analysis.seasonalAtNow;
    lines.push(`【YTD】今年迄今 ${analysis.ytdPct >= 0 ? '+' : ''}${analysis.ytdPct.toFixed(2)}%，季節性平均 ${analysis.seasonalAtNow >= 0 ? '+' : ''}${analysis.seasonalAtNow.toFixed(2)}%（${diff >= 0 ? '領先' : '落後'} ${Math.abs(diff).toFixed(2)}%）`);
    if (diff > 3) lines.push('💡 建議：今年走勢優於季節性均值，留意獲利了結與均值回歸風險');
    else if (diff < -3) lines.push('💡 建議：今年落後季節性均值，若基本面未惡化可留意佈局時機');
    else lines.push('💡 建議：今年大致貼近季節性軌道，參考月份勝率操作');
  }

  const best = [...analysis.monthly].filter(x => x.total >= 5).sort((a, b) => b.upPct - a.upPct)[0];
  const worst = [...analysis.monthly].filter(x => x.total >= 5).sort((a, b) => a.upPct - b.upPct)[0];
  if (best && worst) {
    lines.push(`【強弱月】歷史最強 ${best.label}（漲 ${best.upPct.toFixed(0)}%）· 最弱 ${worst.label}（漲 ${worst.upPct.toFixed(0)}%）`);
  }

  if (market === 'sp500' && (et === 'midterm' || et === 'presidential')) {
    lines.push('📌 參考 STA：期中/選舉年夏季常見整理，Q4 季節性反彈機率偏高');
  }
  if (market === 'twii' && et === 'presidential') {
    lines.push('📌 台股總統大選年波動通常加大，選後走勢需觀察政策方向');
  }

  return lines.join('\n');
}

function renderElectionLegend(marketId, yearNums) {
  const el = document.getElementById('seasonalElectionLegend');
  if (!el) return;
  const pres = yearNums.filter(y => electionTypeFor(marketId, y) === 'presidential');
  const mid = yearNums.filter(y => {
    const t = electionTypeFor(marketId, y);
    return t === 'midterm' || t === 'local';
  });
  const midLabel = marketId === 'twii' ? '🏛️ 九合一選舉年' : '📊 期中選舉年';
  el.innerHTML = `
    <div class="seasonal-legend">
      <span class="signal-pill bull">🗳️ 總統選舉年：${pres.join(', ')}</span>
      <span class="signal-pill bear">${midLabel}：${mid.join(', ')}</span>
      <span class="signal-pill sideways">非選舉年：${yearNums.filter(y => !pres.includes(y) && !mid.includes(y)).slice(-6).join(', ')}…</span>
    </div>`;
}

function fmtPct(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toFixed(digits) + '%';
}

function fmtRet(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function renderMonthlyTable(monthly, marketId) {
  const el = document.getElementById('seasonalMonthlyTable');
  if (!el) return;
  const midLabel = marketId === 'twii' ? '九合一漲%' : '期中漲%';
  const curM = new Date().getMonth() + 1;
  const hasData = monthly.some(m => m.total > 0);

  if (!hasData) {
    el.innerHTML = `<div class="error-panel" style="font-size:12px;margin-top:10px;">⚠️ 月份勝率無資料，請確認歷史數據已載入</div>`;
    return;
  }

  el.innerHTML = `
    <div class="stat-label" style="margin-top:12px;margin-bottom:6px;">📅 月份勝率統計（2000–2025 真實樣本）</div>
    <div style="overflow-x:auto;">
      <table class="fib-table seasonal-table">
        <thead>
          <tr>
            <th>月份</th><th>上漲機率</th><th>下跌機率</th><th>平均報酬</th>
            <th>總統年漲%</th><th>${midLabel}</th><th>樣本</th>
          </tr>
        </thead>
        <tbody>
          ${monthly.map(m => `
          <tr class="${m.month === curM ? 'seasonal-current-month' : ''}">
            <td class="gold">${m.label}${m.month === curM ? ' ◀' : ''}</td>
            <td class="up">${fmtPct(m.upPct)}</td>
            <td class="down">${fmtPct(m.downPct)}</td>
            <td class="${m.avgRet >= 0 ? 'up' : 'down'}">${fmtRet(m.avgRet)}</td>
            <td>${fmtPct(m.presUpPct)}</td>
            <td>${fmtPct(m.midUpPct)}</td>
            <td style="color:var(--muted)">${m.total || '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderWeeklyTable(weekly, marketId) {
  const el = document.getElementById('seasonalWeeklyTable');
  if (!el || !weekly) return;
  const curM = new Date().getMonth() + 1;
  const curW = currentWeekOfMonth();
  const rows = [];
  for (const monthRow of weekly) {
    for (const w of monthRow) {
      rows.push(w);
    }
  }
  const hasData = rows.some(w => w.total > 0);

  if (!hasData) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div class="stat-label" style="margin-top:14px;margin-bottom:6px;">📆 每月週次勝率（第1週=1–7日 · 第2週=8–14日 · 第3週=15–21日 · 第4週=22日–月底）</div>
    <div style="overflow-x:auto;max-height:360px;overflow-y:auto;">
      <table class="fib-table seasonal-table">
        <thead>
          <tr>
            <th>月份</th><th>週次</th><th>上漲機率</th><th>下跌機率</th><th>平均報酬</th><th>樣本</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(w => `
          <tr class="${w.month === curM && w.week === curW ? 'seasonal-current-month' : ''}">
            <td class="gold">${w.monthLabel}${w.month === curM ? ' ◀' : ''}</td>
            <td>${w.weekLabel}${w.month === curM && w.week === curW ? ' ◀' : ''}</td>
            <td class="up">${w.total ? fmtPct(w.upPct) : '—'}</td>
            <td class="down">${w.total ? fmtPct(w.downPct) : '—'}</td>
            <td class="${w.avgRet == null ? 'neutral' : w.avgRet >= 0 ? 'up' : 'down'}">${fmtRet(w.avgRet)}</td>
            <td style="color:var(--muted)">${w.total || '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function buildSeasonalChartDatasets(analysis, marketId) {
  const labels = Array.from({ length: analysis.maxLen }, (_, i) => i);
  const datasets = [];

  if (_showYearLines) {
    analysis.recent20.forEach((y, idx) => {
      const c = analysis.curves[y];
      if (!c) return;
      const et = electionTypeFor(marketId, y);
      const isPres = et === 'presidential';
      const isMid = et === 'midterm' || et === 'local';
      datasets.push({
        label: `${y}${isPres ? ' 🗳️' : isMid ? ' 📊' : ''}`,
        data: c.map(p => p.pct),
        borderColor: isPres ? 'rgba(0,212,255,0.35)' : isMid ? 'rgba(255,68,102,0.35)' : `hsla(${(idx * 18) % 360},50%,55%,0.25)`,
        borderWidth: 1,
        pointRadius: 0,
        tension: 0.3,
        fill: false,
      });
    });
  }

  if (analysis.avgMid.length) {
    datasets.push({
      label: marketId === 'twii' ? '九合一選舉年平均' : '期中選舉年平均',
      data: analysis.avgMid,
      borderColor: '#ff4466',
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.35,
      fill: false,
    });
  }
  if (analysis.avgPres.length) {
    datasets.push({
      label: '總統選舉年平均',
      data: analysis.avgPres,
      borderColor: '#00d4ff',
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.35,
      fill: false,
    });
  }
  datasets.push({
    label: '全部年份平均',
    data: analysis.avgAll,
    borderColor: '#ffffff',
    borderWidth: 3,
    pointRadius: 0,
    tension: 0.35,
    fill: false,
  });

  return { labels, datasets };
}

function renderSeasonalChart(analysis, marketId) {
  const canvas = document.getElementById('seasonalChart');
  if (!canvas || typeof Chart === 'undefined') return;

  const { labels, datasets } = buildSeasonalChartDatasets(analysis, marketId);
  const ticks = monthTickIndices(analysis.maxLen);

  if (_seasonalChart) _seasonalChart.destroy();

  _seasonalChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: '#9ca3af', font: { size: 10 }, boxWidth: 12 },
        },
        title: {
          display: true,
          text: `${MARKETS[marketId].name} Seasonal Pattern 2000–2025 (% Change YTD)`,
          color: '#00d4ff',
          font: { size: 13 },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#6b7280',
            maxTicksLimit: 12,
            callback: (val, i) => {
              const idx = ticks.indexOf(i);
              return idx >= 0 ? MONTH_LABELS[idx] : '';
            },
          },
          grid: { color: 'rgba(31,45,64,0.5)' },
        },
        y: {
          title: { display: true, text: 'Percent Change', color: '#6b7280' },
          ticks: { color: '#6b7280', callback: v => v + '%' },
          grid: { color: 'rgba(31,45,64,0.5)' },
        },
      },
    },
  });
}

function switchSeasonalMarket(market) {
  if (!MARKETS[market]) return;
  _seasonalMarket = market;
  document.querySelectorAll('.seasonal-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.market === market);
  });
  if (market === 'sp500' && !_seasonalData.sp500 && !_seasonalErrors.sp500 && !_sp500Loading) {
    loadSeasonalMarket('sp500', MARKETS.sp500).then(() => renderSeasonalView(market));
    renderSeasonalView(market);
    return;
  }
  renderSeasonalView(market);
}

function toggleSeasonalYearLines() {
  _showYearLines = !_showYearLines;
  const btn = document.getElementById('seasonalToggleYears');
  if (btn) btn.textContent = _showYearLines ? '隱藏個別年份線' : '顯示 20 年堆疊線';
  if (_seasonalData[_seasonalMarket]) renderSeasonalView(_seasonalMarket);
}

function renderSeasonalView(market) {
  const analysis = _seasonalData[market];
  const err = _seasonalErrors[market];
  const status = document.getElementById('seasonalStatus');
  const advice = document.getElementById('seasonalAiAdvice');

  if (!analysis) {
    if (status) {
      const loadingSp = market === 'sp500' && _sp500Loading;
      status.innerHTML = err
        ? `<div class="error-panel" style="font-size:12px;">⚠️ ${MARKETS[market].name}：${err}</div>`
        : loadingSp
          ? '<div class="loading"><span class="spinner"></span>載入 S&P 歷史資料…</div>'
          : '<div class="loading"><span class="spinner"></span>載入歷史資料…</div>';
    }
    if (advice) advice.innerHTML = '';
    const mt = document.getElementById('seasonalMonthlyTable');
    const wt = document.getElementById('seasonalWeeklyTable');
    if (mt) mt.innerHTML = '';
    if (wt) wt.innerHTML = '';
    const leg = document.getElementById('seasonalElectionLegend');
    if (leg) leg.innerHTML = '';
    return;
  }

  if (status) {
    const range = analysis.dataFrom && analysis.dataTo
      ? ` · ${analysis.dataFrom}～${analysis.dataTo}`
      : '';
    status.innerHTML = `<span class="data-badge data-live">● ${analysis.sampleYears} 年 · ${analysis.barCount?.toLocaleString() || '—'} 交易日${range} · ${MARKETS[market].name}</span>`;
  }
  if (advice) {
    advice.innerHTML = `
      <div class="stat-card" style="border-color:var(--accent);margin-top:10px;">
        <div class="stat-label">🤖 AI 季節性判別建議</div>
        <div style="font-size:12px;line-height:1.8;color:var(--text);white-space:pre-line;margin-top:6px;">${seasonalAiAdvice(market, analysis)}</div>
      </div>`;
  }

  renderElectionLegend(market, analysis.yearNums);
  renderMonthlyTable(analysis.monthly, market);
  renderWeeklyTable(analysis.weekly, market);
  renderSeasonalChart(analysis, market);
}

let _seasonalLoadScheduled = false;
let _seasonalLoading = false;

async function loadSeasonalMarket(key, cfg) {
  if (key === 'sp500') _sp500Loading = true;
  try {
    const timeoutMs = key === 'twii' ? 95000 : 120000;
    const bars = await withTimeout(cfg.fetch(), timeoutMs, MARKETS[key].name);
    _seasonalData[key] = analyzeSeasonal(bars, key);
    _seasonalErrors[key] = null;
  } catch (e) {
    console.error('seasonal', key, e);
    _seasonalData[key] = null;
    _seasonalErrors[key] = e.message || '載入失敗';
  } finally {
    if (key === 'sp500') _sp500Loading = false;
  }
}

async function loadSeasonalAnalysis() {
  if (_seasonalLoading) return;
  const panel = document.getElementById('seasonalPanel');
  if (!panel) return;

  _seasonalLoading = true;
  const status = document.getElementById('seasonalStatus');
  if (status) status.innerHTML = '<div class="loading"><span class="spinner"></span>載入台股 2000–2025 真實歷史…</div>';

  await loadSeasonalMarket('twii', MARKETS.twii);

  _seasonalLoading = false;
  renderSeasonalView(_seasonalMarket);
}

/** 主看板載入完成後再抓季節性，避免與 FinMind / Yahoo 搶連線 */
function scheduleSeasonalLoad() {
  if (_seasonalLoadScheduled || !document.getElementById('seasonalPanel')) return;
  _seasonalLoadScheduled = true;
  setTimeout(loadSeasonalAnalysis, 1500);
}
