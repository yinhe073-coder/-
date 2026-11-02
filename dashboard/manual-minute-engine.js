/* Manual decision support only. No network, storage, accounts or order execution. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ManualMinuteEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RULES_VERSION = 'minute-recovery-v1.0.0';
  const MINUTE = 60000;
  const DEFAULTS = Object.freeze({
    structureBars: 20, atrPeriod: 14, atrWindowBars: 60,
    trendWindowBars: 100, trendFast: 20, trendSlow: 50, trendSlopeBars: 3,
    strongTrendAtr: 0.5, zoneAtr: 0.2, invalidationAtr: 0.25,
    volumeRatioMin: 1.2, closePosition: 0.65,
    closeDelayMs: 2000, ttlMs: 180000, lateBarToleranceMs: 15000,
    maxFetchAgeMs: 90000, clockToleranceMs: 5000
  });
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const uniq = xs => Array.from(new Set(xs));
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const last = xs => xs.length ? xs[xs.length - 1] : null;
  const iso = ms => finite(ms) ? new Date(ms).toISOString() : null;

  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function atr(bars) {
    const n = DEFAULTS.atrPeriod;
    if (bars.length < n) return null;
    const tr = bars.map((b, i) => i ? Math.max(b.high - b.low,
      Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
    let value = mean(tr.slice(0, n));
    for (let i = n; i < tr.length; i++) value = (value * (n - 1) + tr[i]) / n;
    return value;
  }

  function ema(values, period) {
    const result = new Array(values.length).fill(null);
    if (values.length < period) return result;
    let value = mean(values.slice(0, period));
    result[period - 1] = value;
    const alpha = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
      value = alpha * values[i] + (1 - alpha) * value;
      result[i] = value;
    }
    return result;
  }

  function normalize(payload, symbol, intervalMs, nowMs) {
    const label = intervalMs === MINUTE ? '1m' : '5m';
    const out = { bars: [], observedOpenBars: [], openBarInvalid: false, ignoredOpenBars: 0, duplicates: 0,
      errors: [], warnings: [], source: null, fetchedAt: null, capturedAt: null };
    const error = message => out.errors.push(label + '：' + message);
    if (!payload || payload.ok !== true) { error('行情请求未成功'); return out; }
    out.source = payload.src;
    if (String(payload.sym || '').toUpperCase() !== symbol) error('币种不匹配');
    if (String(payload.tf) !== String(intervalMs / MINUTE)) error('周期不匹配');
    if (!['bybit-vps', 'bybit-local-proxy', 'bybit'].includes(payload.src)) error('仅支持 Bybit linear 同源行情');
    if (payload.market && !['linear', 'Bybit linear', 'bybit-linear'].includes(payload.market)) error('市场不匹配');
    if (payload.category && payload.category !== 'linear') error('市场不匹配');
    if (!finite(payload.fetched_at) || payload.fetched_at <= 0) error('缺少有效采集时间');
    else {
      out.fetchedAt = payload.fetched_at;
      if (payload.fetched_at > nowMs + DEFAULTS.clockToleranceMs) error('采集时间超前，请校准本机时钟');
    }
    if (!Array.isArray(payload.candles) || !Array.isArray(payload.vol) || payload.candles.length !== payload.vol.length) {
      error('OHLC 与成交量长度不一致'); return out;
    }
    if (out.errors.length) return out;
    // A cached snapshot's open candle must never become closed just because the UI clock advanced.
    const capturedAt = Math.min(nowMs, payload.fetched_at);
    out.capturedAt = capturedAt;
    const closeCutoff = capturedAt - DEFAULTS.closeDelayMs;
    let previousTimestamp = -Infinity;
    let previousClosed = null;
    const seen = new Map();
    for (let i = 0; i < payload.candles.length; i++) {
      const raw = payload.candles[i];
      if (!Array.isArray(raw) || raw.length < 5 || !finite(raw[0]) || raw[0] <= 0 || raw[0] % intervalMs !== 0) {
        error('K 线时间非法或未对齐'); break;
      }
      const openTime = raw[0];
      if (openTime < previousTimestamp) { error('K 线乱序'); break; }
      previousTimestamp = openTime;
      if (openTime > Math.floor(capturedAt / intervalMs) * intervalMs) { error('存在未来 K 线，请核对时钟'); break; }
      if (openTime + intervalMs > closeCutoff) {
        out.ignoredOpenBars++;
        const prices = raw.slice(1, 5);
        const [open, high, low, close] = prices;
        if (prices.every(finite) && Math.min(...prices) > 0 &&
            high >= Math.max(open, close, low) && low <= Math.min(open, close, high)) {
          out.observedOpenBars.push({ openTime, closeTime: openTime + intervalMs, open, high, low, close });
        } else out.openBarInvalid = true;
        continue;
      }
      const [unused, open, high, low, close] = raw;
      const volume = payload.vol[i];
      if (![open, high, low, close, volume].every(finite) || Math.min(open, high, low, close) <= 0 ||
          high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
        error('OHLCV 非有限值或价格结构非法'); break;
      }
      if (volume <= 0) { error('成交量为零或负数，暂不确认'); break; }
      const bar = { openTime, closeTime: openTime + intervalMs, open, high, low, close, volume };
      if (seen.has(openTime)) {
        if (JSON.stringify(seen.get(openTime)) !== JSON.stringify(bar)) { error('同时间 K 线内容冲突'); break; }
        out.duplicates++; continue;
      }
      if (previousClosed && openTime !== previousClosed.openTime + intervalMs) { error('已收盘 K 线存在缺口'); break; }
      seen.set(openTime, bar); out.bars.push(bar); previousClosed = bar;
    }
    return out;
  }

  function aggregateFive(one) {
    const bars = [];
    const buckets = new Map();
    one.bars.forEach(b => {
      const start = Math.floor(b.openTime / (5 * MINUTE)) * 5 * MINUTE;
      if (!buckets.has(start)) buckets.set(start, []);
      buckets.get(start).push(b);
    });
    for (const [start, group] of buckets) {
      if (group.length !== 5 || group[0].openTime !== start || group[4].closeTime !== start + 5 * MINUTE) continue;
      bars.push({ openTime: start, closeTime: start + 5 * MINUTE, open: group[0].open,
        high: Math.max(...group.map(b => b.high)), low: Math.min(...group.map(b => b.low)),
        close: group[4].close, volume: group.reduce((n, b) => n + b.volume, 0) });
    }
    return { bars, ignoredOpenBars: 0, duplicates: 0, errors: [], warnings: ['5m 由完整同源 1m 桶聚合'],
      source: one.source, fetchedAt: one.fetchedAt };
  }

  function trendAt(bars, closeTime) {
    let end = bars.length;
    while (end && bars[end - 1].closeTime > closeTime) end--;
    if (end < DEFAULTS.trendWindowBars) return null;
    if (bars[end - 1].closeTime !== Math.floor(closeTime / (5 * MINUTE)) * 5 * MINUTE) return null;
    const window = bars.slice(end - DEFAULTS.trendWindowBars, end);
    const closes = window.map(b => b.close);
    const fast = ema(closes, DEFAULTS.trendFast);
    const slow = last(ema(closes, DEFAULTS.trendSlow));
    const fastNow = last(fast);
    const slope = fastNow - fast[fast.length - 1 - DEFAULTS.trendSlopeBars];
    const volatility = atr(window);
    if (!finite(volatility) || volatility <= 0) return null;
    const separation = (fastNow - slow) / volatility;
    const strongDown = separation <= -DEFAULTS.strongTrendAtr && slope < 0;
    const strongUp = separation >= DEFAULTS.strongTrendAtr && slope > 0;
    return { state: strongDown ? 'strong-down' : strongUp ? 'strong-up' : 'mixed',
      label: strongDown ? '5m 强下降' : strongUp ? '5m 强上行' : '5m 无强单边',
      closedAt: last(window).closeTime, ema20: fastNow, ema50: slow, slope, atr: volatility, separationAtr: separation };
  }

  function structureAt(bars, index) {
    if (index < DEFAULTS.atrWindowBars - 1) return null;
    // Each event uses a fixed trailing seed window, so a rolling REST window cannot revise an old event.
    const window = bars.slice(index + 1 - DEFAULTS.atrWindowBars, index + 1);
    const volatility = atr(window);
    if (!finite(volatility) || volatility <= 0) return null;
    const previous = bars.slice(index - DEFAULTS.structureBars, index);
    const low = Math.min(...previous.map(b => b.low));
    const high = Math.max(...previous.map(b => b.high));
    const medianVolume = median(previous.map(b => b.volume));
    const bar = bars[index];
    const range = bar.high - bar.low;
    const position = range > 0 ? (bar.close - bar.low) / range : null;
    return { low, high, atr: volatility, volumeRatio: bar.volume / medianVolume, position };
  }

  function eventFor(side, bar, setup, trend, symbol, source) {
    const isBuy = side === 'buy';
    const id = [symbol, '1m', bar.closeTime, side, RULES_VERSION].join(':');
    return {
      eventId: id, side, intent: isBuy ? '买入观察' : '减仓参考', symbol, interval: '1m',
      rulesVersion: RULES_VERSION, source, market: 'Bybit linear',
      barOpenTime: bar.openTime, confirmedAt: bar.closeTime, availableAfter: bar.closeTime + DEFAULTS.closeDelayMs,
      expiresAt: bar.closeTime + DEFAULTS.ttlMs,
      referencePrice: bar.close, invalidationPrice: isBuy ? bar.low - DEFAULTS.invalidationAtr * setup.atr : bar.high + DEFAULTS.invalidationAtr * setup.atr,
      structurePrice: isBuy ? setup.low : setup.high,
      reasons: [isBuy ? '低位回收，收盘确认' : '高位回落，收盘确认',
        '量比 ' + setup.volumeRatio.toFixed(2) + ' · ' + trend.label],
      metrics: { atr: setup.atr, volumeRatio: setup.volumeRatio, closePosition: setup.position,
        priorLow: setup.low, priorHigh: setup.high, trend },
      costsKnown: false, costStatus: '待核', performanceStatus: '收益未验证'
    };
  }

  function analyze(input) {
    input = input || {};
    const symbol = String(input.symbol || '').trim().toUpperCase();
    const nowMs = input.nowMs !== undefined ? input.nowMs : input.now !== undefined ? input.now : Date.now();
    const errors = [];
    if (!/^[A-Z0-9]{2,24}USDT$/.test(symbol)) errors.push('当前只支持 Bybit linear USDT 币种');
    if (!finite(nowMs) || nowMs <= 0 || nowMs > 8640000000000000) errors.push('当前时间非法');
    const one = normalize(input.oneMinute, symbol, MINUTE, nowMs);
    const five = input.fiveMinute ? normalize(input.fiveMinute, symbol, 5 * MINUTE, nowMs) : aggregateFive(one);
    errors.push(...one.errors, ...five.errors);
    const bars = one.bars;
    const latest = last(bars);
    const latestFive = last(five.bars);
    const dataErrors = errors.slice();
    const blockers = errors.slice();
    if (one.openBarInvalid) blockers.push('未收盘 K 线异常，无法核验即时失效');
    if (bars.length < DEFAULTS.atrWindowBars) blockers.push('至少需要 60 根连续已收盘 1m');
    if (five.bars.length < DEFAULTS.trendWindowBars) blockers.push('至少需要 100 根连续已收盘 5m');
    if (latest && nowMs - latest.closeTime > MINUTE + DEFAULTS.lateBarToleranceMs) blockers.push('1m 行情过期');
    if (latestFive && nowMs - latestFive.closeTime > 5 * MINUTE + DEFAULTS.lateBarToleranceMs) blockers.push('5m 行情过期');
    if (one.fetchedAt && nowMs - one.fetchedAt > DEFAULTS.maxFetchAgeMs) blockers.push('1m 行情快照过期');
    if (five.fetchedAt && nowMs - five.fetchedAt > DEFAULTS.maxFetchAgeMs) blockers.push('5m 行情快照过期');
    const latestSetup = latest ? structureAt(bars, bars.length - 1) : null;
    const latestTrend = latest ? trendAt(five.bars, latest.closeTime) : null;
    if (bars.length >= DEFAULTS.atrWindowBars && !latestSetup) blockers.push('1m 波动不足，无法归一化');
    if (five.bars.length >= DEFAULTS.trendWindowBars && !latestTrend) blockers.push('确认时刻缺少足够已闭合 5m 或波动不足');
    const events = [];
    if (!dataErrors.length) {
      for (let i = DEFAULTS.atrWindowBars - 1; i < bars.length; i++) {
        const bar = bars[i];
        const setup = structureAt(bars, i);
        const trend = trendAt(five.bars, bar.closeTime);
        if (!setup || !trend || setup.position === null || setup.volumeRatio < DEFAULTS.volumeRatioMin) continue;
        const buy = bar.low <= setup.low + DEFAULTS.zoneAtr * setup.atr && bar.close > setup.low &&
          bar.close > bar.open && setup.position >= DEFAULTS.closePosition;
        const sell = bar.high >= setup.high - DEFAULTS.zoneAtr * setup.atr && bar.close < setup.high &&
          bar.close < bar.open && setup.position <= 1 - DEFAULTS.closePosition;
        if (buy && trend.state !== 'strong-down' && bar.low - DEFAULTS.invalidationAtr * setup.atr > 0)
          events.push(eventFor('buy', bar, setup, trend, symbol, 'bybit-linear'));
        // A sell card is reduction of a long position, never an instruction to open a short.
        if (sell) events.push(eventFor('sell', bar, setup, trend, symbol, 'bybit-linear'));
      }
    }
    const blockedReasons = uniq(blockers);
    const observationBars = bars.slice(-DEFAULTS.structureBars);
    const watchPrices = observationBars.length === DEFAULTS.structureBars ? {
      buy: Math.min(...observationBars.map(b => b.low)), sell: Math.max(...observationBars.map(b => b.high))
    } : { buy: null, sell: null };

    function card(side) {
      const event = last(events.filter(e => e.side === side));
      const result = {
        side, intent: side === 'buy' ? '买入观察' : '减仓参考', symbol,
        status: 'watching', referencePrice: watchPrices[side], observationPrice: watchPrices[side],
        invalidationPrice: null, confirmedAt: null, expiresAt: null, eventId: null,
        reasons: ['等待收盘形态与量能确认'], blockedReasons: [],
        costsKnown: false, costStatus: '待核', performanceStatus: '收益未验证'
      };
      if (event) {
        Object.assign(result, event, { status: 'confirmed', observationPrice: watchPrices[side] });
        const invalidatingBar = bars.find(b => b.openTime >= event.confirmedAt && b.closeTime <= event.expiresAt &&
          (side === 'buy' ? b.low <= event.invalidationPrice : b.high >= event.invalidationPrice));
        const observedOpenHit = one.observedOpenBars.find(b => b.openTime >= event.confirmedAt &&
          one.capturedAt < event.expiresAt &&
          (side === 'buy' ? b.low <= event.invalidationPrice : b.high >= event.invalidationPrice));
        if (invalidatingBar) {
          result.status = 'invalidated'; result.invalidatedAt = invalidatingBar.closeTime;
          result.invalidationBasis = 'closed-bar';
          result.blockedReasons.push('后续已收盘 K 线触及失效价');
        } else if (observedOpenHit) {
          result.status = 'invalidated'; result.invalidatedAt = one.capturedAt;
          result.invalidationBasis = 'observed-open-bar';
          result.blockedReasons.push('后续 K 线已观测触及失效价（未收盘，保守失效）');
        } else if (nowMs >= event.expiresAt) {
          result.status = 'expired'; result.blockedReasons.push('确认点已超过 3 分钟');
        }
      } else if (side === 'buy' && latestTrend && latestTrend.state === 'strong-down') {
        result.blockedReasons.push('5m 强下降，暂不确认逆势买点');
      }
      if (blockedReasons.length) {
        result.status = 'blocked'; result.blockedReasons = uniq(blockedReasons.concat(result.blockedReasons));
        // Invalid or mixed data must never expose a previous symbol's actionable prices.
        if (dataErrors.length) {
          result.referencePrice = null; result.observationPrice = null; result.invalidationPrice = null;
          result.confirmedAt = null; result.expiresAt = null; result.eventId = null;
        }
      }
      return result;
    }

    return {
      rulesVersion: RULES_VERSION, symbol, market: 'Bybit linear',
      status: blockedReasons.length ? 'blocked' : 'ready', nowMs,
      data: {
        source: one.source, trendSource: five.source, fetchedAt: one.fetchedAt, trendFetchedAt: five.fetchedAt,
        latestClosedBarAt: latest ? latest.closeTime : null, latestClosedBarUtc: latest ? iso(latest.closeTime) : null,
        dataAgeMs: latest ? nowMs - latest.closeTime : null, latestTrendClosedAt: latestFive ? latestFive.closeTime : null,
        closedBars: bars.length, trendBars: five.bars.length,
        ignoredOpenBars: one.ignoredOpenBars, ignoredOpenTrendBars: five.ignoredOpenBars,
        openBarInvalid: one.openBarInvalid,
        duplicatesRemoved: one.duplicates + five.duplicates,
        clockBasis: '本机与采集时间；接口未提供交易所时钟', closeDelayMs: DEFAULTS.closeDelayMs
      },
      buy: card('buy'), sell: card('sell'), events,
      diagnostics: { errors: uniq(dataErrors), blockedReasons, warnings: uniq(one.warnings.concat(five.warnings)),
        latestMetrics: latestSetup, trend: latestTrend, costsKnown: false,
        costStatus: '手续费、点差与滑点待核', performanceStatus: '收益未验证' },
      params: Object.assign({}, DEFAULTS)
    };
  }

  return Object.freeze({ analyze, RULES_VERSION, DEFAULTS });
});
