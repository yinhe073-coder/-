/* 工作流.js —— 量化工作流 7 步状态条（真实 owner/卡点/asOf；定向补，非整站重构）
 * 数据源：本目录 工作流.json（快照）；每步显示 name/owner/state/blocker/asOf。
 * 红线：只读展示，无任何下单/转账；工作流.json 加载失败即显「状态不可用」，不 mock 假绿。
 */
(function () {
  'use strict';
  var STATE_CLS = { done: 'wf-done', partial: 'wf-partial', gated: 'wf-gated', todo: 'wf-todo' };
  var STATE_TXT = { done: '已完成', partial: '进行中', gated: '门控中', todo: '待办' };

  function $(id) { return document.getElementById(id); }
  function mk(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function render(w) {
    var host = $('wfStrip');
    if (!host) return;
    if (!w || !Array.isArray(w.steps)) {
      host.appendChild(mk('div', 'wf-err', '工作流状态不可用（工作流.json 未取到，不 mock 假绿）'));
      return;
    }
    var head = mk('div', 'wf-head');
    head.appendChild(mk('span', 'wf-title', '量化工作流 · 7 步'));
    head.appendChild(mk('span', 'wf-meta', '当前第 ' + (w.current_step || '?') + ' 步 · 剩余 ' + (w.remaining || '?') + ' 步 · asOf ' + (w.asOf_bj || '—')));
    host.appendChild(head);
    // 同步状态（真实只读刷新结果，页面可见，非 notepad）
    if (w.sync) {
      var sb = mk('div', w.sync.ok ? 'wf-sync wf-sync-ok' : 'wf-sync wf-sync-bad');
      sb.textContent = w.sync.ok
        ? '只读同步 OK · asOf ' + (w.sync.asOf_bj || '—')
        : '只读同步 FAIL：' + (w.sync.error || '未知错误') + '（不伪实时，沿用既有快照）· asOf ' + (w.sync.asOf_bj || '—');
      host.appendChild(sb);
    }
    var row = mk('div', 'wf-row');
    w.steps.forEach(function (s, i) {
      var cell = mk('div', 'wf-cell ' + (STATE_CLS[s.state] || 'wf-todo'));
      cell.appendChild(mk('div', 'wf-sn', String(s.n)));
      cell.appendChild(mk('div', 'wf-st', s.name));
      cell.appendChild(mk('div', 'wf-sd', STATE_TXT[s.state] || s.state));
      cell.title = 'owner: ' + (s.owner || '—') + '\nsession: ' + (s.owner_session || '—') + '\n' + (s.detail || '') + '\nblocker: ' + (s.blocker || '无') + '\nasOf: ' + (s.asOf || '—') + '\nsource: ' + (s.source || '—');
      if (s.blocker) cell.appendChild(mk('div', 'wf-blk', '卡：' + s.blocker));
      cell.appendChild(mk('div', 'wf-as', 'owner ' + (s.owner || '—') + ' · ' + (s.asOf || '—')));
      cell.appendChild(mk('div', 'wf-sess', 'session ' + (s.owner_session || '—')));
      row.appendChild(cell);
      if (i < w.steps.length - 1) row.appendChild(mk('span', 'wf-arw', '›'));
    });
    host.appendChild(row);
  }

  function injectCss() {
    if (document.getElementById('wfCss')) return;
    var st = document.createElement('style');
    st.id = 'wfCss';
    st.textContent = '.wf-strip{margin:8px 0;padding:8px 10px;border:1px solid #2b3138;border-radius:8px;background:#161b22}' +
      '.wf-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px}' +
      '.wf-title{font-weight:700}.wf-meta{color:#8b949e;font-size:12px}' +
      '.wf-row{display:flex;flex-wrap:wrap;align-items:stretch;gap:4px}' +
      '.wf-cell{flex:1 1 120px;min-width:110px;padding:6px;border-radius:6px;border:1px solid #2b3138;background:#0d1117}' +
      '.wf-sn{font-weight:800;color:#58a6ff;font-size:12px}' +
      '.wf-st{font-size:13px;font-weight:600}' +
      '.wf-sd{font-size:11px;color:#8b949e}' +
      '.wf-blk{font-size:11px;color:#f0883e;margin-top:2px}' +
      '.wf-as{font-size:10px;color:#6e7681;margin-top:2px}' +
      '.wf-arw{align-self:center;color:#3d444d;font-size:16px}' +
      '.wf-done{border-color:#1f6f3b}.wf-done .wf-sn{color:#3fb950}' +
      '.wf-partial{border-color:#7a5c1e}.wf-partial .wf-sn{color:#d29922}' +
      '.wf-gated{border-color:#7a2e2a}.wf-gated .wf-sn{color:#f85149}' +
      '.wf-err,.wf-loading{color:#8b949e;font-size:12px}' +
      '.wf-sync{margin:4px 0 6px;padding:4px 8px;border-radius:6px;font-size:12px}' +
      '.wf-sync-ok{color:#a5e6b3;background:#12261a;border:1px solid #1f6f3b}' +
      '.wf-sync-bad{color:#ffb3ae;background:#2a1110;border:1px solid #7a2e2a}' +
      '.wf-sess{font-size:9px;color:#4b535d;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}';
    document.head.appendChild(st);
  }

  function init() {
    injectCss();
    var anchor = $('flow4');
    if (!anchor) { setTimeout(init, 300); return; }
    if ($('wfStrip')) return;
    var host = mk('div', 'wf-strip');
    host.id = 'wfStrip';
    host.appendChild(mk('div', 'wf-loading', '工作流状态加载中…'));
    anchor.parentNode.insertBefore(host, anchor.nextSibling);
    fetch('工作流.json?v=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (w) { host.innerHTML = ''; render(w); })
      .catch(function () { host.innerHTML = ''; host.appendChild(mk('div', 'wf-err', '工作流状态不可用（加载失败，不 mock 假绿）')); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
