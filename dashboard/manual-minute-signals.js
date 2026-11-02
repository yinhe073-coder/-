/* Minute decision cards. Public market GETs only; never invokes trading/account APIs. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.ManualMinuteSignals = api;
    function start() { api.mount(root, root.document); }
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var CADENCE_MS = 20000;
  var TIMEOUT_MS = 12000;
  var LABELS = { watching: '等待确认', confirmed: '形态已确认', expired: '已到期', invalidated: '已失效', blocked: '暂停判断' };

  function blankSide(side, reason) {
    return { side: side, intent: side === 'buy' ? '买入观察' : '减仓参考', status: 'blocked', referencePrice: null,
      invalidationPrice: null, confirmedAt: null, expiresAt: null, reasons: [], blockedReasons: [reason], costsKnown: false };
  }
  function unavailable(symbol, reason, phase) {
    return { symbol: symbol, status: 'blocked', phase: phase, message: reason, data: {},
      buy: blankSide('buy', reason), sell: blankSide('sell', reason) };
  }
  function supportedSymbol(symbol) { return /^[A-Z0-9]{2,20}USDT$/.test(symbol); }

  /* A dependency-injected scheduler is exported for deterministic race/timeout tests. */
  function createController(options) {
    var fetchFn = options.fetch;
    var engine = options.engine;
    var clock = options.now || Date.now;
    var setTimer = options.setTimeout || setTimeout;
    var clearTimer = options.clearTimeout || clearTimeout;
    var Abort = options.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null);
    var onView = options.onView || function () {};
    var apiBase = String(options.apiBase || 'http://127.0.0.1:8091').replace(/\/$/, '');
    var cadence = options.cadenceMs || CADENCE_MS;
    var timeout = options.timeoutMs || TIMEOUT_MS;
    var active = false, symbol = '', generation = 0, inflight = null, payload = null;
    var nextFetchAt = 0, disposed = false, lastError = null;
    var view = unavailable('', '进入图表后读取行情', 'paused');

    function emit(next) {
      view = Object.assign({}, next, { loading: !!inflight });
      onView(view);
      return view;
    }
    function cancel() {
      generation += 1;
      if (inflight) {
        if (inflight.abort) inflight.abort.abort();
        if (inflight.cancel) inflight.cancel();
        inflight = null;
      }
    }
    function evaluate() {
      if (!active) return emit(unavailable(symbol, '切回图表后刷新', 'paused'));
      if (!supportedSymbol(symbol)) return emit(unavailable(symbol, '此卡仅支持 Bybit USDT 合约', 'unsupported'));
      if (!engine || typeof engine.analyze !== 'function') return emit(unavailable(symbol, '判断模块未加载，请刷新页面', 'error'));
      if (lastError) return emit(unavailable(symbol, lastError, 'error'));
      if (!payload) return emit(unavailable(symbol, '正在读取已收盘行情', 'loading'));
      try {
        return emit(Object.assign({}, engine.analyze({ symbol: symbol, oneMinute: payload.oneMinute,
          fiveMinute: payload.fiveMinute, nowMs: clock() }), { phase: 'ready', receivedAt: payload.receivedAt }));
      } catch (error) {
        lastError = '行情判断失败，等待重试';
        return emit(unavailable(symbol, lastError, 'error'));
      }
    }
    async function request() {
      if (disposed || !active || inflight || !supportedSymbol(symbol) || !engine || typeof engine.analyze !== 'function') return;
      var run = generation, requestSymbol = symbol;
      var abort = Abort ? new Abort() : null;
      var timer = null, cancelWait = null;
      var stopped = new Promise(function (_, reject) { cancelWait = function () { reject(new Error('cancelled')); }; });
      var job = { abort: abort, cancel: cancelWait };
      inflight = job;
      nextFetchAt = clock() + cadence;
      lastError = null;
      evaluate();
      function load(tf) {
        var url = apiBase + '/klines?symbol=' + encodeURIComponent(requestSymbol) + '&tf=' + tf;
        return Promise.resolve(fetchFn(url, { method: 'GET', cache: 'no-store', credentials: 'omit', signal: abort && abort.signal }))
          .then(function (response) {
            if (!response || !response.ok) throw new Error('行情服务暂不可用' + (response ? '（HTTP ' + response.status + '）' : ''));
            return response.json();
          }).then(function (data) {
            if (!data || data.ok !== true) throw new Error('该品种行情暂不可用');
            return data;
          });
      }
      try {
        var deadline = new Promise(function (_, reject) {
          timer = setTimer(function () {
            if (abort) abort.abort();
            reject(new Error('行情请求超时，等待重试'));
          }, timeout);
        });
        var both = await Promise.race([Promise.all([load('1'), load('5')]), deadline, stopped]);
        if (disposed || !active || run !== generation || symbol !== requestSymbol) return;
        payload = { oneMinute: both[0], fiveMinute: both[1], receivedAt: clock() };
      } catch (error) {
        if (disposed || !active || run !== generation || symbol !== requestSymbol) return;
        if (abort) abort.abort();
        payload = null;
        lastError = /^(行情服务暂不可用|该品种行情暂不可用|行情请求超时)/.test(String(error.message))
          ? error.message : '行情连接失败，等待重试';
      } finally {
        if (timer !== null) clearTimer(timer);
        if (inflight === job) inflight = null;
        if (!disposed && run === generation) evaluate();
      }
    }
    function setContext(context) {
      if (disposed) return;
      var nextSymbol = String(context.symbol || '').trim().toUpperCase();
      var nextActive = context.active === true;
      var changed = nextSymbol !== symbol || nextActive !== active;
      if (changed) {
        cancel();
        symbol = nextSymbol; active = nextActive; payload = null; lastError = null; nextFetchAt = 0;
        evaluate();
      }
      tick();
    }
    function tick() {
      if (disposed) return;
      evaluate();
      if (active && !inflight && clock() >= nextFetchAt) return request();
    }
    function refresh() {
      if (!disposed && active && !inflight) { nextFetchAt = 0; return request(); }
    }
    function dispose() { disposed = true; active = false; payload = null; cancel(); }
    return { setContext: setContext, tick: tick, refresh: refresh, dispose: dispose,
      getView: function () { return view; }, isLoading: function () { return !!inflight; } };
  }

  function price(value) {
    if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) return '—';
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: Number(value) < 1 ? 8 : Number(value) < 100 ? 5 : 2 });
  }
  function epoch(value) {
    if (value == null || value === '') return null;
    var number = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(number) ? number : null;
  }
  function beijing(value, full) {
    var number = epoch(value);
    if (number == null) return '—';
    var date = new Date(number + 8 * 3600000);
    return date.toISOString().slice(full ? 0 : 11, 19).replace('T', ' ');
  }
  function textList(value) { return Array.isArray(value) ? value.filter(function (v) { return typeof v === 'string' && v; }) : []; }
  function presentSide(model) {
    model = model || blankSide('buy', '数据未就绪');
    var status = model.status || 'blocked';
    var past = status === 'expired' || status === 'invalidated';
    var reasons = status === 'confirmed' ? textList(model.reasons) : textList(model.blockedReasons).concat(textList(model.reasons));
    var times = model.confirmedAt && status !== 'blocked'
      ? beijing(model.confirmedAt, false) + ' / ' + beijing(model.expiresAt, false) : '尚未确认';
    return {
      status: status, stateLabel: LABELS[status] || '暂停判断',
      priceLabel: past ? '当前结构观察价（未确认）' : status === 'watching' ? '结构观察价（未确认）' : status === 'confirmed' ? '确认收盘价' : '参考价',
      price: status === 'blocked' ? '—' : price(past ? model.observationPrice : model.referencePrice),
      invalidation: status === 'blocked' || past ? '—' : price(model.invalidationPrice),
      times: past && model.confirmedAt ? '上次：' + times : times,
      reasons: reasons.slice(0, 2).join(' · ') || (status === 'watching' ? '等待价格回收与量能确认' : '等待可核行情'),
      history: past && model.confirmedAt ? (model.side === 'sell' ? '卖点' : '买点') + '上次确认价 ' + price(model.referencePrice) +
        '；确认 ' + beijing(model.confirmedAt, true) + ' 北京；失效界限 ' + price(model.invalidationPrice) + '。' : ''
    };
  }

  function mount(win, doc) {
    if (!doc || !doc.getElementById('mtab-chart') || doc.getElementById('manualMinuteCard')) return null;
    var panel = doc.getElementById('mtab-chart');
    var card = doc.createElement('section');
    card.className = 'card col12 mm-panel'; card.id = 'manualMinuteCard';
    card.setAttribute('aria-label', '分钟买卖点');
    card.innerHTML = '<div class="mm-heading"><div><h2>分钟买卖点 <span class="mm-symbol"></span></h2>' +
      '<p class="mm-subtitle">1分收盘确认 · 5分过滤 · 卖点用于减仓</p></div><button type="button" class="mm-refresh">刷新</button></div>' +
      '<div class="mm-health" role="status" aria-live="polite"></div><div class="mm-cards"></div>' +
      '<details class="mm-details"><summary>判断依据与数据</summary><div class="mm-details-body"></div></details>';
    panel.insertBefore(card, panel.firstChild);
    var cards = card.querySelector('.mm-cards');
    var refs = {};
    ['buy', 'sell'].forEach(function (side) {
      var element = doc.createElement('article');
      element.className = 'mm-side mm-' + side;
      element.innerHTML = '<div class="mm-side-head"><h3>' + (side === 'buy' ? '买点 · 反弹观察' : '卖点 · 回落观察') +
        '</h3><span class="mm-state"></span></div><div class="mm-price-label"></div><div class="mm-price"></div>' +
        '<div class="mm-reasons"></div><dl class="mm-facts"><div><dt>失效价</dt><dd class="mm-invalidation"></dd></div>' +
        '<div><dt>确认 / 到期（北京）</dt><dd class="mm-times"></dd></div></dl>';
      cards.appendChild(element);
      refs[side] = element;
    });
    var symbolNode = card.querySelector('.mm-symbol'), healthNode = card.querySelector('.mm-health');
    var details = card.querySelector('.mm-details-body'), refreshButton = card.querySelector('.mm-refresh');
    var latestView = null;
    function paint(view) {
      latestView = view;
      if (win.ManualMinuteChart) win.ManualMinuteChart.setView(view);
      symbolNode.textContent = view.symbol || '—';
      refreshButton.disabled = !!view.loading || view.phase === 'unsupported' || view.phase === 'paused';
      refreshButton.textContent = view.loading ? '读取中' : '刷新';
      var data = view.data || {};
      var fresh = view.status === 'ready';
      card.dataset.state = fresh ? 'ready' : 'blocked';
      var blocked = textList((view.diagnostics || {}).blockedReasons);
      var health = view.message || (fresh ? '已收线 ' + beijing(data.latestClosedBarAt, false) + ' 北京 · 成本待核' : blocked[0] || '数据未就绪，暂停判断');
      if (healthNode.textContent !== health) healthNode.textContent = health;
      ['buy', 'sell'].forEach(function (side) {
        var model = view[side] || blankSide(side, '数据未就绪');
        var element = refs[side], presentation = presentSide(model);
        element.dataset.state = presentation.status;
        element.querySelector('.mm-state').textContent = presentation.stateLabel;
        element.querySelector('.mm-price-label').textContent = presentation.priceLabel;
        element.querySelector('.mm-price').textContent = presentation.price;
        element.querySelector('.mm-reasons').textContent = presentation.reasons;
        element.querySelector('.mm-invalidation').textContent = presentation.invalidation;
        element.querySelector('.mm-times').textContent = presentation.times;
      });
      var source = typeof data.source === 'string' ? data.source : 'Bybit linear';
      var diagnostics = view.diagnostics || {}, metrics = diagnostics.latestMetrics || {}, trend = diagnostics.trend || {};
      var volumeRatio = Number.isFinite(metrics.volumeRatio) ? metrics.volumeRatio.toFixed(2) : '—';
      var lines = ['1分图的买卖标签与本卡同源；历史到期/失效点不等同当前有效信号。',
        '前20根高低位 + ATR14 + K线回收 + 量比≥1.2；5分钟趋势过滤。有效期3分钟，触碰失效价后失效。',
        '买点用于买入观察；卖点用于已有多仓减仓观察，不是开空指令。',
        '来源：' + source + ' · Bybit USDT合约 · 1分 / 5分。',
        '当前 ATR14：' + price(metrics.atr) + '；量比：' + volumeRatio + '；5分背景：' + (trend.label || '待核') + '。',
        '最新收线：' + beijing(data.latestClosedBarAt, true) + ' 北京；收到：' + beijing(view.receivedAt, true) + ' 北京。',
        '采集时间：1分 ' + beijing(data.fetchedAt, false) + ' / 5分 ' + beijing(data.trendFetchedAt, false) + ' 北京。',
        '收线时间按本机与采集端时钟估算；' + (data.clockBasis || '接口未提供交易所时钟') + '。',
        '样本：1分 ' + (data.closedBars || 0) + ' 根 / 5分 ' + (data.trendBars || 0) + ' 根；未收盘棒不参与。',
        '手续费、点差与滑点待核；收益未验证。报价为判断参考，不代表可成交价格。'];
      ['buy', 'sell'].forEach(function (side) { var history = presentSide(view[side]).history; if (history) lines.push(history); });
      details.replaceChildren();
      lines.forEach(function (line) { var p = doc.createElement('p'); p.textContent = line; details.appendChild(p); });
    }
    var controller = createController({ fetch: win.fetch.bind(win), engine: win.ManualMinuteEngine,
      AbortController: win.AbortController, onView: paint });
    function readContext() {
      /* S is cockpit.js's global lexical state, not the editable input value. */
      var state = typeof S !== 'undefined' ? S : null;
      var manual = doc.getElementById('pane-manual');
      return { symbol: state ? state.sym : '', active: !!state && state.tab === 'manual' &&
        !!manual && !manual.classList.contains('hidden') && !panel.classList.contains('hidden') && !doc.hidden };
    }
    function sync() { controller.setContext(readContext()); }
    refreshButton.addEventListener('click', function () { sync(); controller.refresh(); });
    var timer = win.setInterval(sync, 1000);
    var defer = function () { win.setTimeout(sync, 0); };
    doc.addEventListener('click', defer);
    doc.addEventListener('visibilitychange', sync);
    win.addEventListener('hashchange', defer);
    win.addEventListener('pageshow', sync);
    function cleanup() {
      win.clearInterval(timer); controller.dispose(); doc.removeEventListener('click', defer);
      doc.removeEventListener('visibilitychange', sync); win.removeEventListener('hashchange', defer); win.removeEventListener('pageshow', sync);
    }
    win.addEventListener('pagehide', function (event) {
      if (event.persisted) controller.setContext({ active: false, symbol: readContext().symbol });
      else cleanup();
    });
    sync();
    return { controller: controller, element: card, dispose: cleanup, getView: function () { return latestView; } };
  }
  return { createController: createController, mount: mount, supportedSymbol: supportedSymbol,
    formatPrice: price, formatBeijing: beijing, presentSide: presentSide, cadenceMs: CADENCE_MS, timeoutMs: TIMEOUT_MS };
});
