// =====================================================
// 台指選擇權 OI 支撐壓力 · TXO 當月換月
// =====================================================

const OI_OPTION_ID = 'TXO';
const OI_CACHE_KEY = 'txo_oi_panel_v2';
const OI_CACHE_TTL = 5 * 60 * 1000;
const OI_ROLL_DAYS = 5;

let _oiLoading = false;

function isMonthlyContract(cd) {
  return /^\d{6}$/.test(String(cd || ''));
}

function contractLabel(cd) {
  if (isMonthlyContract(cd)) return `${cd.slice(0, 4)}/${cd.slice(4, 6)}月`;
  return cd;
}

function thirdWednesday(year, month) {
  const d = new Date(year, month - 1, 1);
  let n = 0;
  while (d.getMonth() === month - 1) {
    if (d.getDay() === 3) {
      n += 1;
      if (n === 3) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}

function contractExpiryDate(cd) {
  if (!isMonthlyContract(cd)) return null;
  return thirdWednesday(parseInt(cd.slice(0, 4), 10), parseInt(cd.slice(4, 6), 10));
}

function daysBetween(a, b) {
  const ms = 86400000;
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / ms);
}

function fmtDate(d) {
  if (!d) return '—';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 單日 OI：優先 position（日盤）；若 OI 全 0 則合併各時段取最大 OI */
function rowsForDateOi(allRows, date) {
  const dayRows = allRows.filter(r => r.date === date);
  const position = dayRows.filter(r => r.trading_session === 'position');
  const posOi = position.reduce((s, r) => s + (Number(r.open_interest) || 0), 0);
  if (position.length && posOi > 0) return { rows: position, session: 'position' };

  const merged = mergeDaySessions(dayRows);
  const mergedOi = merged.reduce((s, r) => s + (Number(r.open_interest) || 0), 0);
  if (mergedOi > 0) return { rows: merged, session: 'merged' };

  return { rows: position.length ? position : merged, session: position.length ? 'position' : 'empty' };
}

function mergeDaySessions(dayRows) {
  const map = new Map();
  for (const r of dayRows) {
    const key = `${r.contract_date}|${r.strike_price}|${r.call_put}`;
    const oi = Number(r.open_interest) || 0;
    const prev = map.get(key);
    if (!prev || oi > (Number(prev.open_interest) || 0)) map.set(key, { ...r, open_interest: oi });
  }
  return [...map.values()];
}

function monthlyOiTotal(rows) {
  return rows
    .filter(r => isMonthlyContract(r.contract_date))
    .reduce((s, r) => s + (Number(r.open_interest) || 0), 0);
}

/** 取最近一個「有真實 OI」的交易日（避開僅 after_market 且 OI=0 的當日） */
function pickOiSnapshotDates(allRows) {
  const dates = [...new Set(allRows.map(r => r.date))].sort();
  let latest = null;
  let latestPack = null;

  for (let i = dates.length - 1; i >= 0; i--) {
    const pack = rowsForDateOi(allRows, dates[i]);
    if (monthlyOiTotal(pack.rows) > 100) {
      latest = dates[i];
      latestPack = pack;
      break;
    }
  }

  if (!latest) throw new Error('無有效 OI 資料（FinMind position 日盤尚未更新）');

  let prev = null;
  let prevPack = null;
  for (let i = dates.indexOf(latest) - 1; i >= 0; i--) {
    const pack = rowsForDateOi(allRows, dates[i]);
    if (monthlyOiTotal(pack.rows) > 100) {
      prev = dates[i];
      prevPack = pack;
      break;
    }
  }

  return {
    latest,
    prev,
    todayRows: latestPack.rows,
    prevRows: prevPack ? prevPack.rows : [],
    session: latestPack.session,
  };
}

function totalOiByMonth(rows) {
  const m = {};
  for (const r of rows) {
    if (!isMonthlyContract(r.contract_date)) continue;
    const cd = r.contract_date;
    m[cd] = (m[cd] || 0) + (Number(r.open_interest) || 0);
  }
  return m;
}

function pickActiveMonth(rows, refDate = new Date()) {
  const today = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  const monthly = totalOiByMonth(rows);
  const entries = Object.entries(monthly).map(([cd, oi]) => ({
    cd,
    oi,
    exp: contractExpiryDate(cd),
  }));

  const unexpired = entries.filter(e => e.exp && e.exp >= today);
  const pool = unexpired.length ? unexpired : entries;
  pool.sort((a, b) => b.oi - a.oi);
  const active = pool[0];
  if (!active || active.oi <= 0) return null;

  const calNext = entries
    .filter(e => e.cd > active.cd && e.exp && e.exp >= today)
    .sort((a, b) => a.cd.localeCompare(b.cd))[0];

  const daysToExp = active.exp ? daysBetween(today, active.exp) : null;
  let rollPhase = '當月主力';
  if (calNext && active.oi > 0) {
    const ratio = calNext.oi / active.oi;
    if (daysToExp != null && daysToExp <= OI_ROLL_DAYS) {
      rollPhase = ratio >= 0.35 ? '換月至次月' : '結算週·留意換月';
    } else if (ratio >= 0.55) {
      rollPhase = '次月 OI 升溫';
    }
  }

  return {
    activeMonth: active.cd,
    activeOi: active.oi,
    expiry: active.exp,
    daysToExpiry: daysToExp,
    nextMonth: calNext?.cd || null,
    nextOi: calNext?.oi || 0,
    rollPhase,
  };
}

function aggregateStrikeOi(rows, contractMonth) {
  const calls = {};
  const puts = {};
  for (const r of rows) {
    if (r.contract_date !== contractMonth) continue;
    const strike = Math.round(Number(r.strike_price));
    const oi = Number(r.open_interest) || 0;
    if (!strike || oi <= 0) continue;
    if (r.call_put === 'call') calls[strike] = (calls[strike] || 0) + oi;
    else if (r.call_put === 'put') puts[strike] = (puts[strike] || 0) + oi;
  }
  return { calls, puts };
}

function maxOiEntry(map) {
  let best = null;
  for (const [k, v] of Object.entries(map)) {
    const oi = Number(v) || 0;
    if (oi <= 0) continue;
    if (!best || oi > best.oi) best = { strike: Number(k), oi };
  }
  return best;
}

function topOiEntries(map, limit = 5) {
  return Object.entries(map)
    .map(([s, oi]) => ({ strike: Number(s), oi: Number(oi) }))
    .filter(x => x.oi > 0)
    .sort((a, b) => b.oi - a.oi)
    .slice(0, limit);
}

function maxDeltaEntry(todayMap, prevMap) {
  let best = null;
  for (const [k, v] of Object.entries(todayMap)) {
    const oi = Number(v) || 0;
    if (oi <= 0) continue;
    const delta = oi - (Number(prevMap[Number(k)]) || 0);
    if (delta <= 0) continue;
    if (!best || delta > best.delta) best = { strike: Number(k), oi, delta };
  }
  return best;
}

function pctFromSpot(strike, spot) {
  if (!spot || !strike) return null;
  return ((strike - spot) / spot) * 100;
}

function buildOiSrRows(calls, puts, spot, highlights) {
  const seen = new Set();
  const rows = [];

  function addRow(strike, side, oi, delta, tag, role) {
    if (!oi || oi <= 0) return;
    const key = `${side}-${strike}-${tag}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ strike, side, oi, delta, tag, role, diff: pctFromSpot(strike, spot) });
  }

  const h = highlights;
  if (h.maxCall) addRow(h.maxCall.strike, '買權', h.maxCall.oi, null, '最大未平倉', '壓力');
  if (h.maxPut) addRow(h.maxPut.strike, '賣權', h.maxPut.oi, null, '最大未平倉', '支撐');
  if (h.maxCallDelta) {
    addRow(h.maxCallDelta.strike, '買權', h.maxCallDelta.oi, h.maxCallDelta.delta, '增量最大', '壓力增強');
  }
  if (h.maxPutDelta) {
    addRow(h.maxPutDelta.strike, '賣權', h.maxPutDelta.oi, h.maxPutDelta.delta, '增量最大', '支撐增強');
  }

  const callSorted = Object.entries(calls)
    .map(([s, oi]) => ({ strike: Number(s), oi: Number(oi) }))
    .filter(x => x.oi > 0 && (!spot || x.strike >= spot - 1200))
    .sort((a, b) => b.oi - a.oi)
    .slice(0, 8);
  const putSorted = Object.entries(puts)
    .map(([s, oi]) => ({ strike: Number(s), oi: Number(oi) }))
    .filter(x => x.oi > 0 && (!spot || x.strike <= spot + 1200))
    .sort((a, b) => b.oi - a.oi)
    .slice(0, 8);

  for (const x of callSorted) addRow(x.strike, '買權', x.oi, null, '高 OI', x.strike >= (spot || 0) ? '壓力' : '—');
  for (const x of putSorted) addRow(x.strike, '賣權', x.oi, null, '高 OI', x.strike <= (spot || Infinity) ? '支撐' : '—');

  rows.sort((a, b) => b.strike - a.strike);
  return rows;
}

async function fetchTxOptionDaily(startDate, endDate) {
  const dates = [];
  const d0 = new Date(`${startDate}T12:00:00`);
  const d1 = new Date(`${endDate}T12:00:00`);
  for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0, 10));
  }
  const useDates = dates.length ? dates.slice(-6) : recentOiDates(6);
  const parts = await Promise.allSettled(
    useDates.map(date => fetchFinMind({
      dataset: 'TaiwanOptionDaily',
      data_id: OI_OPTION_ID,
      start_date: date,
      end_date: date,
    })),
  );
  const merged = [];
  for (const p of parts) {
    if (p.status === 'fulfilled' && Array.isArray(p.value)) merged.push(...p.value);
  }
  return merged;
}

function recentOiDates(count = 6) {
  const out = [];
  const d = new Date();
  while (out.length < count) {
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() - 1);
  }
  return out.reverse();
}

async function getSpotForOi() {
  if (state.currentPrice && Number.isFinite(state.currentPrice)) return state.currentPrice;
  try {
    const hist = await fetchTaiexDailyHistory(5);
    if (hist.length) return hist[hist.length - 1].close;
  } catch (_) { /* ignore */ }
  return null;
}

async function analyzeTxOptionOi() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 8);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  const raw = await fetchTxOptionDaily(startDate, endDate);
  if (!raw?.length) throw new Error('台指選擇權資料為空');

  const snap = pickOiSnapshotDates(raw);
  const { latest, prev, todayRows, prevRows, session } = snap;

  const monthInfo = pickActiveMonth(todayRows, new Date(latest));
  if (!monthInfo?.activeMonth) throw new Error('無法判定當月契約');

  const { calls, puts } = aggregateStrikeOi(todayRows, monthInfo.activeMonth);
  const prevAgg = prev ? aggregateStrikeOi(prevRows, monthInfo.activeMonth) : { calls: {}, puts: {} };

  const maxCall = maxOiEntry(calls);
  const maxPut = maxOiEntry(puts);
  const maxCallDelta = prev ? maxDeltaEntry(calls, prevAgg.calls) : null;
  const maxPutDelta = prev ? maxDeltaEntry(puts, prevAgg.puts) : null;

  const spot = await getSpotForOi();
  const highlights = { maxCall, maxPut, maxCallDelta, maxPutDelta };
  const srRows = buildOiSrRows(calls, puts, spot, highlights);
  const top5Calls = topOiEntries(calls, 5);
  const top5Puts = topOiEntries(puts, 5);

  const calendarToday = end.toISOString().slice(0, 10);
  const dataNote = latest !== calendarToday
    ? `OI 取自 ${latest} 日盤（當日 FinMind 尚未更新 position）`
    : session === 'position'
      ? 'OI 取自日盤 position'
      : null;

  return {
    asOf: latest,
    prevDate: prev,
    spot,
    monthInfo,
    highlights,
    srRows,
    dataNote,
    top5Calls,
    top5Puts,
    totalCallOi: Object.values(calls).reduce((a, b) => a + b, 0),
    totalPutOi: Object.values(puts).reduce((a, b) => a + b, 0),
  };
}

function fmtOi(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString();
}

function fmtDelta(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + Math.round(n).toLocaleString();
}

function renderTopOiRankTable(title, items, sideClass, spot) {
  if (!items.length) {
    return `
      <div>
        <div class="stat-label" style="margin-bottom:6px;">${title}</div>
        <div class="hint" style="font-size:11px;">尚無資料</div>
      </div>`;
  }
  return `
    <div>
      <div class="stat-label" style="margin-bottom:6px;">${title}</div>
      <div style="overflow-x:auto;">
        <table class="fib-table">
          <thead>
            <tr><th>#</th><th>履約價</th><th>口數</th><th>距現價</th></tr>
          </thead>
          <tbody>
            ${items.map((x, i) => {
              const diff = pctFromSpot(x.strike, spot);
              const near = spot && diff != null && Math.abs(diff) < 1.5;
              return `<tr style="${near ? 'background:rgba(255,213,0,.07);' : ''}">
                <td style="color:var(--muted);">${i + 1}</td>
                <td class="gold ${sideClass}">${x.strike.toLocaleString()}${near ? ' ◀' : ''}</td>
                <td class="${sideClass}">${fmtOi(x.oi)} 口</td>
                <td class="${diff >= 0 ? 'up' : 'down'}">${diff != null ? (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%' : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderOptionsOiPanel(data) {
  const el = document.getElementById('optionsOiPanel');
  if (!el) return;

  const m = data.monthInfo;
  const h = data.highlights;
  const spotStr = data.spot ? data.spot.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—';
  const expStr = fmtDate(m.expiry);
  const daysStr = m.daysToExpiry != null ? `${m.daysToExpiry} 天` : '—';
  const rollClass = m.rollPhase.includes('換月') ? 'bear' : m.rollPhase.includes('次月') ? 'sideways' : 'bull';

  el.innerHTML = `
    <div style="margin-bottom:10px;">
      <span class="data-badge data-live">● ${data.asOf} · 台指選擇權 TXO</span>
      <span class="signal-pill ${rollClass}" style="margin-left:6px;">${m.rollPhase}</span>
    </div>
    ${data.dataNote ? `<div class="hint" style="margin-bottom:8px;font-size:11px;">ℹ️ ${data.dataNote}</div>` : ''}
    <div class="stat-label" style="margin-bottom:6px;">
      當月契約 <span class="gold">${contractLabel(m.activeMonth)}</span>
      · 結算 ${expStr}（剩 ${daysStr}）
      ${m.nextMonth ? ` · 次月 ${contractLabel(m.nextMonth)} OI ${fmtOi(m.nextOi)}` : ''}
    </div>
    <div style="font-size:10px;color:var(--muted);margin-bottom:10px;">
      加權現價 ${spotStr} · 買權 OI 合計 ${fmtOi(data.totalCallOi)} · 賣權 OI 合計 ${fmtOi(data.totalPutOi)}
      ${data.prevDate ? ` · 增量比較 ${data.prevDate} → ${data.asOf}` : ''}
    </div>
    <div class="grid-2" style="gap:8px;margin-bottom:12px;">
      <div class="stat-card">
        <div class="stat-label">買權 · 最大未平倉</div>
        <div class="stat-value down">${h.maxCall ? h.maxCall.strike.toLocaleString() : '—'}</div>
        <div class="stat-sub">${h.maxCall ? fmtOi(h.maxCall.oi) + ' 口' : '—'} · 壓力牆</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">賣權 · 最大未平倉</div>
        <div class="stat-value up">${h.maxPut ? h.maxPut.strike.toLocaleString() : '—'}</div>
        <div class="stat-sub">${h.maxPut ? fmtOi(h.maxPut.oi) + ' 口' : '—'} · 支撐牆</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">買權 · 增量最大</div>
        <div class="stat-value down">${h.maxCallDelta ? h.maxCallDelta.strike.toLocaleString() : '—'}</div>
        <div class="stat-sub">${h.maxCallDelta ? fmtDelta(h.maxCallDelta.delta) + ' 口' : '—'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">賣權 · 增量最大</div>
        <div class="stat-value up">${h.maxPutDelta ? h.maxPutDelta.strike.toLocaleString() : '—'}</div>
        <div class="stat-sub">${h.maxPutDelta ? fmtDelta(h.maxPutDelta.delta) + ' 口' : '—'}</div>
      </div>
    </div>
    <div class="grid-2" style="gap:12px;margin-bottom:14px;">
      ${renderTopOiRankTable('📈 買權 · 未平倉前五名', data.top5Calls, 'down', data.spot)}
      ${renderTopOiRankTable('📉 賣權 · 未平倉前五名', data.top5Puts, 'up', data.spot)}
    </div>
    <div class="stat-label" style="margin-bottom:6px;">📊 OI 支撐壓力表（${contractLabel(m.activeMonth)}）</div>
    <div style="overflow-x:auto;">
      <table class="fib-table">
        <thead>
          <tr>
            <th>履約價</th><th>類型</th><th>未平倉</th><th>增量</th><th>距現價</th><th>標記</th><th>意義</th>
          </tr>
        </thead>
        <tbody>
          ${data.srRows.length ? data.srRows.map(r => {
            const near = data.spot && r.diff != null && Math.abs(r.diff) < 1.5;
            const sideClass = r.side === '買權' ? 'down' : 'up';
            const roleClass = r.role.includes('壓') ? 'down' : r.role.includes('支') ? 'up' : 'neutral';
            return `<tr style="${near ? 'background:rgba(255,213,0,.07);' : ''}">
              <td class="gold">${r.strike.toLocaleString()}${near ? ' ◀' : ''}</td>
              <td class="${sideClass}">${r.side}</td>
              <td>${fmtOi(r.oi)}</td>
              <td class="${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : 'neutral'}">${r.delta != null ? fmtDelta(r.delta) : '—'}</td>
              <td class="${r.diff >= 0 ? 'up' : 'down'}">${r.diff != null ? (r.diff >= 0 ? '+' : '') + r.diff.toFixed(2) + '%' : '—'}</td>
              <td style="color:var(--muted);font-size:10px;">${r.tag}</td>
              <td class="${roleClass}">${r.role}</td>
            </tr>`;
          }).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:12px;">尚無 OI 資料</td></tr>'}
        </tbody>
      </table>
    </div>
    <div style="font-size:10px;color:var(--muted);margin-top:8px;line-height:1.6;">
      買權高 OI 履約價常形成上方壓力（Call Wall）；賣權高 OI 履約價常形成下方支撐（Put Wall）。
      結算前 ${OI_ROLL_DAYS} 日台指選擇權通常自動換月至次月契約。OI 以 FinMind <b>position</b> 日盤為準。
    </div>`;
}

function renderOptionsOiError(msg) {
  const el = document.getElementById('optionsOiPanel');
  if (!el) return;
  el.innerHTML = `<div class="error-panel" style="font-size:12px;">
    ⚠️ ${msg}
    <div style="margin-top:10px;">
      <button class="btn btn-sm btn-outline" type="button" onclick="_oiLoading=false;loadOptionsOiPanel(true)">重新載入</button>
    </div>
  </div>`;
}

function renderOptionsOiLoading() {
  const el = document.getElementById('optionsOiPanel');
  if (!el) return;
  el.innerHTML = '<div class="loading"><span class="spinner"></span>載入台指選擇權 OI…</div>';
}

async function loadOptionsOiPanel(force = false) {
  const host = document.getElementById('optionsOiPanel');
  if (!host) return;
  if (_oiLoading && !force) return;

  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(OI_CACHE_KEY) || 'null');
      if (cached?.data && Date.now() - cached.ts < OI_CACHE_TTL) {
        renderOptionsOiPanel(cached.data);
        return;
      }
    } catch (_) { /* ignore */ }
  }

  _oiLoading = true;
  renderOptionsOiLoading();
  try {
    const data = await Promise.race([
      analyzeTxOptionOi(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('台指選 OI 載入逾時（資料量大，請再試一次）')), 90000)),
    ]);
    try {
      localStorage.setItem(OI_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch (_) { /* ignore */ }
    renderOptionsOiPanel(data);
  } catch (e) {
    console.error('options OI', e);
    renderOptionsOiError(e.message || '台指選擇權 OI 載入失敗');
  } finally {
    _oiLoading = false;
  }
}

function scheduleOptionsOiLoad() {
  if (!document.getElementById('optionsOiPanel')) return;
  setTimeout(() => loadOptionsOiPanel(true), 2000);
}
