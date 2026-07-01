// 手機版底部導覽
function initMobileTabs() {
  const tabs = document.querySelectorAll('.mob-tab');
  const panels = document.querySelectorAll('.mob-panel');
  if (!tabs.length) return;

  function show(tab) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    panels.forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  }

  tabs.forEach(t => t.addEventListener('click', () => show(t.dataset.tab)));
  show('quote');
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
  saveFinMindToken(document.getElementById('finmindTokenInput')?.value || '');
  saveFredKey(document.getElementById('fredKeyInput')?.value || '');
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
});
