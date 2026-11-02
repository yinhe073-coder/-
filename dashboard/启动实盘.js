/* ————————————————————————————————————————————————————————————————
 * H · 驾驶舱「启动实盘」按钮（QUANT-L0-USER-START-BUTTON-04）
 *   · 直连本机控制回读服务 18121；GET /api/status 只读真状态，
 *     POST /api/intent 只发禁用控制意图，真实资金禁用、不启停。
 *   · 时间链：源采集(source_sampled_at) / 适配器接收(received_at) /
 *     服务发出(served_at) / 页面读取(page_read_at)，不用 mtime/刷新冒充源时间。
 *   · 点击前显示预检未过项（blocks），不把“在线”当“可启动”。
 *   · 未来时间/缺失时间/接口业务错误/断线分别提示。
 * ———————————————————————————————————————————————————————————————— */
(function () {
  'use strict';

  var meta = document.querySelector('meta[name="live-start-launcher"]');
  var CONTROL = (meta && meta.content) || 'http://127.0.0.1:18121';
  var POLL_MS = 20000;
  var STALE_MS = 180000;
  var SKEW_MS = 60000;
  var state = { busy: false, timer: null, last: null, notice: null, pageReadAt: null };

  function $(id) { return document.getElementById(id); }
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function setMsg(text, cls, title) {
    var m = $('liveStartMsg');
    if (!m) return;
    m.textContent = text;
    m.className = 'livestart-msg ' + (cls || '');
    if (title) m.title = title;
  }
  function statusMsg(text, cls, title) {
    if (state.notice) { setMsg(state.notice.text, state.notice.cls, state.notice.title); return; }
    setMsg(text, cls, title);
  }
  function notice(text, cls, title) {
    state.notice = { text: text, cls: cls || '', title: title || '' };
    setMsg(text, cls, title);
  }
  function bj(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return '时间不可读';
    try { return new Date(t).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) + ' 北京'; }
    catch (e) { return new Date(t).toISOString(); }
  }
  /** 返回：text / stale / missing / future / ms */
  function ageText(iso) {
    if (!iso) return { text: '时间缺失', stale: true, missing: true, ms: null };
    var t = Date.parse(iso);
    if (isNaN(t)) return { text: '时间不可读', stale: true, missing: true, ms: null };
    var ms = Date.now() - t;
    if (ms < -SKEW_MS) return { text: '无效（时钟异常：未来 ' + Math.round(-ms / 1000) + ' 秒）', stale: true, future: true, ms: ms };
    if (ms < 0) ms = 0;
    var s = Math.round(ms / 1000);
    var txt = s < 60 ? (s + ' 秒前') : s < 3600 ? (Math.round(s / 60) + ' 分钟前') : (Math.round(s / 3600) + ' 小时前');
    return { text: txt, stale: ms > STALE_MS, ms: ms };
  }
  function setTimeChain(st, d) {
    var el = $('liveTimeChain'); if (!el) return;
    var r = st.remote || {};
    var source = r.source_sampled_at || null;
    var observed = r.observed_at || null;
    var received = st.received_at || (d && d.received_at) || null;
    var served = (d && d.served_at) || null;
    state.pageReadAt = state.pageReadAt || new Date().toISOString();
    var a = ageText(source);
    var parts = [];
    parts.push('源采集 ' + bj(source) + ' · ' + a.text + (a.missing || a.future ? ' ⚠' : (a.stale ? ' ⚠过期' : '')));
    parts.push('适配器接收 ' + bj(received));
    parts.push('服务发出 ' + bj(served));
    parts.push('页面读取 ' + bj(state.pageReadAt));
    if (!source && observed) parts.push('本地观测 ' + bj(observed) + '（非源时间）');
    el.textContent = parts.join(' ｜ ');
    el.className = 'livestart-timechain ' + (a.stale ? 'bad' : '');
  }
  function setPreflight(blocks) {
    var el = $('livePreflight'); if (!el) return;
    if (!blocks || !blocks.length) {
      el.textContent = '预检：未提供未过项清单（待核）';
      el.className = 'livestart-preflight';
      return;
    }
    el.textContent = '预检未过项：' + blocks.map(function (b) { return b.code; }).join(' · ');
    el.title = blocks.map(function (b) { return b.code + '：' + b.message; }).join('\n');
    el.className = 'livestart-preflight bad';
  }

  function mount() {
    if ($('liveStartBtn')) return true;
    var pane = $('pane-live'); if (!pane) return false;
    var age = $('liveDetailAge');
    var slot = (age && age.parentElement) || pane.querySelector('.card .h-right');
    if (!slot) return false;

    var chip = mk('span', 'chip gray', '控制回读读取中…');
    chip.id = 'liveStartState';
    chip.title = '只反映本机控制回读服务(18121)与远端实例状态；真实资金默认关闭';
    var btn = mk('button', 'mbtn primary', '启动实盘（禁用·仅回执）');
    btn.id = 'liveStartBtn'; btn.type = 'button'; btn.disabled = true;
    btn.title = '真实资金开关关闭；点击只向 18121 发控制意图并显示真实拒绝回执，不会启动/停止机器人';
    var msg = mk('span', 'livestart-msg', '真实资金：禁用 · 不执行启停');
    msg.id = 'liveStartMsg';

    btn.addEventListener('click', onRequest);
    slot.appendChild(chip); slot.appendChild(btn);
    var bar = mk('div', 'livestart-bar');
    var time = mk('div', 'livestart-timechain', '时间链：读取中…'); time.id = 'liveTimeChain';
    var pre = mk('div', 'livestart-preflight', '预检：读取中…'); pre.id = 'livePreflight';
    bar.appendChild(time); bar.appendChild(pre); bar.appendChild(msg);
    var full = mk('a', '', '控制回读台全文');
    full.href = CONTROL + '/'; full.target = '_blank'; full.rel = 'noopener';
    full.style.marginLeft = '10px'; full.style.fontSize = '12px'; full.style.color = '#8ecbff';
    bar.appendChild(full);
    var card = pane.querySelector('.card'); if (card) card.appendChild(bar);
    return true;
  }

  function renderStatus(d) {
    var chip = $('liveStartState'), btn = $('liveStartBtn');
    if (!chip || !btn) return;
    state.last = d;
    var st = d && d.json;
    // 网络失败：poll() 显式传 network:true；业务错误不冒充断线。
    if (!d || d.network === true) {
      chip.textContent = '控制回读离线 · 18121 不可达';
      chip.className = 'chip gray';
      chip.title = '18121 未响应；控制回读入口离线，不代表 VPS 机器人停了。';
      btn.disabled = true;
      setTimeChain({}, d); setPreflight([]);
      statusMsg('控制回读离线（18121 不可达）：实盘状态未核实，不是“机器人已停”的结论；请先恢复 18121 再重试。', 'bad', d && d.error ? JSON.stringify(d.error) : '');
      return;
    }
    if (!d || d.ok !== true || !st || !st.remote) {
      var code = (st && st.error) || (d && d.error) || 'STATUS_UNREADABLE';
      chip.textContent = '状态不可读 · ' + code;
      chip.className = 'chip gray';
      chip.title = '接口/适配器业务错误，不是断线；实盘状态未核实，按钮禁用。';
      btn.disabled = true;
      setTimeChain(st || {}, d); setPreflight((st && st.blocks) || []);
      statusMsg('状态不可读（' + code + '）：这是业务/适配器错误，不是“18121 不可达”；未取得可核状态，按钮禁用，不执行启停。', 'bad', JSON.stringify(st || d));
      return;
    }
    var r = st.remote || {};
    var source = r.source_sampled_at || null;
    var a = ageText(source);
    setTimeChain(st, d);
    setPreflight(st.blocks || []);
    var bits = [];
    bits.push('实盘 running=' + String(r.running));
    bits.push('身份匹配=' + String(r.matches_pinned_identity));
    bits.push('实例=' + String(r.instances));
    if (a.missing) bits.push('源采集时间缺失/不可读');
    else if (a.future) bits.push('时钟异常：源时间在未来');
    else if (a.stale) bits.push('源状态已过期（' + a.text + '）');
    chip.textContent = '控制回读在线 · ' + bits.join(' · ');
    var bad = a.stale || a.missing || a.future || r.running !== true || r.matches_pinned_identity !== true;
    chip.className = 'chip ' + (bad ? 'gray' : 'green');
    chip.title = '只读状态来自 18121；源采集时间 ' + (source || '缺失') + '；真实资金 enabled=' + st.enabled + ' / real_money_enabled=' + st.real_money_enabled;

    btn.disabled = false;
    if (a.missing) statusMsg('源采集时间缺失/不可读：不能证明数据新鲜；仅显示本地接收/页面读取时间，点击仍只发禁用回执。', 'bad');
    else if (a.future) statusMsg('时钟异常（源时间在未来 ' + Math.round(-a.ms / 1000) + ' 秒）：不得当作新鲜；点击仍只发禁用回执。', 'bad');
    else if (a.stale) statusMsg('真实资金禁用 ｜ 源采集已过期（' + a.text + '）；点击仅看禁用回执，不据此放行。', 'bad');
    else statusMsg('真实资金禁用 · 本地控制未启用 ｜ 源采集 ' + a.text + '（新鲜）｜ 点击发禁用控制意图，只显示拒绝回执，不启动/停止。', '');
  }

  function poll() {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 8000);
    fetch(CONTROL + '/api/status', { method: 'GET', cache: 'no-store', signal: ctl.signal })
      .then(function (r) { return r.json(); })
      .then(function (j) { clearTimeout(to); renderStatus(j); })
      .catch(function (e) { clearTimeout(to); renderStatus({ ok: false, network: true, error: String(e && e.message || e) }); });
  }

  function newIntentId() {
    var id = localStorage.getItem('ui_intent_id');
    if (!id || !/^it_ui_[A-Za-z0-9-]{6,64}$/.test(id)) {
      id = 'it_ui_' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('ui_intent_id', id);
    }
    return id;
  }

  function onRequest() {
    if (state.busy) return;
    if (!state.last || state.last.ok !== true || !state.last.json || !state.last.json.remote) {
      setMsg('状态未就绪/不可读，未发请求；按钮保持禁用。', 'bad'); return;
    }
    state.busy = true; state.notice = null;
    var btn = $('liveStartBtn');
    if (btn) { btn.disabled = true; btn.textContent = '请求中…'; }
    setMsg('已提交禁用控制意图，等待真实回执…', '');
    var id = newIntentId();
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 10000);
    fetch(CONTROL + '/api/intent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intentId: id }), signal: ctl.signal
    }).then(function (r) { return r.json(); }).then(function (d) {
      clearTimeout(to);
      if (!d || d.ok !== true) notice('控制请求失败：' + (d && d.error || '未知错误') + '（未执行任何启停）', 'bad', JSON.stringify(d));
      else if (d.duplicate) notice('同一意图已存在（' + id + '）：未重复派发，未再次执行。原回执 state=' + (d.existing && d.existing.state || 'REFUSED'), '');
      else {
        var res = d.result || {}, j = res.json || {};
        var blocks = (j.blocks || []).map(function (b) { return b.code + '：' + b.message; }).join(' ｜ ');
        var stale = (j.blocks || []).some(function (b) { return b.code === 'SNAPSHOT_STALE_OR_MISSING'; });
        notice('已拒绝（未启动/未停止）state=' + (j.state || '?') + ' · exitCode=' + res.exitCode + ' · 原因：' + (blocks || '无') +
          (stale ? ' ｜ 本地总资产快照过期：旧数据已标过期，不据此放行' : ''), 'bad', JSON.stringify(j));
      }
    }).catch(function (e) {
      clearTimeout(to); notice('控制请求异常：连不上 18121 或超时（未执行任何启停）——' + String(e && e.message || e), 'bad');
    }).then(function () {
      state.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '启动实盘（禁用·仅回执）'; }
      poll();
    });
  }

  function init() {
    if (!mount()) { setTimeout(init, 400); return; }
    poll();
    state.timer = setInterval(poll, POLL_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
