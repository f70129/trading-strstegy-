// 手機版底部導覽

function initMobileTabs() {
  if (window._mobileTabsInited) return;
  window._mobileTabsInited = true;

  const tabs = document.querySelectorAll('.mob-tab');
  const panels = document.querySelectorAll('.mob-panel:not(#tab-volume)');
  if (!tabs.length) return;

  function show(tab) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    panels.forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
    window.scrollTo(0, 0);
  }

  tabs.forEach(t => t.addEventListener('click', () => {
    show(t.dataset.tab);
    if (t.dataset.tab === 'market' && typeof loadOptionsOiPanel === 'function') {
      loadOptionsOiPanel(false);
    }
  }));
  show('quote');
}



function updateMobileSettingsUI() {
  const hint = document.getElementById('cloudSecretHint');
  const block = document.getElementById('tokenSettingsBlock');
  const pwaHint = document.getElementById('pwaTokenHint');
  if (!hint) return;
  const cloudOk = window._cloudHasFred && window._cloudFinMindValid;
  const cloudTokenBad = window._cloudHasFinMind && window._cloudFinMindValid === false;
  if (cloudOk) {
    hint.style.display = 'block';
    hint.innerHTML = '✓ Netlify 已內建 FinMind + FRED，手機<strong>免填 Token</strong>，開啟即用。';
    if (block) block.style.display = 'none';
  } else {
    hint.style.display = cloudTokenBad ? 'none' : 'block';
    if (block) block.style.display = 'block';
    if (cloudTokenBad && pwaHint) {
      pwaHint.style.display = 'block';
      pwaHint.innerHTML = '⚠️ Netlify 雲端 FinMind Token <strong>已失效</strong>。請在下方填入 <a href="https://finmindtrade.com" target="_blank" rel="noopener" style="color:var(--accent);">finmindtrade.com</a> 的新 Token 後按「儲存並重新載入」。';
    }
  }
}

function updateMobileTokenStatus() {
  const el = document.getElementById('tokenStatus');
  if (!el) return;

  const userToken = typeof getFinMindToken === 'function' ? getFinMindToken() : '';

  if (window._cloudFinMindValid && !userToken) {
    el.className = 'data-badge data-live';
    el.textContent = '● Token 由 Netlify 提供';
    return;
  }

  if (window._cloudHasFinMind && window._cloudFinMindValid === false && !userToken) {
    el.className = 'data-badge data-error';
    el.textContent = '● 雲端 Token 失效';
    return;
  }

  if (userToken) {
    el.className = 'data-badge data-live';
    el.textContent = `● Token 已儲存 (${userToken.slice(0, 4)}…)`;
  } else {
    el.className = 'data-badge data-error';
    el.textContent = '● 未設定 Token';
  }
}



function saveProxyHost() {

  const v = (document.getElementById('proxyHostInput')?.value || '').trim()

    .replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (v) localStorage.setItem('proxyHost', v);

  else localStorage.removeItem('proxyHost');

  checkProxyHealth();

  alert('代理位址已儲存，正在重新載入…');

  loadSymbol();

}



function saveMobileSettings() {

  const fm = (document.getElementById('finmindTokenInput')?.value || '').trim();

  const fk = (document.getElementById('fredKeyInput')?.value || '').trim();

  if (!fm && !(typeof window._cloudFinMindValid !== 'undefined' && window._cloudFinMindValid)) {
    alert('請填入 FinMind Token（finmindtrade.com 免費取得），或請管理員更新 Netlify 的 FINMIND_TOKEN');

    return;

  }

  saveFinMindToken(fm);

  saveFredKey(fk);

  updateMobileTokenStatus();

  if (typeof isCloudDeployed === 'function' && isCloudDeployed()) {

    alert('已儲存！正在重新載入…');

    loadSymbol();

    return;

  }

  saveProxyHost();

}



document.addEventListener('DOMContentLoaded', () => {

  const ph = document.getElementById('proxyHostInput');

  const proxyBlock = document.getElementById('proxyHostBlock');

  if (typeof isCloudDeployed === 'function' && isCloudDeployed()) {

    if (proxyBlock) proxyBlock.style.display = 'none';

    const cloudHint = document.getElementById('cloudHint');

    if (cloudHint) cloudHint.style.display = 'block';

  } else if (ph) {

    ph.value = localStorage.getItem('proxyHost') || '';

  }

  const fk = document.getElementById('fredKeyInput');

  if (fk) fk.value = getFredKey();

  const fm = document.getElementById('finmindTokenInput');

  if (fm) fm.value = getFinMindToken();

  updateMobileTokenStatus();



  const pwaHint = document.getElementById('pwaTokenHint');

  if (pwaHint && typeof isStandalonePWA === 'function' && isStandalonePWA()) {
    pwaHint.style.display = 'block';
  }

  initMobileTabs();
});

if (document.readyState !== 'loading') initMobileTabs();

