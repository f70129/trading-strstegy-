// 手機版底部導覽

function initMobileTabs() {

  const tabs = document.querySelectorAll('.mob-tab');

  const panels = document.querySelectorAll('.mob-panel:not(#tab-volume)');

  if (!tabs.length) return;



  function show(tab) {

    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

    panels.forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));

  }



  tabs.forEach(t => t.addEventListener('click', () => show(t.dataset.tab)));

  show('quote');

}



function updateMobileSettingsUI() {
  const hint = document.getElementById('cloudSecretHint');
  const block = document.getElementById('tokenSettingsBlock');
  if (!hint) return;
  const builtIn = window._cloudHasFred && window._cloudHasFinMind;
  if (builtIn) {
    hint.style.display = 'block';
    if (block) block.style.display = 'none';
  }
}

function updateMobileTokenStatus() {

  const el = document.getElementById('tokenStatus');

  if (!el) return;

  if (typeof window._cloudHasFinMind !== 'undefined' && window._cloudHasFinMind) {

    el.className = 'data-badge data-live';

    el.textContent = '● Token 由 Netlify 提供';

    return;

  }

  const t = typeof getFinMindToken === 'function' ? getFinMindToken() : '';

  if (t) {

    el.className = 'data-badge data-live';

    el.textContent = `● Token 已儲存 (${t.slice(0, 4)}…)`;

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

  if (!fm && !(typeof window._cloudHasFinMind !== 'undefined' && window._cloudHasFinMind)) {

    alert('請填入 FinMind Token，或在 Netlify 後台設 FINMIND_TOKEN 環境變數');

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

});

