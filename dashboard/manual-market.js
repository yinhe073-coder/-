/* manual-market.js — 手动交易页只读行情卡（QUANT-MANUAL-MARKET-20261026）
 * 只读 dashboard/manual_market.json；不调用账户/交易接口，不显示下单按钮。
 * 股票按 USD 计价；USDT 对为现有手动关注列表；不伪造股票/USDT 交易对。
 */
(function () {
  'use strict';
  var URL = 'manual_market.json';
  var CARD_ID = 'manualMarketCard';
  var timer = null;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmt(iso, tz) {
    if (!iso) return '--';
    try { return new Intl.DateTimeFormat('zh-CN', { timeZone: tz || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); }
    catch (e) { return String(iso).replace('T', ' ').slice(5, 16); }
  }
  function bj(iso) { return fmt(iso, 'Asia/Shanghai'); }
  function sessionLabel(s) { return ({ pre: '盘前', regular: '正常交易', post: '盘后', closed: '休市', open_24_7: '24/7', unknown: '未知' })[s] || (s || '未知'); }
  function delayLabel(d) { return ({ delayed_or_unknown: '延迟/未知', delayed: '延迟', venue_public_live: '公开盘口·延时未核', realtime: '未授权实时声明', unknown: '未知' })[d] || (d || '未知'); }
  function badge(r, isPair) {
    if (r.error) return '缺值';
    if (r.age_s != null && r.age_s < -60) return '时钟异常';
    if (isPair) return r.stale ? '过期' : '24/7';
    if (r.market_session === 'closed') return '休市';
    return r.stale ? '过期' : '正常';
  }
  function statusCls(r, isPair) { return (r.error || r.stale || (r.age_s != null && r.age_s < -60) || (!isPair && r.market_session === 'closed')) ? 'mmBad' : 'mmOk'; }
  function priceText(v) { return v == null || !isFinite(Number(v)) ? '--' : Number(v).toFixed(Number(v) >= 1000 ? 2 : 4); }
  function changeText(v) { return v == null || !isFinite(Number(v)) ? '--' : (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
  function table(title, note, rows, isPair) {
    var h = '<div class="mmBlock"><div class="mmTitle">' + title + '</div><div class="mmNote">' + note + '</div>' +
      '<div class="mmWrap"><table class="mmTable"><thead><tr><th>标的</th><th>价格</th><th>涨跌</th><th>交易所/品种</th><th>币种</th><th>市场时段</th><th>源时间</th><th>接收时间</th><th>延时状态</th><th>状态</th></tr></thead><tbody>';
    if (!rows || !rows.length) return h + '<tr><td colspan="10" class="mmErr">未取到数据（--，不显示 0）</td></tr></tbody></table></div></div>';
    rows.forEach(function (r) {
      var tz = isPair ? 'Asia/Shanghai' : (r.exchange_timezone || 'America/New_York');
      var src = fmt(r.source_time, tz) + (isPair ? ' BJ' : ' ET') + '<div class="mmSub">BJ ' + bj(r.source_time) + '</div>';
      h += '<tr><td><b>' + String(r.symbol || '--') + '</b></td>' +
        '<td class="mono">' + priceText(r.price) + (isPair && (r.bid1 != null || r.ask1 != null || r.mark_price != null) ? '<div class="mmSub">B ' + priceText(r.bid1) + ' / A ' + priceText(r.ask1) + ' / M ' + priceText(r.mark_price) + '</div>' : '') + '</td>' +
        '<td class="mono ' + (r.change_pct > 0 ? 'mmUp' : (r.change_pct < 0 ? 'mmDown' : '')) + '">' + changeText(r.change_pct) + '</td>' +
        '<td>' + String(r.exchange || '--') + '<div class="mmSub">' + String(isPair ? (r.instrument_type || '--') : (r.watchlist_status || '')) + '</div></td>' +
        '<td>' + String(r.currency || '--') + '</td>' +
        '<td>' + sessionLabel(r.market_session) + '</td>' +
        '<td class="mono">' + src + '</td>' +
        '<td class="mono">' + bj(r.received_time) + '</td>' +
        '<td>' + delayLabel(r.delay_status) + '</td>' +
        '<td class="' + statusCls(r, isPair) + '">' + badge(r, isPair) + '</td></tr>';
    });
    return h + '</tbody></table></div></div>';
  }
  function render(d) {
    var host = document.getElementById(CARD_ID); if (!host) return;
    var stocks = d && d.stocks || [];
    var pairs = d && d.usdt_pairs || [];
    var lic = d && d.license_status || {};
    var h = '<div class="card" id="manualMarketInner"><h2>📈 行情快照（只读 · 非实时） <span class="chip gray" id="mmState">SNAPSHOT · 非交易</span>' +
      '<span class="h-right"><button class="mbtn" id="mmRefresh" type="button">刷新</button></span></h2>' +
      '<div class="mmNote"><b>数据模式 SNAPSHOT</b>：不是连续实时行情；generated_at/source_time/age/stale 必须同看。股票按 <b>USD</b> 计价；USDT 对是现有手动关注列表。不伪造“股票/USDT”交易对；代币化股票待明确，不接入。' +
      ' 股票许可：' + (lic.stocks === 'UNLICENSED_PERSONAL_USE_ONLY' ? '不获授权·仅个人本机只读（国子监2559）' : String(lic.stocks || '未知')) +
      '；USDT 对：' + (lic.pairs === 'PUBLIC_SOURCE_PENDING_REVIEW' ? '公开源待核' : String(lic.pairs || '未知')) +
      ' ｜ 生成 ' + bj(d && d.generated_at) + ' BJ</div>' +
      table('美股 · USD 计价', '来源：' + String(d && d.stocks_source || '--') + '。只有 last，无 bid/ask/mark；休市/过期如实显示，不把缓存价当实时。', stocks, false) +
      table('USDT 交易对 · 现有手动关注列表', '来源：' + String(d && d.pairs_source || '--') + '。Bid/Ask/Mark/Last 来自公开 ticker；仅行情展示，不保证可成交，不改变下单/执行权限。', pairs, true) +
      '<div class="mmNote">刷新 ' + bj(d && d.generated_at) + ' BJ；每 60 秒自动重读文件，不等于交易所连续推送。' + String(d && d.no_fabrication || '') + '</div></div>';
    host.innerHTML = h;
    var b = document.getElementById('mmRefresh');
    if (b) b.addEventListener('click', function () { load(true); });
  }
  function fail(msg) {
    var host = document.getElementById(CARD_ID); if (!host) return;
    host.innerHTML = '<div class="card"><h2>📈 行情参考（只读）</h2><div class="mmErr">行情未取到：' + String(msg || '断网/缺文件') + '。不显示 0，不冒充当前。</div></div>';
  }
  function load(manual) {
    fetch(URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(render).catch(function (e) { fail(e && e.message); });
  }
  function mount() {
    var pane = document.getElementById('pane-manual'); if (!pane) return false;
    if (!document.getElementById(CARD_ID)) {
      var box = el('div'); box.id = CARD_ID;
      var bar = pane.querySelector('.mktbar');
      if (bar) bar.insertAdjacentElement('afterend', box); else pane.insertBefore(box, pane.firstChild);
      var st = document.createElement('style');
      st.textContent = '.mmBlock{margin:10px 0 4px}.mmTitle{font-size:14px;font-weight:650;margin:0 0 4px}.mmNote{color:#8b9bb4;font-size:11.5px;line-height:1.6;margin:4px 0}.mmWrap{overflow:auto}.mmTable{border-collapse:collapse;width:100%;font-size:12px}.mmTable th,.mmTable td{border-bottom:1px solid #223047;padding:5px 7px;text-align:left;vertical-align:top;white-space:nowrap}.mmTable th{color:#8fa3c0;font-weight:500}.mmSub{color:#8b9bb4;font-size:10px;margin-top:2px}.mmUp{color:#8ee6a3}.mmDown{color:#ff9b9b}.mmOk{color:#8ee6a3}.mmBad{color:#ffcf7a}.mmErr{color:#ffb4a8;font-size:12px;padding:8px 0}';
      document.head.appendChild(st);
      load(); if (timer) clearInterval(timer); timer = setInterval(function () { load(); }, 60000);
    }
    return true;
  }
  function init() { if (!mount()) setTimeout(init, 400); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
