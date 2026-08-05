// =====================================================
// 融資餘額追蹤 · FinMind 籌碼面
// =====================================================

const MARGIN_CACHE_PREFIX = 'margin_panel_v2_';
const MARGIN_CACHE_TTL = 10 * 60 * 1000;
const MARGIN_HISTORY_DAYS = 60;
const MARGIN_CHART_DAYS = 30;

let _marginLoading = false;
let _marginSymbol = '';
let _marginChart = null;

function marginCacheKey(rawInput) {
  const kind = classifySymbol(rawInput || '^TWII');
  if (kind.kind === 'stock') return `${MARGIN_CACHE_PREFIX}stock_${kind.id}`;
  if (kind.kind === 'taiex') return `${MARGIN_CACHE_PREFIX}market`;
  return `${MARGIN_CACHE_PREFIX}na_${(rawInput || '').toUpperCase()}`;
}

function marginDateRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}

function fmtNum(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtMoneyYi(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)} 億`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)} 萬`;
  return fmtNum(n);
}

function deltaClass(n) {
  if (n == null || !Number.isFinite(n) || n === 0) return 'gold';
  return n > 0 ? 'green' : 'red';
}

function maintenanceClass(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'gold';
  if (pct >= 150) return 'green';
  if (pct >= 130) return 'gold';
  return 'red';
}

function maintenanceLabel(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  if (pct >= 150) return '安全';
  if (pct >= 130) return '留意';
  return '追繳風險';
}

function marginTrendSignal(change5, change20, pct5) {
  if (change5 == null || change20 == null) return { tag: 'neutral', label: '資料不足', note: '—' };
  if (change5 > 0 && change20 > 0) {
    return {
      tag: 'bull',
      label: '融資增溫',
      note: pct5 > 3
        ? '近 5 日融資餘額明顯增加，槓桿偏多；若指數已高檔需留意追繳風險。'
        : '融資餘額緩步上升，市場做多意願偏強。',
    };
  }
  if (change5 < 0 && change20 < 0) {
    return {
      tag: 'bear',
      label: '融資降溫',
      note: pct5 < -3
        ? '近 5 日融資大幅減少，槓桿去化或避險降倉。'
        : '融資餘額緩步下降，市場槓桿偏保守。',
    };
  }
  return {
    tag: 'neutral',
    label: '方向拉鋸',
    note: '短中期融資變化不一致，籌碼面尚未形成明確方向。',
  };
}

function analyzeMarginSeries(points) {
  if (!points?.length) throw new Error('無融資餘額資料');
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
  const d5 = sorted.length > 5 ? sorted[sorted.length - 6] : sorted[0];
  const d20 = sorted.length > 20 ? sorted[sorted.length - 21] : sorted[0];

  const dayDelta = prev ? latest.balance - prev.balance : null;
  const dayPct = prev && prev.balance ? (dayDelta / prev.balance) * 100 : null;
  const change5 = latest.balance - d5.balance;
  const change20 = latest.balance - d20.balance;
  const pct5 = d5.balance ? (change5 / d5.balance) * 100 : null;
  const pct20 = d20.balance ? (change20 / d20.balance) * 100 : null;

  const recent = sorted.slice(-10).reverse();
  const signal = marginTrendSignal(change5, change20, pct5);

  return {
    latest,
    prev,
    dayDelta,
    dayPct,
    change5,
    change20,
    pct5,
    pct20,
    recent,
    signal,
    bars: sorted.length,
    series: sorted,
  };
}

function mergeMaintenanceIntoPoints(points, maintenanceSeries) {
  if (!maintenanceSeries?.length) return points;
  const map = Object.fromEntries(maintenanceSeries.map(r => [r.date, r]));
  return points.map(p => ({
    ...p,
    maintenance: map[p.date]?.maintenance ?? p.maintenance ?? null,
    maintenanceEstimated: map[p.date]?.estimated ?? p.maintenanceEstimated ?? false,
  }));
}

/** FinMind 大盤融資維持率（Backer/Sponsor；有 token 時優先） */
async function fetchMarketMaintenanceRange(range) {
  try {
    const rows = await fetchFinMind({
      dataset: 'TaiwanTotalExchangeMarginMaintenance',
      ...range,
    });
    const series = (rows || [])
      .map(r => ({
        date: r.date,
        maintenance: Number(r.TotalExchangeMarginMaintenance),
        estimated: false,
      }))
      .filter(r => r.date && Number.isFinite(r.maintenance) && r.maintenance > 0);
    return series.length ? series : null;
  } catch (e) {
    console.warn('market maintenance api', e.message);
    return null;
  }
}

