/* hengpan-scan.js — 衡盘扫描条：轮询 hengpan-scan.json → 总览卡片；研究口径不碰实盘 */
(function () {
  'use strict';
  var POLL_MS = 10000;
  var STALE_SEC = 3600; /* 扫描结果超过 1h 标陈旧（机会盘非秒级） */
  var lastHtml = '';
  var lastOkAt = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function parseTs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    var n = Date.parse(String(v));
    return isNaN(n) ? null : n;
  }
  function ageTxt(ms) {
    if (ms == null) return '时间未取到';
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < -60) return '时钟偏差';
    if (s < 60) return s + '秒前';
    if (s < 3600) return Math.round(s / 60) + '分钟前';
    return (s / 3600).toFixed(1) + '小时前';
  }
  function bjFull(ms) {
    if (ms == null) return '--';
    try {
      return new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' 北京';
    } catch (e) { return '--'; }
  }
  function sevClass(sev, status) {
    var s = String(sev || status || '').toLowerCase();
    if (s === 'critical' || s === 'urgent') return 'bad';
    if (s === 'high' || s === 'drift' || s === 'warn' || s === 'review') return 'warn';
    if (s === 'ok' || s === 'info') return 'ok';
    return '';
  }
  function collectSections(d) {
    var out = [];
    if (!d) return out;
    if (d.kind === 'bundle' && d.scans) {
      ['opportunities', 'risk', 'shadow_status'].forEach(function (k) {
        var sec = d.scans[k];
        if (sec && Array.isArray(sec.items) && sec.items.length) {
          out.push({ kind: k, updated_at: sec.updated_at || d.updated_at, items: sec.items, note: sec.as_of_note || sec.note || '' });
        }
      });
      return out;
    }
    if (Array.isArray(d.items) && d.items.length) {
      out.push({ kind: d.kind || 'opportunities', updated_at: d.updated_at, items: d.items, note: d.note || '' });
    }
    return out;
  }
  var KIND_LABEL = { opportunities: '交易机会', risk: '持仓风控', shadow_status: '影子盘状态' };

  function renderItem(it) {
    var sev = sevClass(it.severity, it.status);
    var dir = it.direction || it.side || '';
    var mkt = it.market ? (' · ' + it.market) : '';
    return '<div class="hp-row">' +
      '<div class="hp-sym"><b>' + esc(it.symbol || '?') + '</b>' +
        '<span class="hp-dir ' + sev + '">' + esc(dir) + '</span>' +
        '<span class="hp-mkt">' + esc(mkt) + '</span></div>' +
      '<div class="hp-reason">' + esc(it.reason || '') + '</div>' +
      '<div class="hp-risk">风险：' + esc(it.risk || '—') + '</div>' +
      '</div>';
  }

  function render(d) {
    var host = $('hpScanBody');
    var ageEl = $('hpScanAge');
    var badge = $('hpScanBadge');
    if (!host) return;
    if (!d) {
      host.innerHTML = '<span class="loading">hengpan-scan.json 未取到</span>';
      if (ageEl) { ageEl.className = 'chip warn'; ageEl.textContent = '扫描：未取到'; }
      if (badge) { badge.textContent = '扫描未更新'; badge.className = 'hp-badge warn'; }
      return;
    }
    var ts = parseTs(d.updated_at);
    var ageSec = ts == null ? null : Math.round((Date.now() - ts) / 1000);
    var stale = ageSec == null || ageSec > STALE_SEC || ageSec < -120;
    if (ageEl) {
      ageEl.className = 'chip ' + (stale ? 'warn' : 'on');
      ageEl.textContent = '扫描 ' + (d.updated_at_bj || bjFull(ts)) + ' · ' + ageTxt(ts) + (stale ? ' ⚠' : '');
    }
    if (badge) {
      badge.className = 'hp-badge ' + (stale ? 'warn' : 'ok');
      badge.textContent = stale ? '扫描偏旧' : '扫描已更新';
    }
    var secs = collectSections(d);
    if (!secs.length) {
      host.innerHTML = '<span class="loading">暂无扫描条目</span>';
      return;
    }
    var html = '';
    if (d.note) html += '<div class="hp-note">' + esc(d.note) + '</div>';
    secs.forEach(function (sec) {
      var lab = KIND_LABEL[sec.kind] || sec.kind;
      var sts = parseTs(sec.updated_at);
      html += '<div class="hp-sec"><div class="hp-sec-h"><b>' + esc(lab) + '</b>' +
        '<span class="hp-sec-age">' + esc(ageTxt(sts)) + ' · ' + sec.items.length + ' 条</span></div>';
      if (sec.note) html += '<div class="hp-note">' + esc(sec.note) + '</div>';
      html += sec.items.map(renderItem).join('') + '</div>';
    });
    if (html !== lastHtml) { host.innerHTML = html; lastHtml = html; }
    lastOkAt = Date.now();
  }

  async function load() {
    try {
      var r = await fetch('hengpan-scan.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      render(d);
      /* optional: expose age for readiness-strip consumers */
      try { window.__hengpanScan = { ok: true, updated_at: d.updated_at, at: Date.now() }; } catch (e) {}
    } catch (e) {
      render(null);
      var host = $('hpScanBody');
      if (host) host.innerHTML = '<span class="bad">hengpan-scan.json 读取失败：' + esc(e.message) + '</span>';
      try { window.__hengpanScan = { ok: false, err: String(e.message || e), at: Date.now() }; } catch (e2) {}
    }
  }

  function ensureMount() {
    if ($('hpScanCard')) return;
    var pane = $('pane-overview');
    if (!pane) return;
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'hpScanCard';
    card.innerHTML =
      '<h2><span class="ic">📡</span>衡盘扫描' +
      '<span class="h-right"><span class="hp-badge" id="hpScanBadge">—</span> ' +
      '<span class="chip gray" id="hpScanAge">--</span></span></h2>' +
      '<div id="hpScanBody"><span class="loading">加载中…</span></div>' +
      '<details class="fold tight"><summary>更新约定</summary>' +
      '<div class="foldin disc">研究口径，不代下单。写入：<code>dashboard/push-hengpan-scan.ps1</code> 原子覆盖 ' +
      '<code>hengpan-scan.json</code>。页面每 10 秒轮询。kind=opportunities|risk|shadow_status|bundle；' +
      '时区写 Australia/Sydney 或 Asia/Shanghai（ISO 带偏移）。影子 books 仍吃 shadow.json。</div></details>';
    /* insert after KPIs / before 实盘卡，或 append near end of overview */
    var runners = $('ovRunners');
    if (runners && runners.closest) {
      var runCard = runners.closest('.card');
      if (runCard && runCard.parentNode) {
        runCard.parentNode.insertBefore(card, runCard.nextSibling);
        return;
      }
    }
    pane.appendChild(card);
  }

  /* minimal styles */
  var css = document.createElement('style');
  css.textContent =
    '#hpScanCard .hp-row{border-top:1px solid var(--line,#223047);padding:8px 0;font-size:12.5px;line-height:1.45}' +
    '#hpScanCard .hp-row:first-child{border-top:0}' +
    '#hpScanCard .hp-sym{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;margin-bottom:2px}' +
    '#hpScanCard .hp-dir{font-size:11px;color:var(--dim,#8fa3c0)}' +
    '#hpScanCard .hp-dir.bad{color:var(--red,#ff453a);font-weight:700}' +
    '#hpScanCard .hp-dir.warn{color:var(--amber,#ffd60a)}' +
    '#hpScanCard .hp-dir.ok{color:var(--green,#30d158)}' +
    '#hpScanCard .hp-mkt{font-size:10.5px;color:var(--faint,#636368)}' +
    '#hpScanCard .hp-reason{color:var(--text,#dbe4f3)}' +
    '#hpScanCard .hp-risk{font-size:11px;color:var(--dim,#8fa3c0);margin-top:2px}' +
    '#hpScanCard .hp-sec{margin:10px 0 4px}' +
    '#hpScanCard .hp-sec-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-size:13px}' +
    '#hpScanCard .hp-sec-age{font-size:11px;color:var(--faint,#636368)}' +
    '#hpScanCard .hp-note{font-size:11px;color:var(--dim,#8fa3c0);margin:4px 0 8px;line-height:1.5}' +
    '.hp-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:rgba(255,255,255,.06);color:var(--dim,#8fa3c0)}' +
    '.hp-badge.ok{background:rgba(48,209,88,.14);color:var(--green,#30d158)}' +
    '.hp-badge.warn{background:rgba(255,214,10,.12);color:var(--yellow,#ffd60a)}';
  document.head.appendChild(css);

  function boot() {
    ensureMount();
    load();
    setInterval(function () {
      if (document.hidden) return;
      ensureMount();
      load();
    }, POLL_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();