/* manual-tabs.js — 手动交易三横签（2026-10-13）
   ① 图表与研判  ② 信号监测  ③ 持仓与极值
   只切可见面板，不改轮询 / id；K 线与信号仍由 cockpit.js 按 S.tab==='manual' 刷新。 */
(function () {
  function $(id) { return document.getElementById(id); }
  function setManualTab(name) {
    var tabs = document.querySelectorAll('#manualTabs .mtab');
    tabs.forEach(function (b) {
      var on = b.getAttribute('data-mtab') === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.manual-panel').forEach(function (p) {
      p.classList.toggle('hidden', p.getAttribute('data-panel') !== name);
    });
    try { localStorage.setItem('dsh.cockpit.manualTab', name); } catch (e) {}
    /* 切回图表时若 canvas 已在，触发一次重绘（resize 钩子已在 cockpit.js） */
    if (name === 'chart') {
      try {
        if (typeof renderKline === 'function') renderKline();
      } catch (e) {}
    }
    /* 同步持仓摘要副本 */
    syncPosDup();
  }
  function syncPosDup() {
    var map = [
      ['bal', 'posBal2'],
      ['posTxt', 'posTxt2'],
      ['funding', 'posFund2']
    ];
    map.forEach(function (pair) {
      var a = $(pair[0]), b = $(pair[1]);
      if (a && b) b.textContent = a.textContent || '--';
    });
  }
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('#manualTabs .mtab');
    if (!btn) return;
    setManualTab(btn.getAttribute('data-mtab'));
  });
  document.addEventListener('DOMContentLoaded', function () {
    var saved = 'chart';
    try { saved = localStorage.getItem('dsh.cockpit.manualTab') || 'chart'; } catch (e) {}
    if (['chart', 'signals', 'poshist'].indexOf(saved) < 0) saved = 'chart';
    setManualTab(saved);
    setInterval(syncPosDup, 3000);
  });
  /* 若脚本在 DOMContentLoaded 之后加载，立刻跑一次 */
  if (document.readyState !== 'loading') {
    var saved = 'chart';
    try { saved = localStorage.getItem('dsh.cockpit.manualTab') || 'chart'; } catch (e) {}
    if (['chart', 'signals', 'poshist'].indexOf(saved) < 0) saved = 'chart';
    setManualTab(saved);
    setInterval(syncPosDup, 3000);
  }
})();