/** 大盤維持率估算：擔保品（張數）/ 融資金額 變化遞推 */
function estimateMarketMaintenance(points) {
  if (!points.length) return [];
  let est = 167;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const prev = points[i - 1];
      const shareRatio = prev.balance > 0 ? p.balance / prev.balance : 1;
      const moneyRatio = prev.moneyBalance > 0 && p.moneyBalance > 0
        ? p.moneyBalance / prev.moneyBalance
        : shareRatio;
      est = est * (shareRatio / moneyRatio);
      est = Math.max(100, Math.min(300, est));
    }
    out.push({ date: p.date, maintenance: est, estimated: true });
  }
  return out;
}

async function fetchStockPrices(stockId, range) {
  const rows = await fetchFinMind({
    dataset: 'TaiwanStockPrice',
    data_id: stockId,
    ...range,
  });
  return (rows || []).filter(r => r.date && r.close != null);
}

/** 加權指數收盤價（依日期對照，供融資圖疊加） */
async function fetchTwiiIndexMap(days = MARGIN_CHART_DAYS + 15) {
  try {
    if (typeof fetchTaiexDailyHistory === 'function') {
      const hist = await fetchTaiexDailyHistory(days);
      const map = {};
      for (const b of hist || []) {
        if (b?.date && b.close > 0) map[b.date] = b.close;
      }
      if (Object.keys(map).length >= 5) return map;
    }
  } catch (e) {
    console.warn('twii index finmind', e.message);
  }

  try {
    if (typeof fetchYahooChart === 'function') {
      const pd = await fetchYahooChart('^TWII');
      const map = {};
      const len = pd.closes?.length || 0;
      for (let i = 0; i < len; i++) {
        const ts = pd.timestamps?.[i];
        const c = pd.closes[i];
        if (!ts || !c) continue;
        const date = new Date(ts * 1000).toISOString().slice(0, 10);
        map[date] = c;
      }
      if (Object.keys(map).length >= 5) return map;
    }
  } catch (e) {
    console.warn('twii index yahoo', e.message);
  }

  return {};
}

/** 個股維持率估算：依價格與融資流量追蹤借款餘額 */
function estimateStockMaintenance(points, priceRows) {
  const priceByDate = Object.fromEntries(
    (priceRows || []).map(r => [r.date, Number(r.close) || 0]),
  );
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const LTV = 0.6;
  let loanEst = null;
  const out = [];

  for (const p of sorted) {
    const close = priceByDate[p.date];
    if (!close || !p.balance) continue;
    const collateral = close * p.balance * 1000;

    if (loanEst == null) {
      loanEst = collateral * LTV;
    } else {
      loanEst += (p.buy - p.sell) * close * 1000 * LTV;
      loanEst -= (p.returnShares || 0) * close * 1000 * 0.5;
      const targetLoan = collateral * LTV;
      loanEst = loanEst * 0.65 + targetLoan * 0.35;
    }
    loanEst = Math.max(loanEst, collateral * 0.25);
    const maintenance = loanEst > 0 ? (collateral / loanEst) * 100 : null;
    out.push({
      date: p.date,
      maintenance: maintenance != null ? Math.max(80, Math.min(300, maintenance)) : null,
      estimated: true,
    });
  }
  return out;
}

