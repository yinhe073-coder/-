/* quant-bridge.js v4 — 2026-10-22：busy 在任何 await 前加锁；只有权威终态(完成/失败)且用户明确发起新任务才换 ID；
   queued/pending/unknown/查询失败一律保留原 ID 只查询，绝不新建或重复派发。 */
(function () {
  'use strict';
  var API = 'http://127.0.0.1:8097';
  var TERMINAL = { completed: 1, failed: 1, needs_human: 1 };
  var ZH = { queued: '已入队', pending: '待核', unknown: '未知待核', UNKNOWN: '未知待核', UNKNOWN_RECOVERY: '待核', RECOVERY_QUERY_ONLY: '待核', dispatch_unknown: '投递未知', rejected_not_sent: '未发送', completed: '完成', failed: '失败', needs_human: '需人工', unregistered: '未登记', not_found: '无记录', duplicate: '重复' };
  function zh(s) { return ZH[s] || s || '未知'; }
  function newRid() { var a = new Uint8Array(8); crypto.getRandomValues(a); return 'qb_' + Array.from(a).map(function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }
  function st(t) { var e = document.getElementById('qbStatus'); if (e) e.textContent = t; }
  function load() { try { return JSON.parse(localStorage.getItem('qb_last') || 'null'); } catch (e) { return null; } }
  function save(o) { try { localStorage.setItem('qb_last', JSON.stringify(o)); } catch (e) { } }
  function buttons() { return Array.prototype.slice.call(document.querySelectorAll('#qbDock button')); }
  function host() {
    var pane = document.getElementById('pane-overview'); if (!pane) return null;
    var w = document.getElementById('qbDock'); if (w) return w;
    w = document.createElement('div'); w.className = 'rdyCard'; w.id = 'qbDock';
    w.innerHTML = '<b>对话控制</b><div class="rdySmall">白名单任务发到本 3081 会话；真实资金/启停不由此执行。同一次操作只用一个请求 ID。</div>';
    var s = document.createElement('div'); s.className = 'rdySmall'; s.id = 'qbStatus';
    [['check_status', '检查状态'], ['diagnose_software', '诊断软件'], ['isolated_sim', '隔离模拟']].forEach(function (p) {
      var b = document.createElement('button'); b.className = 'rdyBtn'; b.textContent = p[1]; b.onclick = function () { send(p[0], b); }; w.appendChild(b);
    });
    var lk = document.createElement('button'); lk.className = 'rdyBtn'; lk.textContent = '查看最近结果'; lk.onclick = lookup; w.appendChild(lk);
    w.appendChild(s); pane.appendChild(w); return w;
  }
  async function getStatus(rid) {
    var r = await fetch(API + '/quant?requestId=' + rid, { cache: 'no-store' });
    var d = await r.json();
    if (!r.ok && d.status !== 'unregistered') throw new Error('HTTP ' + r.status);
    return d;
  }
  async function send(task, btn) {
    var dock = host(); if (!dock) return;
    if (dock.dataset.busy === '1') { st('处理中，已阻止重复点击'); return; }
    dock.dataset.busy = '1';                       // 任何 await 之前先锁
    buttons().forEach(function (b) { b.disabled = true; });
    try {
      var last = load(), rid = null;
      if (last && last.rid) {
        var q = null, qerr = null;
        try { q = await getStatus(last.rid); } catch (e) { qerr = e; }
        if (q && TERMINAL[q.status]) {
          rid = newRid(); save({ rid: rid, task: task, state: 'submitted' });
        } else if (q) {
          save({ rid: last.rid, task: last.task, state: q.status });
          st('上次「' + (last.task || '任务') + '」仍在' + zh(q.status) + '（同ID ' + last.rid.slice(0, 12) + '…），本次只查询，不新建、不重复派发');
          return;
        } else {
          st('查询上次结果失败（' + (qerr && qerr.message || '网络错误') + '）：保留原ID ' + last.rid.slice(0, 12) + '… 待核，本次不新建任务');
          return;
        }
      } else {
        rid = newRid(); save({ rid: rid, task: task, state: 'submitted' });
      }
      st('已提交（同ID ' + rid.slice(0, 12) + '…），等待回执…');
      var r, d;
      try {
        r = await fetch(API + '/quant', { method: 'POST', headers: { 'content-type': 'application/json', 'x-quant-bridge': '1' }, body: JSON.stringify({ taskId: task, requestId: rid }) });
        d = await r.json();
      } catch (e) {
        save({ rid: rid, task: task, state: 'dispatch_unknown' });
        st('投递未知：保留同ID ' + rid.slice(0, 12) + '… 待核，下次只查询，不自动重发');
        return;
      }
      if (!r.ok && d.status !== 'unknown' && d.status !== 'duplicate') {
        save({ rid: rid, task: task, state: d.status || 'unknown' });
        st('投递失败：' + (d.error || ('HTTP ' + r.status)) + '（同ID 保留待核）');
        return;
      }
      save({ rid: rid, task: task, state: d.status || 'queued' });
      if (d.status === 'queued' || d.status === 'duplicate') { st('已入队（同ID ' + rid.slice(0, 12) + '…），收到≠完成'); poll(rid); }
      else if (d.status === 'unknown' || d.status === 'dispatch_unknown') { save({ rid: rid, task: task, state: 'dispatch_unknown' }); st('投递未知：同ID 保留待核，只查不重发'); }
      else if (TERMINAL[d.status]) { st('已完成（' + zh(d.status) + '）'); }
      else { st('回执：' + zh(d.status)); }
    } finally {
      dock.dataset.busy = '0'; buttons().forEach(function (b) { b.disabled = false; });
    }
  }
  async function poll(rid) {
    var n = 0;
    function tick() {
      if (n++ > 20) { st('未回读终态（同ID ' + rid.slice(0, 12) + '… 待核），可点「查看最近结果」'); return; }
      getStatus(rid).then(function (s) {
        var last = load();
        if (last && last.rid === rid) save({ rid: rid, task: last.task, state: s.status });
        if (s.status === 'completed') { st('完成（同ID ' + rid.slice(0, 12) + '…）：' + ((s.result && s.result.summary) || '已写结果')); return; }
        if (s.status === 'failed' || s.status === 'needs_human') { st('终态：' + zh(s.status) + '（同ID 可查；再点才是新任务）'); return; }
        setTimeout(tick, 1500);
      }).catch(function () { setTimeout(tick, 2000); });
    }
    tick();
  }
  async function lookup() {
    var last = load(); if (!last || !last.rid) { st('还没有已提交的请求'); return; }
    try { var s = await getStatus(last.rid); st('最近请求（同ID ' + last.rid.slice(0, 12) + '…）状态：' + zh(s.status) + ((s.result && s.result.summary) ? '；' + s.result.summary : '')); }
    catch (e) { st('查询失败（如实失败，未改请求ID）'); }
  }
  function start() { host(); var pane = document.getElementById('pane-overview'); if (pane) new MutationObserver(function () { host(); }).observe(pane, { childList: true }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 500); }); else setTimeout(start, 500);
})();