async function fetchMarketMargin(days = MARGIN_HISTORY_DAYS) {
  const range = marginDateRange(days);
  const rows = await fetchFinMind({
    dataset: 'TaiwanStockTotalMarginPurchaseShortSale',
    ...range,
  });

  const byDate = {};
  for (const r of rows || []) {
    if (!r.date || !r.name) continue;
    if (!byDate[r.date]) byDate[r.date] = { date: r.date };
    byDate[r.date][r.name] = r;
  }

  let points = Object.values(byDate)
    .map(d => {
      const mp = d.MarginPurchase;
      const money = d.MarginPurchaseMoney;
      const ss = d.ShortSale;
      if (!mp) return null;
      return {
        date: d.date,
        balance: Number(mp.TodayBalance) || 0,
        prevBalance: Number(mp.YesBalance) || 0,
        buy: Number(mp.buy) || 0,
        sell: Number(mp.sell) || 0,
        returnShares: Number(mp.Return) || 0,
        moneyBalance: money ? Number(money.TodayBalance) || 0 : null,
        shortBalance: ss ? Number(ss.TodayBalance) || 0 : null,
      };
    })
    .filter(Boolean);

  if (!points.length) throw new Error('大盤融資資料為空');

  let maintenanceSeries = await fetchMarketMaintenanceRange(range);
  let maintenanceSource = 'FinMind 大盤融資維持率';
  if (!maintenanceSeries?.length) {
    maintenanceSeries = estimateMarketMaintenance(points);
    maintenanceSource = '估算（張數 ÷ 融資金額變化）';
  }

  points = mergeMaintenanceIntoPoints(points, maintenanceSeries);
  const analysis = analyzeMarginSeries(points);
  const latestRow = byDate[analysis.latest.date] || {};
  const latestMaint = analysis.latest.maintenance;
  const prevMaintPoint = analysis.series.length > 1
    ? analysis.series[analysis.series.length - 2]
    : null;

  return {
    scope: 'market',
    title: '台股整體融資餘額',
    subtitle: '上市 + 上櫃合計 · FinMind 每日 21:00 更新',
    unit: '張',
    maintenanceSource,
    maintenanceEstimated: maintenanceSeries?.[0]?.estimated ?? false,
    maintenance: latestMaint,
    maintenanceDayDelta: prevMaintPoint?.maintenance != null && latestMaint != null
      ? latestMaint - prevMaintPoint.maintenance
      : null,
    maintenanceSeries,
    ...analysis,
    moneyBalance: analysis.latest.moneyBalance,
    shortBalance: analysis.latest.shortBalance,
    latestBuy: analysis.latest.buy,
    latestSell: analysis.latest.sell,
    latestReturn: analysis.latest.returnShares,
    shortDayDelta: latestRow.ShortSale
      ? (Number(latestRow.ShortSale.TodayBalance) || 0) - (Number(latestRow.ShortSale.YesBalance) || 0)
      : null,
  };
}

async function fetchStockMargin(stockId, days = MARGIN_HISTORY_DAYS) {
  const range = marginDateRange(days);
  const [rows, priceRows] = await Promise.all([
    fetchFinMind({
      dataset: 'TaiwanStockMarginPurchaseShortSale',
      data_id: stockId,
      ...range,
    }),
    fetchStockPrices(stockId, range),
  ]);

  let points = (rows || [])
    .map(r => ({
      date: r.date,
      balance: Number(r.MarginPurchaseTodayBalance) || 0,
      prevBalance: Number(r.MarginPurchaseYesterdayBalance) || 0,
      buy: Number(r.MarginPurchaseBuy) || 0,
      sell: Number(r.MarginPurchaseSell) || 0,
      returnShares: Number(r.MarginPurchaseCashRepayment) || 0,
      shortBalance: Number(r.ShortSaleTodayBalance) || 0,
      shortPrev: Number(r.ShortSaleYesterdayBalance) || 0,
      limit: Number(r.MarginPurchaseLimit) || null,
    }))
    .filter(r => r.date);

  if (!points.length) throw new Error(`查無 ${stockId} 融資資料（可能為 ETF 或無信用交易）`);

  const maintenanceSeries = estimateStockMaintenance(points, priceRows);
  points = mergeMaintenanceIntoPoints(points, maintenanceSeries);
  const analysis = analyzeMarginSeries(points);
  const prevMaintPoint = analysis.series.length > 1
    ? analysis.series[analysis.series.length - 2]
    : null;
  const latestMaint = analysis.latest.maintenance;

  return {
    scope: 'stock',
    title: `${stockId} 融資餘額`,
    subtitle: '個股信用交易 · FinMind 每日 21:00 更新',
    unit: '張',
    stockId,
    maintenanceSource: '估算（股價 × 融資張數 ÷ 借款餘額）',
    maintenanceEstimated: true,
    maintenance: latestMaint,
    maintenanceDayDelta: prevMaintPoint?.maintenance != null && latestMaint != null
      ? latestMaint - prevMaintPoint.maintenance
      : null,
    maintenanceSeries,
    ...analysis,
    shortBalance: analysis.latest.shortBalance,
    shortDayDelta: analysis.latest.shortBalance - (analysis.latest.shortPrev || 0),
    marginLimit: analysis.latest.limit,
    latestBuy: analysis.latest.buy,
    latestSell: analysis.latest.sell,
    latestReturn: analysis.latest.returnShares,
  };
}

function renderMarginChart(data) {
  const canvas = document.getElementById('marginChart');
  if (!canvas || typeof Chart === 'undefined') return;

  if (_marginChart) {
    _marginChart.destroy();
    _marginChart = null;
  }

  const slice = data.series.slice(-MARGIN_CHART_DAYS);
  const twiiMap = data.twiiMap || {};
  const labels = slice.map(p => p.date.slice(5));
  const balances = slice.map(p => p.balance);
  const deltas = slice.map((p, i) => {
    if (i === 0) return p.balance - (p.prevBalance ?? p.balance);
    return p.balance - slice[i - 1].balance;
  });
  const maintenance = slice.map(p => p.maintenance ?? null);
  const twiiCloses = slice.map(p => twiiMap[p.date] ?? null);
  const deltaColors = deltas.map(d => (d >= 0 ? 'rgba(0,230,118,0.75)' : 'rgba(255,68,102,0.75)'));

  const twiiValid = twiiCloses.filter(v => v != null && v > 0);
  const twiiMin = twiiValid.length ? Math.min(...twiiValid) : 0;
  const twiiMax = twiiValid.length ? Math.max(...twiiValid) : 0;
  const twiiPad = twiiValid.length ? (twiiMax - twiiMin) * 0.06 || twiiMax * 0.01 : 0;

  const datasets = [
    {
      type: 'bar',
      label: '每日增減',
      data: deltas,
      backgroundColor: deltaColors,
      borderWidth: 0,
      yAxisID: 'yDelta',
      order: 4,
    },
    {
      type: 'line',
      label: `融資餘額 (${data.unit})`,
      data: balances,
      borderColor: '#ffd700',
      backgroundColor: 'rgba(255,215,0,0.08)',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.15,
      yAxisID: 'yBalance',
      order: 2,
    },
    {
      type: 'line',
      label: '融資維持率 (%)',
      data: maintenance,
      borderColor: '#00d4ff',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.15,
      yAxisID: 'yMaint',
      spanGaps: true,
      order: 3,
    },
  ];

  if (twiiValid.length >= 3) {
    datasets.push({
      type: 'line',
      label: '加權指數',
      data: twiiCloses,
      borderColor: '#ff9500',
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.15,
      yAxisID: 'yIndex',
      spanGaps: true,
      order: 1,
    });
  }

  _marginChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#6b7280', font: { size: 10 } } },
        tooltip: {
          bodyColor: '#e2e8f0',
          titleColor: '#00d4ff',
          backgroundColor: '#111827',
          borderColor: '#1f2d40',
          borderWidth: 1,
          callbacks: {
            label(ctx) {
              const v = ctx.parsed.y;
              if (ctx.dataset.yAxisID === 'yMaint') return ` 維持率 ${v != null ? v.toFixed(1) + '%' : '—'}`;
              if (ctx.dataset.yAxisID === 'yIndex') return ` 加權 ${v != null ? fmtNum(v, 1) : '—'}`;
              if (ctx.dataset.yAxisID === 'yDelta') return ` 增減 ${v > 0 ? '+' : ''}${fmtNum(v)} ${data.unit}`;
              return ` 餘額 ${fmtNum(v)} ${data.unit}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#6b7280', maxTicksLimit: 8, font: { size: 10 } },
          grid: { color: '#1f2d40' },
        },
        yBalance: {
          type: 'linear',
          position: 'left',
          ticks: { color: '#ffd700', font: { size: 10 } },
          grid: { color: '#1f2d40' },
        },
        yIndex: twiiValid.length >= 3 ? {
          type: 'linear',
          position: 'right',
          min: twiiMin - twiiPad,
          max: twiiMax + twiiPad,
          ticks: {
            color: '#ff9500',
            font: { size: 10 },
            maxTicksLimit: 6,
            callback: v => fmtNum(v, 0),
          },
          grid: { drawOnChartArea: false },
        } : { display: false },
        yDelta: {
          type: 'linear',
          position: 'right',
          display: false,
          grid: { drawOnChartArea: false },
        },
        yMaint: {
          type: 'linear',
          position: 'right',
          min: 120,
          max: 200,
          display: false,
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

function renderMarginTable(recent, unit, showMoney = false) {
  if (!recent?.length) return '';
  const rows = recent.map(r => {
    const delta = r.prevBalance != null ? r.balance - r.prevBalance : null;
    return `<tr>
      <td>${r.date.slice(5)}</td>
      <td>${fmtNum(r.balance)} ${unit}</td>
      <td class="${deltaClass(delta)}">${delta == null ? '—' : (delta > 0 ? '+' : '') + fmtNum(delta)}</td>
      <td>${r.maintenance != null ? r.maintenance.toFixed(1) + '%' : '—'}</td>
      <td>${fmtNum(r.buy)}</td>
      <td>${fmtNum(r.sell)}</td>
      ${showMoney ? `<td>${fmtMoneyYi(r.moneyBalance)}</td>` : ''}
    </tr>`;
  }).join('');

  return `<div style="margin-top:10px;overflow-x:auto;">
    <table style="width:100%;font-size:11px;text-align:center;border-collapse:collapse;">
      <thead>
        <tr style="color:var(--muted);">
          <th style="padding:4px;">日期</th>
          <th style="padding:4px;">融資餘額</th>
          <th style="padding:4px;">增減</th>
          <th style="padding:4px;">維持率</th>
          <th style="padding:4px;">買進</th>
          <th style="padding:4px;">賣出</th>
          ${showMoney ? '<th style="padding:4px;">融資金額</th>' : ''}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderMarginPanel(data) {
  const el = document.getElementById('marginPanel');
  if (!el) return;

  const sigColor = data.signal.tag === 'bull' ? 'green' : data.signal.tag === 'bear' ? 'red' : 'gold';
  const showMoney = data.scope === 'market';
  const maintClass = maintenanceClass(data.maintenance);
  const maintNote = data.maintenanceEstimated ? '（估算）' : '';

  el.innerHTML = `
    <div style="font-size:10px;color:var(--muted);margin-bottom:8px;line-height:1.6;">
      ${data.subtitle}<br>
      資料日 <span class="gold">${data.latest.date}</span> · 共 ${data.bars} 個交易日
    </div>
    <div class="grid-2" style="gap:8px;margin-bottom:10px;">
      <div class="stat-card" style="border-color:var(--gold);">
        <div class="stat-label">融資餘額（${data.unit}）</div>
        <div class="stat-value" style="font-size:22px;">${fmtNum(data.latest.balance)}</div>
        <div class="stat-sub ${deltaClass(data.dayDelta)}">
          較前日 ${data.dayDelta == null ? '—' : (data.dayDelta > 0 ? '+' : '') + fmtNum(data.dayDelta)} ${data.unit}
          ${data.dayPct != null ? `（${fmtPct(data.dayPct)}）` : ''}
        </div>
      </div>
      <div class="stat-card" style="border-color:var(--accent);">
        <div class="stat-label">融資維持率${maintNote}</div>
        <div class="stat-value ${maintClass}" style="font-size:22px;">
          ${data.maintenance != null ? data.maintenance.toFixed(1) + '%' : '—'}
        </div>
        <div class="stat-sub ${maintClass}">
          ${maintenanceLabel(data.maintenance)}
          ${data.maintenanceDayDelta != null ? ` · 較前日 ${data.maintenanceDayDelta > 0 ? '+' : ''}${data.maintenanceDayDelta.toFixed(2)}%` : ''}
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:4px;">${data.maintenanceSource || ''}</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">
      近 ${MARGIN_CHART_DAYS} 日 · 柱狀＝每日增減 · 金線＝融資餘額 · 橘線＝加權指數 · 藍線＝維持率
    </div>
    <div class="chart-wrap" style="height:220px;margin-bottom:10px;">
      <canvas id="marginChart"></canvas>
    </div>
    <div class="grid-2" style="gap:8px;margin-bottom:10px;">
      <div class="stat-card">
        <div class="stat-label">籌碼方向</div>
        <div class="stat-value ${sigColor}" style="font-size:16px;">${data.signal.label}</div>
        <div class="stat-sub" style="font-size:11px;line-height:1.5;margin-top:4px;">${data.signal.note}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">5 日 / 20 日變化</div>
        <div style="font-size:13px;margin-top:4px;">
          <span class="${deltaClass(data.change5)}">5日 ${data.change5 > 0 ? '+' : ''}${fmtNum(data.change5)} ${data.unit} (${fmtPct(data.pct5)})</span><br>
          <span class="${deltaClass(data.change20)}" style="margin-top:4px;display:inline-block;">20日 ${data.change20 > 0 ? '+' : ''}${fmtNum(data.change20)} ${data.unit} (${fmtPct(data.pct20)})</span>
        </div>
      </div>
    </div>
    <div class="grid-2" style="gap:8px;margin-bottom:10px;">
      <div class="stat-card">
        <div class="stat-label">當日融資買 / 賣 / 現償</div>
        <div style="font-size:13px;margin-top:4px;">
          <span class="green">買 ${fmtNum(data.latestBuy)}</span> ·
          <span class="red">賣 ${fmtNum(data.latestSell)}</span> ·
          <span class="gold">償 ${fmtNum(data.latestReturn)}</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">融券餘額（${data.unit}）</div>
        <div class="stat-value" style="font-size:15px;">${fmtNum(data.shortBalance)}</div>
        <div class="stat-sub ${deltaClass(data.shortDayDelta)}">
          較前日 ${data.shortDayDelta == null ? '—' : (data.shortDayDelta > 0 ? '+' : '') + fmtNum(data.shortDayDelta)} ${data.unit}
        </div>
      </div>
    </div>
    ${showMoney ? `
    <div class="stat-card" style="margin-bottom:10px;border-color:var(--accent);">
      <div class="stat-label">融資金額（整體市場）</div>
      <div class="stat-value" style="font-size:18px;">${fmtMoneyYi(data.moneyBalance)}</div>
      <div class="stat-sub">上市上櫃合計信用買進餘額</div>
    </div>` : ''}
    ${data.marginLimit ? `
    <div style="font-size:10px;color:var(--muted);margin-bottom:6px;">
      融資限額 ${fmtNum(data.marginLimit)} 張 · 使用率 ${((data.latest.balance / data.marginLimit) * 100).toFixed(2)}%
    </div>` : ''}
    <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">近 10 日明細</div>
    ${renderMarginTable(data.recent, data.unit, showMoney)}
    <div style="font-size:10px;color:var(--muted);margin-top:8px;line-height:1.6;">
      維持率 &lt;130% 可能面臨追繳；&lt;120% 可能強制處分。柱狀圖綠色為融資增加、紅色為減少。
      ${data.maintenanceEstimated ? '個股／無 Sponsor API 時維持率為估算值，僅供籌碼參考。' : ''}
    </div>`;

  requestAnimationFrame(() => renderMarginChart(data));
}

function renderMarginError(msg) {
  const el = document.getElementById('marginPanel');
  if (!el) return;
  if (_marginChart) { _marginChart.destroy(); _marginChart = null; }
  el.innerHTML = `<div class="error-panel" style="font-size:12px;">⚠️ ${msg}</div>`;
}

function renderMarginNa(reason) {
  const el = document.getElementById('marginPanel');
  if (!el) return;
  if (_marginChart) { _marginChart.destroy(); _marginChart = null; }
  el.innerHTML = `<div class="stat-card" style="font-size:12px;color:var(--muted);line-height:1.6;">
    ${reason}
  </div>`;
}

function renderMarginLoading() {
  const el = document.getElementById('marginPanel');
  if (!el) return;
  if (_marginChart) { _marginChart.destroy(); _marginChart = null; }
  el.innerHTML = '<div class="loading"><span class="spinner"></span>載入融資餘額…</div>';
}

async function loadMarginPanel(rawInput, force = false) {
  const host = document.getElementById('marginPanel');
  if (!host || _marginLoading) return;

  const input = rawInput || document.getElementById('symbolInput')?.value?.trim() || '^TWII';
  _marginSymbol = input;
  const kind = classifySymbol(input);

  if (kind.kind === 'futures') {
    renderMarginNa('台指期貨無融資融券資料，請切換至加權指數或個股查看籌碼。');
    return;
  }
  if (kind.kind === 'yahoo') {
    renderMarginNa('此標的為海外／Yahoo 指數，FinMind 無融資餘額資料。請輸入台股代號（如 2330）或 ^TWII。');
    return;
  }

  const cacheKey = marginCacheKey(input);
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached?.data && Date.now() - cached.ts < MARGIN_CACHE_TTL) {
        renderMarginPanel(cached.data);
        return;
      }
    } catch (_) { /* ignore */ }
  }

  _marginLoading = true;
  renderMarginLoading();
  try {
    const data = kind.kind === 'stock'
      ? await fetchStockMargin(kind.id)
      : await fetchMarketMargin();
    data.twiiMap = await fetchTwiiIndexMap(MARGIN_CHART_DAYS + 15);
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
    } catch (_) { /* ignore */ }
    renderMarginPanel(data);
  } catch (e) {
    console.error('margin panel', e);
    renderMarginError(e.message || '融資餘額載入失敗');
  } finally {
    _marginLoading = false;
  }
}

function scheduleMarginLoad(rawInput) {
  if (!document.getElementById('marginPanel')) return;
  const input = rawInput || document.getElementById('symbolInput')?.value?.trim() || '^TWII';
  setTimeout(() => loadMarginPanel(input, false), 800);
}
