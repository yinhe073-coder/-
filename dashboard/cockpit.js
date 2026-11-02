/* cockpit.js — 量化驾驶舱 v3 (2026-09-20)
   三个页签: 手动交易 / 机器人·影子盘 / 策略工坊。
   数据源: 静态 JSON(由 refresh.ps1 循环产出) + 本机信号服务 127.0.0.1:8091。
   纪律: 只在当前页签拉数据, 避免三个页面同时轮询把本机压满。 */
'use strict';

const API = 'http://127.0.0.1:8091';
const SIX = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'SUIUSDT', 'TRUMPUSDT'];
/* 期货 / 外汇（主人 2026-09-21 要求接进手动操作页）。名字沿用交易员习惯的 CFD 代号，
   数据来自 Yahoo Finance —— 映射关系在 cockpit_api.py 的 YF_SYMS 里。 */
const FUT = ['XAUUSD', 'USOUSD', 'USDJPY'];
const PICK = SIX.concat(FUT);

/* 图内左上角的状态徽标（趋势 / 五浪 / 斐波基准）—— 全部先收集、最后**排成一行**画。
   以前三块各自往左上角堆，趋势徽标会直接盖住「五浪：未通过…」那行字，
   叠成一团还都是长句子（主人 2026-09-21：「字太多了不太好看」）。 */
let BADGES = [];
const TFS = [['1', '1分'], ['15', '15分'], ['30', '30分'], ['60', '1小时'], ['D', '日线'], ['W', '周线']];
const OVS = [['fib', '斐波那契'], ['wave', '五浪'], ['td', '九转'], ['ema', 'EMA'], ['boll', '布林']];

const S = {
  tab: 'manual', sym: 'BTCUSDT', tf: '15', anchor: 'D', preset: 'full', kl: null, vd: null, shadow: null, taAll: null,
  ov: { fib: true, wave: true, td: true, ema: true, boll: true },
  last: {}, radarCat: '全部',
};

/* 斐波那契基准：**固定日线**（主人 2026-09-21 钦定「只用日线算」）。
   以前是可选的（本周期/15分/1小时/4小时/日线/周线），结果同一个品种换个周期看就换一套线，
   容易自己跟自己打架。现在写死一个常量，UI 上也要写明是日线，不能让图和代码对不上。 */
const FIB_ANCHOR = 'D';

/* 看图的状态（标的/周期/斐波基准/预设/叠加层）落 localStorage。
   为什么必须做：Chrome 在软刷新时会**保留输入框里的文字**，但 JS 状态会重置回 BTCUSDT ——
   于是出现「输入框写着 HYPEUSDT、图上是 BTC」这种对不上的画面（2026-09-20 主人截图踩到）。 */
const VIEW_KEY = 'dsh.cockpit.view';
function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      sym: S.sym, tf: S.tf, anchor: S.anchor, preset: S.preset, ov: S.ov,
    }));
  } catch (e) {}
}
function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    if (v.sym) S.sym = String(v.sym).toUpperCase();
    if (v.tf && TFS.some(function (x) { return x[0] === v.tf; })) S.tf = v.tf;
    /* 老的 localStorage 里存过别的基准（本周期/周线…），一律作废 —— 现在只认日线 */
    S.anchor = FIB_ANCHOR;
    if (v.preset) S.preset = v.preset;
    if (v.ov) Object.assign(S.ov, v.ov);
  } catch (e) {}
}

/* ───────────── 基础工具 ───────────── */
const $ = id => document.getElementById(id);
const pad2 = n => String(n).padStart(2, '0');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtPrice(v) {
  const n = Number(v);
  if (!isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 10000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (a >= 100) return n.toFixed(2);
  if (a >= 1) return n.toFixed(4);
  if (a >= 0.01) return n.toFixed(5);
  return n.toFixed(8);
}
function fmtNum(v, d) { const n = Number(v); return isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: d == null ? 2 : d }) : '--'; }
function pct(v, d) { const n = Number(v); if (!isFinite(n)) return '--'; return (n >= 0 ? '+' : '') + n.toFixed(d == null ? 2 : d) + '%'; }
function cls(v) { return v > 0 ? 'gain' : (v < 0 ? 'loss' : 'flat'); }
function ageStr(sec) {
  if (sec == null || !isFinite(sec)) return '--';
  if (sec < 60) return Math.max(0, Math.round(sec)) + ' 秒前';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
  return (sec / 3600).toFixed(1) + ' 小时前';
}
/* 🔴 北京时间换算（2026-10-12 修正 · 显示层）
   本机时区固定为墨尔本（标准 UTC+10 / 夏令时 UTC+11，宪章钦定不得改）。
   实测：这两个函数原来用**本地 getter**（getHours / getFullYear / getMonth / getDate）
   ⇒ 页面标着「北京」、实际印的是**墨尔本时间**，夏令时期间差 3 小时。
   修法：epoch + 8 小时后取 getUTC* 系列 —— 与顶栏时钟 bjClockStr 同一套算法。
   主人 2026-10-12 明令：「时间用北京时间 我的电脑是墨尔本时间但是我人在国内」。 */
function bjShift(ts) {
  const 数值 = Number(ts);
  const 毫秒 = (isFinite(数值) && 数值 > 0) ? 数值 : Date.now();
  return new Date(毫秒 + 8 * 3600 * 1000);
}
function bjNow(ts) {
  const d = bjShift(ts);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}
function bjFull(ts) {
  const d = bjShift(ts);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + bjNow(ts);
}
async function getJSON(url) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/* ───────────── 页签 ───────────── */
function setTab(t, noHash) {
  S.tab = t;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['manual', 'bots', 'shop'].forEach(k => $('pane-' + k).classList.toggle('hidden', k !== t));
  $('pageTag').textContent = { manual: '手动交易 · 实时分析常驻', bots: '机器人 · 影子盘赛马', shop: '策略工坊 · 写策略 → 生成机器人' }[t] || '';
  if (!noHash) location.replace('#' + t);
  if (t === 'manual') { loadKline(true); loadVerdict(true); loadTaAll(true); loadSignals(); loadRadar(); loadPaSignals(); loadExtremes(); }
  if (t === 'bots') loadShadow(true);
  if (t === 'shop') loadShop(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ───────────── 顶栏时钟 ───────────── */
/* 本机时区是墨尔本（标准 UTC+10 / 夏令时 UTC+11 ⇒ 夏令时期间比北京快 3 小时）。标着「北京时间」就必须真的按 UTC+8 算 ——
   拿 new Date() 的本地时间冒充，就是标签和代码算的不是同一个时区（2026-09-20 主人指出；2026-10-12 主人再次明令"时间用北京时间"）。
   ⚠️ 2026-10-12 修正：上面的 bjNow / bjFull 原来正是"本地时间冒充北京"的重灾区，已改为 epoch+8h 取 getUTC*。 */
let srvOffset = 0;
function bjClockStr(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);   // 平移到 UTC+8，再用 getUTC* 取值
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}
setInterval(() => {
  $('srvClock').textContent = bjClockStr(Date.now() + srvOffset);
}, 1000);

/* ───────────── pos.json: 当前只读采集的 BTC 行情 / 余额 / 持仓 ───────────── */
let dataStamp = 0;
let cockpitTopSnapshot = null;
let cockpitTopError = '';
let cockpitTickBusy = false;
function cockpitTopStatus() {
  const ts = cockpitTopSnapshot && Number(cockpitTopSnapshot.ts);
  const age = ts > 0 ? (Date.now() - ts) / 1000 : null;
  const fresh = Number.isFinite(age) && age >= -60 && age <= 180 && !cockpitTopError;
  let label = !ts ? '采集时间未取到' : (age < -60 ? '时钟偏差' : (age > 180 ? '已过期' : '自动更新'));
  if (cockpitTopError) label = '读取异常';
  return { fresh: fresh, text: '持仓/报价快照(pos) ' + (ts ? bjFull(ts) + ' 北京 · ' + ageStr(Math.max(0, age)) + ' · ' : '') + label,
    error: cockpitTopError, source: 'pos.json' };
}
async function tick() {
  if (cockpitTickBusy) return;
  cockpitTickBusy = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('pos.json?t=' + Date.now(), { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const d = await response.json();
    if (!d || typeof d !== 'object') throw new Error('持仓数据格式无效');
    const ts = Number(d.ts);
    dataStamp = Number.isFinite(ts) && ts > 0 ? ts : 0;
    cockpitTopSnapshot = { ts: dataStamp };
    cockpitTopError = d.err ? String(d.err) : (d.accounts && d.accounts.hengpan && d.accounts.hengpan.ok === false
      ? String(d.accounts.hengpan.err || '主账户采集失败') : '');
    const status = cockpitTopStatus();
    const suffix = status.fresh ? '' : ' · ' + (status.error ? '采集异常' : '非当前');
    $('svcDot').className = 'dot ' + (status.fresh ? 'on' : 'off');
    $('refresh').textContent = status.text;
    $('refresh').title = '来源 pos.json：持仓/报价快照，不是行情源 live.json；按实际采集时间判断，超过 180 秒标为过期。' + (status.error ? ' ' + status.error : '');
    if (status.fresh && Number(d.server_time) > 0 && Math.abs(Number(d.server_time) * 1000 - dataStamp) <= 30000) {
      srvOffset = Number(d.server_time) * 1000 - dataStamp;
    }
    const b = d.tick || {};
    const numberOrNull = v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    const price = numberOrNull(b.last), change = numberOrNull(b.pct24), rate = numberOrNull(b.funding);
    $('btc').textContent = price == null ? '未取到' : '$' + fmtPrice(price) + suffix;
    $('btc').className = change == null ? 'flat' : (change >= 0 ? 'up' : 'down');
    $('pct24').textContent = change == null ? '--' : pct(change);
    $('pct24').className = change == null ? 'flat' : cls(change);
    $('hl').textContent = (numberOrNull(b.high24) == null ? '--' : fmtPrice(b.high24)) + ' / ' +
      (numberOrNull(b.low24) == null ? '--' : fmtPrice(b.low24));
    /* pos.tick.funding is Bybit fundingRate, a ratio (0.0001 means 0.01%). */
    $('funding').textContent = rate == null ? '--' : (rate * 100).toFixed(4) + '%';
    const accountError = !!d.err || !!(d.accounts && d.accounts.hengpan && d.accounts.hengpan.ok === false);
    const balance = accountError ? null : numberOrNull(d.bal);
    $('bal').textContent = balance == null ? '未取到' : balance.toFixed(4) + ' U' + suffix;
    const legs = accountError ? null : (Array.isArray(d.positions) ? d.positions : (d.pos && typeof d.pos === 'object' ? [d.pos] : null));
    $('posTxt').innerHTML = legs === null ? '<span class="flat">持仓未取到</span>' : legs.length
      ? legs.map(function (p) {
          const side = p.side || '';
          const avg = p.avg != null ? p.avg : p.entry;
          return '<span class="' + (side === 'Buy' || side === 'long' ? 'gain' : 'loss') + '">' +
            esc(p.sym || p.symbol || '') + ' ' + esc(side) + ' ' + esc(String(p.size || '')) +
            ' @' + fmtPrice(avg) + '</span>';
        }).join(' · ') + (status.fresh ? '' : '<span class="flat">' + esc(suffix) + '</span>')
      : '<span class="flat">' + (status.fresh ? '无持仓' : '历史快照无持仓 · 非当前') + '</span>';
  } catch (e) {
    cockpitTopError = e.name === 'AbortError' ? '读取超时' : e.message;
    $('svcDot').className = 'dot off';
    $('refresh').textContent = cockpitTopStatus().text;
    $('refresh').title = 'pos.json: ' + cockpitTopError;
    $('btc').textContent = '未取到';
    $('pct24').textContent = '--';
    $('hl').textContent = '--';
    $('funding').textContent = '--';
    $('bal').textContent = '未取到';
    $('posTxt').textContent = '持仓未取到';
  } finally {
    clearTimeout(timeout);
    cockpitTickBusy = false;
  }
}

/* ───────────── 短线信号板 ───────────── */
async function querySignal(sym, quiet = false) {
  const inp = $('sigInput');
  if (sym) inp.value = sym;
  const s = (inp.value || '').trim().toUpperCase();
  if (!s) return;
  if (S.signalPending === s) return;
  const requestId = (S.signalRequestId || 0) + 1;
  S.signalRequestId = requestId; S.signalPending = s; S.signalActive = s;
  const isCurrent = () => S.signalRequestId === requestId && (inp.value || '').trim().toUpperCase() === s;
  const el = $('sigDetail');
  if (!quiet) el.innerHTML = '<span class="loading">分析中…</span>';
  try {
    const d = await getJSON(API + '/signal?symbol=' + encodeURIComponent(s));
    if (!isCurrent()) return;
    if (d.err) { el.innerHTML = '<span class="bad">' + esc(s) + ' 查询失败: ' + esc(d.err) + '</span>'; return; }
    if (d.sym !== s) throw new Error('返回币种不符');
    const c = d.score > 30 ? 'bull' : (d.score < -30 ? 'bear' : 'neut');
    const st = d.struct || {};
    const bg = { 买入: 'rgba(48,209,88,.14)', 卖出: 'rgba(255,69,58,.14)', 持有: 'rgba(10,132,255,.14)', 观望: 'rgba(152,152,157,.10)' };
    const fg = { 买入: 'var(--green)', 卖出: 'var(--red)', 持有: 'var(--blue)', 观望: 'var(--dim)' };
    const reco = d.reco || '观望';
    let h = '<div style="display:flex;align-items:center;gap:12px;background:' + (bg[reco] || bg['观望']) + ';border:1px solid var(--line2);border-radius:12px;padding:12px 14px;margin-bottom:10px;">' +
      '<span style="font-size:22px;font-weight:800;color:' + (fg[reco] || fg['观望']) + ';letter-spacing:3px;">' + esc(reco) + '</span>' +
      '<span style="font-size:10.5px;color:var(--dim);flex:1;line-height:1.5;">' + esc(d.reco_reason || '') + '</span>' +
      '<span class="mono" style="font-size:13px;">' + fmtPrice(d.price) + '</span></div>';
    h += '<div class="sig-head"><span class="sym">' + esc(d.sym) + '</span><span class="verdict ' + c + '">' + esc(d.verdict) + ' ' + d.score + '</span></div>' +
      '<div class="sig-meta">60m ' + pct(d.ret60pct) + ' · 24h ' + pct(d.pct24) + ' · 费率 ' + d.funding + '%</div>' +
      '<div class="sig-meta" id="sigReadAt">在线读取 ' + bjNow(Date.now()) + ' 北京 · 每30秒更新</div>';
    if (d.breakdown) {
      h += '<div class="bill"><div class="bt">决策账单（每项指标如何推算出结论）</div>' +
        d.breakdown.map(b => {
          const bc = b.score > 0 ? 'gain' : (b.score < 0 ? 'loss' : 'flat');
          return '<div class="billrow"><span class="n">' + esc(b.name) + '</span><span class="s ' + bc + '">' + (b.score > 0 ? '+' : '') + b.score + '</span><span class="w">' + esc(b.note || '') + '</span></div>';
        }).join('') +
        '<div class="billrow" style="border-top:1px solid var(--line);margin-top:5px;padding-top:5px;"><span class="n">合计</span><span class="s ' + (d.score >= 0 ? 'gain' : 'loss') + '">' + d.score + '</span><span class="w">→ ' + esc(d.reco || '') + '</span></div></div>';
    }
    if (d.mf) {
      const order = ['d1', '4h', '1h', '15m', '1m'], lab = { d1: '日线', '4h': '4小时', '1h': '1小时', '15m': '15分', '1m': '1分' };
      h += '<div style="display:flex;gap:5px;margin:8px 0;">' + order.map(t => {
        const m = d.mf[t] || {};
        const dc = m.dir === '多' ? 'gain' : (m.dir === '空' ? 'loss' : 'flat');
        return '<div class="jitem" style="flex:1;text-align:center;padding:5px 2px;"><div class="k">' + lab[t] + '</div><div class="v ' + dc + '" style="font-weight:700;">' + esc(m.dir) + ' ' + (m.score || 0) + '</div></div>';
      }).join('') + '</div>';
      h += '<div style="font-size:10.5px;color:' + (d.reso.indexOf('共振') >= 0 ? 'var(--yellow)' : 'var(--dim)') + ';margin-bottom:4px;">📐 ' + esc(d.reso) + '</div>';
    }
    if (d.chart && d.chart.candles && d.chart.candles.length > 20) {
      h += '<div style="margin:8px 0;"><canvas id="miniChart" style="width:100%;height:220px;background:var(--panel2);border-radius:12px;display:block;"></canvas>' +
        '<div id="sigReason" style="font-size:10px;color:var(--yellow);margin-top:5px;min-height:14px;">点击图上的绿/红信号点查看理由</div></div>';
      setTimeout(() => { if (isCurrent()) drawMini(d.chart); }, 50);
    }
    if (d.chan) {
      const ch = d.chan;
      const sc = ch.signal.indexOf('卖') >= 0 ? 'loss' : (ch.signal !== '无' && ch.signal !== '' ? 'gain' : 'flat');
      h += '<div style="font-size:10.5px;color:var(--txt);margin-top:6px;line-height:1.8;border-top:1px dashed var(--line);padding-top:6px;">' +
        '<b>缠论结构</b>：' + esc(ch.pen) + ' · ' + esc(ch.last_pivot) +
        (ch.center ? ' · 中枢 [' + fmtPrice(ch.center[0]) + ', ' + fmtPrice(ch.center[1]) + ']' : ' · 无中枢') +
        ' · 背驰：' + esc(ch.divergence) + '<br><span class="' + sc + '" style="font-weight:700;">买卖点：' + esc(ch.signal || '无') + '</span>' +
        '<span style="color:var(--faint);">（分型→笔→中枢→背驰，1h 级简化缠论）</span></div>';
    }
    if (st.box_r1) {
      const pos = Math.min(98, Math.max(2, st.pos_pct));
      h += '<div style="font-size:10px;color:var(--faint);display:flex;justify-content:space-between;font-family:var(--mono);margin-top:8px;"><span>下沿 ' + fmtPrice(st.box_s1) + '</span><span>上沿 ' + fmtPrice(st.box_r1) + '</span></div>' +
        '<div class="boxbar"><div class="p" style="left:' + pos + '%;"></div></div>' +
        '<div class="boxlabels"><span style="color:var(--blue);">现价 · 箱体 ' + st.pos_pct + '%</span><span>MACD1h ' + esc(st.macd_cross) + '</span></div>' +
        '<div class="advice"><b>结构</b>：' + esc(st.advice || '--') + '<span class="ref">止损参考 多 ' + fmtPrice(st.stop_long_ref) + ' / 空 ' + fmtPrice(st.stop_short_ref) + ' · ATR ' + fmtPrice(st.atr) + '</span></div>';
      if (st.targets) {
        h += '<div style="font-size:10.5px;color:var(--txt);margin-top:6px;line-height:1.8;"><b>止盈参考</b>：' +
          '<span class="gain">多 ' + st.targets.long.map(fmtPrice).join(' / ') + '</span><br>' +
          '<span style="padding-left:60px;" class="loss">空 ' + st.targets.short.map(fmtPrice).join(' / ') + '</span>' +
          '<span style="color:var(--faint);display:block;margin-top:2px;">（三档：箱体沿 / 测幅目标 / 60根极值）</span></div>';
      }
    }
    h += '<div class="disc">' + esc(d.disclaimer || '') + '</div>';
    el.innerHTML = h;
  } catch (e) {
    if (!isCurrent()) return;
    el.innerHTML = '<span class="bad">接口调用失败：' + esc(e.message) + ' —— 确认信号服务(8091)在跑</span>';
  } finally {
    if (S.signalRequestId === requestId) S.signalPending = null;
  }
}
$('sigInput').addEventListener('keydown', e => { if (e.key === 'Enter') querySignal(); });
$('sigInput').addEventListener('input', () => {
  if (S.signalActive && $('sigInput').value.trim().toUpperCase() !== S.signalActive) {
    S.signalRequestId = (S.signalRequestId || 0) + 1; S.signalPending = null; S.signalActive = null;
    $('sigDetail').innerHTML = '<span class="loading">点击分析，读取当前标的</span>';
  }
});

/* 迷你图（信号板用；与主图不同，它画的是 1m + 布林 + 历史信号点） */
let miniSig = [];
function drawMini(ch) {
  const cv = $('miniChart'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 500, H = 220;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const cs = ch.candles, n = cs.length;
  const padL = 8, padR = 8, padT = 12, padB = 16, pw = W - padL - padR, ph = H - padT - padB;
  let lo = Math.min(...cs.map(x => x.l)), hi = Math.max(...cs.map(x => x.h));
  const bu = ch.boll_up.filter(x => x !== null), bl = ch.boll_lo.filter(x => x !== null);
  if (bu.length) { hi = Math.max(hi, ...bu); lo = Math.min(lo, ...bl); }
  if (hi <= lo) hi = lo + 1;
  const X = i => padL + (i + 0.5) * pw / n, Y = p => padT + (hi - p) / (hi - lo) * ph;
  const bw = Math.max(1, pw / n * 0.55);
  ctx.strokeStyle = 'rgba(10,132,255,.55)'; ctx.lineWidth = 1;
  for (const arr of [ch.boll_up, ch.boll_lo]) {
    ctx.beginPath(); let st = false;
    for (let i = 0; i < n; i++) { if (arr[i] === null) continue; st ? ctx.lineTo(X(i), Y(arr[i])) : (ctx.moveTo(X(i), Y(arr[i])), st = true); }
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const c = cs[i], up = c.c >= c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? '#30d158' : '#ff453a';
    ctx.beginPath(); ctx.moveTo(X(i), Y(c.h)); ctx.lineTo(X(i), Y(c.l)); ctx.stroke();
    const t = Y(Math.max(c.o, c.c)), b = Y(Math.min(c.o, c.c));
    ctx.fillRect(X(i) - bw / 2, t, bw, Math.max(1, b - t));
  }
  miniSig = [];
  for (const s of ch.signals || []) {
    const px = X(s.i), py = Y(cs[s.i][s.action === 'buy' ? 'l' : 'h']) - (s.action === 'buy' ? 6 : -6);
    ctx.fillStyle = s.action === 'buy' ? '#30d158' : '#ff453a';
    ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
    miniSig.push({ px, py, sig: s });
  }
  const last = cs[n - 1].c;
  ctx.strokeStyle = 'rgba(255,255,255,.32)'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(padL, Y(last)); ctx.lineTo(W - padR, Y(last)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#98989d'; ctx.font = '9px monospace';
  ctx.fillText('$' + fmtPrice(last), W - 78, Y(last) - 3);
}
document.addEventListener('click', e => {
  const cv = $('miniChart'); if (!cv || !miniSig.length) return;
  const r = cv.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (cv.width / r.width), my = (e.clientY - r.top) * (cv.height / r.height);
  for (const p of miniSig) {
    if (Math.abs(mx - p.px) < 12 && Math.abs(my - p.py) < 12) {
      $('sigReason').innerHTML = (p.sig.action === 'buy' ? '🟢 买入信号' : '🔴 卖出信号') + '（分' + p.sig.score + '）' + esc(p.sig.reason);
      return;
    }
  }
});

/* ───────────── 六币监测 / 雷达 / 图形 / 极值 ───────────── */
/* 数据陈旧判据 —— 与 redesign.js 的 10 分钟阈值同一口径（不另立第二套阈值）。
   2026-10-11 工单更正：六币监测 / 全市场信号雷达 / 图形短线判断（及同源的极值雷达）读的是
   静态 signals.json / radar.json / pa_signals.json；界面过去只印 refresh_at（时分秒），
   21 天前的快照也看着像「刚刚更新」。现一律印【日期+时间+相对时长】，超阈值打红并写明「陈旧」，
   禁止把陈旧数据表述成「实时」。 */
const DATA_STALE_MIN = 10;
function staleMinutes(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const min = (Date.now() - ms) / 60000;
  return isFinite(min) ? min : null;
}
function staleText(min) {
  if (min == null) return '时间戳未取到';
  if (min < 0) return '时钟偏差';
  if (min < 1) return Math.floor(min * 60) + ' 秒前';
  if (min < 60) return Math.round(min) + ' 分钟前';
  if (min < 1440) return (min / 60).toFixed(1) + ' 小时前';
  return Math.floor(min / 1440) + ' 天前';
}
function ageBadge(ts, extra, maxAgeSec = 600) {
  const min = staleMinutes(ts);
  const stale = min == null || min < -1/6 || min * 60 > maxAgeSec;
  const when = (typeof rdBJ === 'function') ? rdBJ(ts, 'full') : (ts == null ? '--' : String(ts));
  return '<span title="采集 ' + esc(when) + ' 北京；按源时间判断，不按页面刷新时间" class="chip ' + (stale ? 'stale' : 'on') + '">'
    + (stale ? '非当前 · ' : '更新 ') + esc(min == null ? '--' : bjNow(Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000)) + ' 北京 · '
    + staleText(min) + (extra ? ' · ' + esc(extra) : '') + '</span>';
}
/* 陈旧时在面板正文顶部再加一条醒目的红条（不只藏在角标 / tooltip 里） */
function staleBar(ts, maxAgeSec = 600) {
  const min = staleMinutes(ts);
  if (min != null && min >= -1/6 && min * 60 <= maxAgeSec) return '';
  const when = (typeof rdBJ === 'function') ? rdBJ(ts, 'full') : String(ts);
  return '<div class="stalerow">⚠ 本面板数据陈旧 ' + staleText(min) + '（最后更新 ' + esc(when)
    + ' 北京）—— 这是历史快照，不是实时值</div>';
}

async function loadSignals() {
  try {
    const d = await getJSON('signals.json?t=' + Date.now());
    $('sigAge').innerHTML = ageBadge(d.ts, '约30秒采集', 120);
    const p = $('sigPanel');
    if (!d.signals || !d.signals.length) { p.innerHTML = staleBar(d.ts, 120) + '<span class="loading">暂无可用监测数据</span>'; return; }
    p.innerHTML = staleBar(d.ts, 120) + d.signals.map(s => {
      if (s.score === null) return '<div class="sixrow"><span class="n">' + esc(s.sym.replace('USDT', '')) + '</span><span class="loss">数据失败</span><span></span><span></span></div>';
      const k = s.score > 30 ? 'bull' : (s.score < -30 ? 'bear' : 'neut');
      const dir = s.score > 30 ? '偏多' : (s.score < -30 ? '偏空' : '中性');
      const w = Math.min(100, Math.abs(s.score));
      const col = k === 'bull' ? 'var(--green)' : (k === 'bear' ? 'var(--red)' : 'var(--yellow)');
      return '<div class="sixrow" style="cursor:pointer;" onclick="openSignal(\'' + esc(s.sym) + '\')">' +
        '<span class="n">' + esc(s.sym.replace('USDT', '')) + '</span>' +
        '<span class="bar"><i style="width:' + w + '%;background:' + col + ';' + (s.score >= 0 ? 'left:50%' : 'right:50%') + ';"></i></span>' +
        '<span class="d" style="color:' + col + ';">' + dir + ' ' + s.score + '</span>' +
        '<span class="m">60m ' + pct(s.ret60pct) + ' · 费' + s.funding + '%</span></div>';
    }).join('');
  } catch (e) { $('sigAge').textContent = '更新失败'; $('sigPanel').innerHTML = '<span class="loading">信号数据加载失败</span>'; }
}

async function loadRadar() {
  try {
    const d = await getJSON('radar.json?t=' + Date.now());
    $('radarAge').innerHTML = ageBadge(d.ts, '约5分扫描', 720);
    $('radarCats').innerHTML = ['全部', '加密货币', '股票ETF', '商品期货'].map(c =>
      '<span class="mbtn" style="padding:3px 10px;font-size:10px;' + (S.radarCat === c ? 'border-color:#0a84ff;color:#8ab6f9;' : '') + '" onclick="setRadarCat(\'' + c + '\')">' + c + '</span>').join('');
    let list = (d.recent && d.recent.length) ? d.recent : [];
    if (S.radarCat !== '全部') list = list.filter(x => (x.cat || '加密货币') === S.radarCat);
    const p = $('radarPanel');
    if (!list.length) { p.innerHTML = staleBar(d.ts, 720) + '<span class="loading">本轮暂无触发信号（' + esc(S.radarCat) + '）</span>'; return; }
    const row = sig => {
      const buy = sig.action.indexOf('买入') >= 0;
      const badge = '<span class="badge ' + (buy ? 'g' : 'r') + '">' + (buy ? '买入' : '卖出') + '</span>';
      const cc = sig.cat === '商品期货' ? '#ffd60a' : (sig.cat === '股票ETF' ? '#bf5af2' : '#0a84ff');
      return '<div class="sixrow" style="cursor:pointer;" onclick="openSignal(\'' + esc(sig.sym) + '\')">' +
        '<span class="n">' + esc(sig.sym.replace('USDT', '')) + '</span>' +
        '<span style="font-size:11px;">' + badge + '<span style="color:' + cc + ';border:1px solid ' + cc + ';padding:0 5px;border-radius:4px;font-size:9px;margin-left:5px;">' + esc(sig.cat || '加密货币') + '</span>' +
        '<span style="color:var(--dim);margin-left:6px;">' + esc(sig.note) + '</span></span>' +
        '<span class="d">' + (sig.score >= 0 ? '+' : '') + sig.score + '</span>' +
        '<span class="m">' + fmtPrice(sig.price) + ' · ' + esc(sig.at) + '</span></div>';
    };
    p.innerHTML = staleBar(d.ts, 720) + list.slice(0, 12).map(row).join('') +
      '<div style="font-size:9.5px;color:var(--faint);margin-top:8px;">点任意一行 → 到信号板深度分析该币 · 按强度排序 · 最近 1 小时</div>';
  } catch (e) { $('radarAge').textContent = '更新失败'; $('radarPanel').innerHTML = '<span class="loading">雷达数据加载失败</span>'; }
}
function setRadarCat(c) { S.radarCat = c; loadRadar(); }

async function loadPaSignals() {
  try {
    const d = await getJSON('pa_signals.json?t=' + Date.now());
    $('paAge').innerHTML = ageBadge(d.ts, '约1分扫描 · ' + ((d.signals || []).length) + ' 个标的', 240);
    const p = $('paPanel');
    if (!d.signals || !d.signals.length) { p.innerHTML = staleBar(d.ts, 240) + '<span class="loading">暂无可用图形结果</span>'; return; }
    p.innerHTML = staleBar(d.ts, 240) + d.signals.map(s => {
      const tc = s.trend === '多' ? 'gain' : (s.trend === '空' ? 'loss' : 'flat');
      const right = s.right === '确认' ? '<span class="badge g">✓右侧确认</span>' : '<span style="color:var(--faint);font-size:9px;">○无确认</span>';
      const left = s.left === '预警' ? '<span class="badge r">⚠左预警</span>' : '<span style="color:var(--faint);font-size:9px;">左无预警</span>';
      const kind = s.is_alt ? '<span style="color:var(--yellow);font-size:9px;">山寨</span>' : '<span style="color:#0a84ff;font-size:9px;">主流</span>';
      const rb = s.rb_trade ? '<span class="gain" style="font-size:10px;">抄底✓止' + fmtPrice(s.rb_stop) + '</span>' : '';
      const note = s.note ? '<span style="color:var(--yellow);font-size:10px;">' + esc(s.note) + '</span>' : rb;
      return '<div class="sixrow" style="cursor:pointer;" onclick="openSignal(\'' + esc(s.sym) + '\')">' +
        '<span class="n">' + esc(s.sym.replace('USDT', '')) + '</span>' +
        '<span style="font-size:11px;">' + right + ' ' + left + ' ' + kind + ' <span style="color:var(--dim);margin-left:5px;">支' + fmtPrice(s.sup) + '/阻' + fmtPrice(s.res) + '</span></span>' +
        '<span class="d ' + tc + '">' + esc(s.trend) + '</span><span class="m">' + note + '</span></div>';
    }).join('');
  } catch (e) { $('paAge').textContent = '更新失败'; $('paPanel').innerHTML = '<span class="loading">图形数据加载失败</span>'; }
}

async function loadExtremes() {
  try {
    const d = await getJSON('radar.json?t=' + Date.now());
    $('extAge').innerHTML = ageBadge(d.ts, '约5分扫描', 720);
    const list = d.extremes || [], p = $('extPanel');
    if (!list.length) { p.innerHTML = staleBar(d.ts, 720) + '<span class="loading">暂无标的逼近历史极值</span>'; return; }
    p.innerHTML = staleBar(d.ts, 720) + list.slice(0, 12).map(e => {
      const isNew = String(e.status).indexOf('!') >= 0, isHigh = String(e.status).indexOf('新高') >= 0;
      const col = isHigh ? 'var(--green)' : 'var(--red)';
      const cc = e.cat === '商品期货' ? '#ffd60a' : (e.cat === '股票ETF' ? '#bf5af2' : '#0a84ff');
      let risk = '';
      if (isHigh && e.top_risk) {
        const rc = e.top_risk === '高' ? 'var(--red)' : (e.top_risk === '中' ? 'var(--yellow)' : 'var(--faint)');
        risk = '<span style="color:' + rc + ';border:1px solid ' + rc + ';padding:0 5px;border-radius:4px;font-size:9px;margin-left:5px;">见顶风险:' + esc(e.top_risk) + '</span>';
      }
      return '<div class="sixrow"><span class="n">' + esc(e.sym.replace('USDT', '')) + '</span>' +
        '<span style="font-size:11px;"><span style="color:' + col + ';font-weight:700;' + (isNew ? 'background:rgba(255,255,255,.06);padding:2px 6px;border-radius:5px;' : '') + '">' + esc(e.status) + '</span>' +
        '<span style="color:' + cc + ';border:1px solid ' + cc + ';padding:0 5px;border-radius:4px;font-size:9px;margin-left:6px;">' + esc(e.cat || '加密货币') + '</span>' + risk +
        '<span style="color:var(--dim);margin-left:6px;">距极值 ' + e.dist_pct + '%</span></span>' +
        '<span class="d" style="color:' + col + ';">' + (isHigh ? '↑' : '↓') + ' ' + fmtPrice(e.price) + '</span>' +
        '<span class="m">' + (isHigh ? '高 ' + fmtPrice(e.hist_high) : '低 ' + fmtPrice(e.hist_low)) + '</span></div>';
    }).join('') + '<div style="font-size:9.5px;color:var(--faint);margin-top:8px;">按距极值距离排序 · 新高类附见顶风险（背驰=高/顶分型=中）· 日线口径约 2.7 年</div>';
  } catch (e) { $('extAge').textContent = '更新失败'; $('extPanel').innerHTML = '<span class="loading">极值数据加载失败</span>'; }
}

function openSignal(sym) {
  setTab('manual');
  $('sigInput').value = sym;
  querySignal();
  setTimeout(() => { const c = $('sigDetail'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 120);
}

/* ═════════════════════ 多周期 K 线（斐波那契 + 五浪画在图里）═════════════════════ */
function buildTfBar() {
  const lab = (t) => '<span class="glab">' + t + '</span>';
  $('tfBar').innerHTML = lab('周期') + TFS.map(([k, l]) =>
    '<span class="mbtn' + (S.tf === k ? ' on' : '') + '" onclick="pickTf(\'' + k + '\')">' + l + '</span>').join('');
  $('symBar').innerHTML = lab('品种') + PICK.map(s =>
    '<span class="mbtn mono' + (S.sym === s ? ' on' : '') + '" onclick="pickSym(\'' + s + '\')">' + s.replace('USDT', '') + '</span>').join('');
  /* 斐波那契基准 —— 主人 2026-09-21 钦定**只用日线**：不再给选择器，直接写明。
     写死一个值的好处：图和代码永远算的是同一个周期，不会再出现"标签/代码对不上"。 */
  const fb = $('fibBar');
  if (fb) fb.innerHTML = '<span class="glab" title="主人钦定：斐波那契只用日线算">斐波·日线</span>';
  /* 一键预设：不用每次手点 5 个勾选框 */
  const pb = $('presetBar');
  if (pb) pb.innerHTML = lab('显示') + PRESETS.map(([k, l]) =>
    '<span class="mbtn' + (S.preset === k ? ' on' : '') + '" onclick="applyPreset(\'' + k + '\')">' + l + '</span>').join('');
  $('ovToggles').innerHTML = OVS.map(([k, l]) =>
    '<label><input type="checkbox" ' + (S.ov[k] ? 'checked' : '') + ' onchange="toggleOv(\'' + k + '\',this.checked)">' + l + '</label>').join('');
}
/* 裸K = 先看价格本身；结构 = 只看摆动/五浪/斐波/九转；全套 = 连均线布林一起上 */
const PRESETS = [
  ['naked', '裸K', { fib: false, wave: false, td: false, ema: false, boll: false }],
  ['struct', '结构', { fib: true, wave: true, td: true, ema: false, boll: false }],
  ['full', '全套', { fib: true, wave: true, td: true, ema: true, boll: true }],
];
function applyPreset(n) {
  const p = PRESETS.find(([k]) => k === n);
  if (!p) return;
  S.preset = n;
  Object.assign(S.ov, p[2]);
  buildTfBar();
  saveView();
  renderKline();          // 只换叠加层, 不用重新取数
}
function pickAnchor(a) { S.anchor = a; buildTfBar(); saveView(); loadKline(true); }
function pickTf(t) { S.tf = t; buildTfBar(); saveView(); loadKline(true); }
function pickSym(s) { S.sym = s; $('kSym').value = s; buildTfBar(); saveView(); loadKline(true); loadVerdict(true); loadTaAll(true); }
function toggleOv(k, v) { S.ov[k] = v; saveView(); renderKline(); }
$('kGo').addEventListener('click', () => {
  const v = ($('kSym').value || '').trim().toUpperCase();
  if (!v) return;
  S.sym = v; buildTfBar(); saveView(); loadKline(true); loadVerdict(true); loadTaAll(true);
});
$('kSym').addEventListener('keydown', e => { if (e.key === 'Enter') $('kGo').click(); });

const TF_CAD = { '1': 15000, '15': 20000, '30': 25000, '60': 30000, 'D': 60000, 'W': 90000 };

async function loadKline(force) {
  const cad = TF_CAD[S.tf] || 30000;
  if (!force && Date.now() - (S.last.kl || 0) < cad) return;
  S.last.kl = Date.now();
  const requestId = S.klineRequestId = (S.klineRequestId || 0) + 1;
  const requestSymbol = S.sym, requestTf = S.tf, requestAnchor = S.anchor;
  const isCurrent = () => requestId === S.klineRequestId && requestSymbol === S.sym && requestTf === S.tf && requestAnchor === S.anchor;
  if (S.kl && (S.kl.sym !== requestSymbol || String(S.kl.tf) !== String(requestTf))) { S.kl = null; renderKline(); }
  $('kAge').className = 'chip gray'; $('kAge').textContent = '拉取中…';
  try {
    const p = await getJSON(API + '/klines?symbol=' + encodeURIComponent(requestSymbol) + '&tf=' + requestTf
      + (requestAnchor ? '&anchor=' + requestAnchor : ''));
    if (!isCurrent()) return;
    if (p.ok && (p.sym !== requestSymbol || String(p.tf) !== String(requestTf))) throw new Error('返回的币种或周期不匹配');
    if (!p.ok) { $('kAge').className = 'chip off'; $('kAge').textContent = '失败';
      $('kFoot').innerHTML = '<span class="bad">K 线取数失败：' + esc(p.err || '') + '</span>' + klineStaleNote(); return; }
    S.kl = p;
    const age = (Date.now() - p.fetched_at) / 1000;
    $('kAge').className = 'chip on';
    $('kAge').textContent = p.label + ' · ' + ageStr(age) + (p.last_bar_closed ? ' · 已收线' : ' · 进行中');
    renderKline();
  } catch (e) {
    if (!isCurrent()) return;
    $('kAge').className = 'chip off'; $('kAge').textContent = '取数失败';
    $('kFoot').innerHTML = '<span class="bad">连不上信号服务 8091（' + esc(e.message) + '）—— K 线需要它经代理取 Bybit 数据</span>' + klineStaleNote();
  }
}
/* 取数失败时，图上若还留着上一次成功的K线，必须写明它是旧的 —— 不得静默当实时 */
function klineStaleNote() {
  const f = S.kl && S.kl.fetched_at;
  if (!f) return '<div class="bad">图上没有可用数据（本次未取到）</div>';
  const min = staleMinutes(f);
  const when = (typeof rdBJ === 'function') ? rdBJ(f, 'full') : String(f);
  return '<div class="stalerow small">⚠ 图上保留的是上次成功取到的数据（截止 ' + esc(when) + ' 北京 · '
    + staleText(min) + '）—— 不是实时值</div>';
}

/* 九转计数：与 ta_lib.td_sequential 同口径（c==c4 归零；走满 9 归 1 重新数）
   主人 2026-09-20 指出图上数到 11、12 是错的 —— 旧口径 run_len 不封顶，现在两边一起封。 */
function tdCounts(cs) {
  const out = []; let dir = null, len = 0;
  for (let i = 0; i < cs.length; i++) {
    if (i < 4) { out.push(null); continue; }
    const c = cs[i][4], c4 = cs[i - 4][4];
    const d = c < c4 ? 'buy' : (c > c4 ? 'sell' : null);
    if (d === null || d !== dir) { dir = d; len = d ? 1 : 0; } else len++;
    out.push(d ? { dir: d, count: ((len - 1) % 9) + 1, raw: len } : null);
  }
  return out;
}

function renderKline() {
  const p = S.kl, cv = $('kline');
  if (!cv) return;
  if (!p || !p.ok || p.sym !== S.sym || String(p.tf) !== String(S.tf)) {
    S.sigMarkers = []; $('kTip').style.display = 'none';
    if (window.ManualMinuteChart) window.ManualMinuteChart.clear();
    const c = cv.getContext('2d'); cv.width = cv.width; c.clearRect(0, 0, cv.width, cv.height); return;
  }
  const useMinutePoints = !!window.ManualMinuteChart && String(S.tf) === '1';
  const cs = p.candles, n = cs.length;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900;
  /* 图跟着窗口长高, 不再写死 430 —— 主人屏幕 Css 视口只有约 912px 高, 写死高度等于浪费半屏 */
  /* r3 那轮把上限压到 600、预留加到 360，结果 912 视口下画布从 612 掉到 552 —— **图反而更小了**，
     方向是反的（首屏可见高度一点没变，只是分母变小显得占比好看）。
     K 线卡现在已经挪到页面最前面（首屏直接就是图），所以高度回到原来的上限，让图尽量大。 */
  const H = Math.max(320, Math.min(660, Math.round(window.innerHeight - 300)));
  cv.style.height = H + 'px';
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const padL = 10, padR = 86, padT = 14, padB = 8, g = 10;
  const volH = 46, rsiH = 52;
  const priceH = H - padT - padB - volH - rsiH - g * 2;
  const priceT = padT, volT = priceT + priceH + g, rsiT = volT + volH + g;
  const pw = W - padL - padR;

  /* 价格范围：K线 + 布林 + EMA + 图内斐波位 */
  let lo = Infinity, hi = -Infinity;
  for (const c of cs) { if (c[3] < lo) lo = c[3]; if (c[2] > hi) hi = c[2]; }
  const extra = [];
  if (S.ov.boll) { for (const a of [p.boll_up, p.boll_lo]) for (const v of a) if (v != null) extra.push(v); }
  if (S.ov.ema) { for (const a of [p.ema20, p.ema50]) for (const v of a) if (v != null) extra.push(v); }
  const ta = p.ta || {};
  /* 斐波那契基准: 默认本周期, 也可以让主人指定用哪个周期的摆动来量。
     基准里带着 label/zz_pct, 图上必须把它写出来 —— 否则"到底按哪个周期算的"全靠猜。 */
  const fa = p.fib_anchor || { tf: p.tf, label: p.label, zz_pct: p.zz_pct, fib: ta.fib };
  /* 基准段怎么选：zigzag 的摆动点要等反向走够 zz_pct% 才**确认**，所以强势单边里最后那个
     "已确认"摆动点可能早就作废了。2026-09-21 主人在日线图（基准=周线）上发现：代码量的是
     89.61→75.09 那段**下跌**，而现价 95.59 已经把它突破（回撤 141%），7 条线全落在现价
     下方 → 看着"完全在范围外"。公式没错，是**基准那段已经作废**。
     所以：有进行中的摆动就用它（画成 进行中·未确认），没有才用已确认那段。 */
  const fLive = (fa.fib_prov && fa.fib_prov.ok) ? fa.fib_prov
              : ((ta.fib_prov && ta.fib_prov.ok) ? ta.fib_prov : null);
  const fib = (fLive && fLive.prov) ? fLive : (fa.fib || {}), lv = (S.ov.fib && fib.ok) ? (fib.levels || []) : [];
  const R0 = Math.max(1e-12, hi - lo);
  const inR = [], outR = [];
  for (const L of lv) { (L.price >= lo - R0 * 0.5 && L.price <= hi + R0 * 0.5) ? inR.push(L) : outR.push(L); }
  for (const v of extra.concat(inR.map(x => x.price))) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const pad = (hi - lo) * 0.07; lo -= pad; hi += pad;
  if (!(hi > lo)) { hi = lo + 1; }
  const X = i => padL + (i + 0.5) * pw / n;
  const Y = v => priceT + (hi - v) / (hi - lo) * priceH;

  /* 背景网格 + 右侧价格轴 */
  let badgeBottom = 0;         // 徽标行底边：先声明（斐波扩展位在徽标之前画，要用它避让）
  ctx.font = '9.5px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (let k = 0; k <= 5; k++) {
    const v = hi - (hi - lo) * k / 5, y = Y(v);
    ctx.strokeStyle = 'rgba(255,255,255,.045)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
    ctx.fillStyle = '#636368'; ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(v), padL + pw + 6, y);
  }

  /* 布林带 */
  if (S.ov.boll && p.boll_up) {
    ctx.beginPath(); let st = false;
    for (let i = 0; i < n; i++) { const v = p.boll_up[i]; if (v == null) continue; st ? ctx.lineTo(X(i), Y(v)) : (ctx.moveTo(X(i), Y(v)), st = true); }
    for (let i = n - 1; i >= 0; i--) { const v = p.boll_lo[i]; if (v == null) continue; ctx.lineTo(X(i), Y(v)); }
    ctx.closePath(); ctx.fillStyle = 'rgba(10,132,255,.055)'; ctx.fill();
    for (const arr of [p.boll_up, p.boll_lo, p.boll_mid]) {
      ctx.beginPath(); let s2 = false;
      for (let i = 0; i < n; i++) { const v = arr[i]; if (v == null) continue; s2 ? ctx.lineTo(X(i), Y(v)) : (ctx.moveTo(X(i), Y(v)), s2 = true); }
      ctx.strokeStyle = 'rgba(10,132,255,.42)'; ctx.lineWidth = 1; ctx.setLineDash(arr === p.boll_mid ? [4, 3] : []); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  /* 斐波那契：横线 + 右侧标签 */
  BADGES = [];                 // 每次重画都清空徽标行
  badgeBottom = 0;             // 徽标行底边，由下面的徽标段回填；斐波扩展位要用它避让
  if (S.ov.fib && fib.ok) {
    for (const L of inR) {
      const y = Y(L.price);
      const isExt = L.kind === 'extend';
      ctx.strokeStyle = isExt ? 'rgba(255,159,10,.62)' : 'rgba(191,90,242,.58)';
      ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke(); ctx.setLineDash([]);
      /* 图上只留比例数字（如 0.618），压在虚线下方；价格不画在这里 ——
         价格已经在右侧价格轴上，重复一遍只是噪声。完整比例表见图下方「依据」折叠块。 */
      const txt = L.ratio.toFixed(3);
      ctx.font = '9px ui-monospace, monospace';
      const tw = ctx.measureText(txt).width + 8;
      ctx.fillStyle = 'rgba(8,8,10,.72)';
      ctx.fillRect(padL + pw - tw - 3, y + 1, tw, 12);
      ctx.fillStyle = isExt ? 'rgba(255,159,10,.9)' : 'rgba(217,166,255,.9)';
      ctx.textAlign = 'right';
      ctx.fillText(txt, padL + pw - 7, y + 7);
    }
    /* 图外的扩展位：贴边给一个箭头，别让主人以为没画。
       这两行必须避开左上角的徽标行 —— 徽标底衬从 priceT+6 起、高 17，原来 ↑扩 正好压在
       底衬带上、↓扩 直接落进底衬里被盖住。统一挪到徽标行下方（badgeBottom 由徽标段回填）。 */
    let oi = 0;
    for (const L of outR) {
      const up = L.price > hi;
      const y = (badgeBottom || priceT + 23) + 18 + oi * 11;
      ctx.fillStyle = 'rgba(255,159,10,.85)'; ctx.textAlign = 'left';
      /* 图外的扩展位：贴边给箭头。价格不再写在这里 —— 同一张图上右边只标比例、左边标价格，
         两种口径并存是三轮自动迭代终审点出来的不一致；价格去右侧价格轴对，比例表在「依据」里。 */
      ctx.fillText((up ? '↑扩' : '↓扩') + L.ratio.toFixed(3), padL + 6, y);
      oi++;
    }
    /* 斐波基准段（从哪一段量出来的）—— 只有两个端点都落在本图窗口内才画得出来 */
    const leg = fib.leg;
    const ti = {}; for (const pv of (ta.pivots || [])) ti[pv.ts] = pv.idx;
    if (ti[leg.from_ts] != null && ti[leg.to_ts] != null) {
      const i0 = ti[leg.from_ts], i1 = ti[leg.to_ts];
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.4; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(X(i0), Y(leg.from)); ctx.lineTo(X(i1), Y(leg.to)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.textAlign = 'left';
      ctx.font = '9.5px ui-monospace, monospace';
      ctx.fillText('斐波·' + fa.label + ' ' + leg.size_pct.toFixed(1) + '%', Math.min(X(i0), X(i1)) + 4, Y(Math.max(leg.from, leg.to)) - 10);
    } else if (fib.prov) {
      /* 进行中的摆动：终点就是"现价"，还没被 zigzag 确认，基准线画不出来。
         以前这里写了一大句"已确认那段 xx→xx 已被突破、作废"，压在左上角跟趋势徽标打架 ——
         现在只留一枚短徽标，细节在下面 kFoot 里。 */
      BADGES.push(['斐波·' + fa.label + ' 进行中 ' + (fib.prov_moved_pct >= 0 ? '+' : '') +
        fib.prov_moved_pct.toFixed(1) + '%', '#ff9f0a']);
    }
  }

  /* EMA */
  if (S.ov.ema) {
    const lines = [[p.ema20, '#ffd60a', 'EMA20'], [p.ema50, '#bf5af2', 'EMA50']];
    for (const [arr, col] of lines) {
      ctx.beginPath(); let s3 = false;
      for (let i = 0; i < n; i++) { const v = arr[i]; if (v == null) continue; s3 ? ctx.lineTo(X(i), Y(v)) : (ctx.moveTo(X(i), Y(v)), s3 = true); }
      ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.stroke();
    }
  }

  /* K 线 */
  const bw = Math.max(1, pw / n * 0.6);
  for (let i = 0; i < n; i++) {
    const c = cs[i], up = c[4] >= c[1];
    ctx.strokeStyle = ctx.fillStyle = up ? '#30d158' : '#ff453a';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(i), Y(c[2])); ctx.lineTo(X(i), Y(c[3])); ctx.stroke();
    const t = Y(Math.max(c[1], c[4])), b = Y(Math.min(c[1], c[4]));
    ctx.fillRect(X(i) - bw / 2, t, bw, Math.max(1, b - t));
  }

  /* ZigZag 折线 + 五浪标注 */
  const pv = (ta.pivots || []).filter(x => x.idx >= 0 && x.idx < n);
  if (pv.length >= 2) {
    ctx.strokeStyle = 'rgba(255,159,10,.9)'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(X(pv[0].idx), Y(pv[0].price));
    for (let i = 1; i < pv.length; i++) ctx.lineTo(X(pv[i].idx), Y(pv[i].price));
    ctx.stroke();
    for (const q of pv) {
      ctx.fillStyle = q.kind === 'H' ? 'rgba(255,69,58,.9)' : 'rgba(48,209,88,.9)';
      ctx.beginPath(); ctx.arc(X(q.idx), Y(q.price), 2.6, 0, Math.PI * 2); ctx.fill();
    }
  }
  /* ═══ 五浪 ═══
     主人 2026-09-21：「五浪也不对，重新做；**用一小时线做基准**；每个符号都要看得清楚，
     不要堆在一起。」所以：① 波浪结构一律取 1 小时周期的（服务端 wave_anchor）——
     十分钟图上数日线的浪、日线图上数周的浪，本来就没法看；② 标签只留短号 W1~W5
     并带底衬，涨跌幅挪到下面 kFoot；③ 标签之间做避让，挤到了就往外挪一格。 */
  const wv = ((p.wave_anchor && p.wave_anchor.wave) || ta.wave || {});
  const wvTf = (p.wave_anchor && p.wave_anchor.label) || p.label;
  let wvTxt = '';
  if (S.ov.wave && wv.labels && wv.labels.length === 5) {
    /* 1 小时的摆动点要能落到当前图（可能是日线/周线）的柱子上 —— 按时间戳二分找柱 */
    const idxOfTs = (ts) => {
      if (ts == null) return null;
      if (ts < cs[0][0]) return null;
      if (ts >= cs[n - 1][0]) return n - 1;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cs[mid][0] <= ts) lo = mid; else hi = mid - 1;
      }
      return lo;
    };
    const pts = [];
    for (const L of wv.labels) {
      const i0 = idxOfTs(L.from_ts), i1 = idxOfTs(L.to_ts);
      if (i0 == null || i1 == null) continue;
      pts.push({ i0: i0, i1: i1, a: L.from, b: L.to, up: L.dir === 'up', chg: L.chg_pct });
    }
    if (pts.length) {
      ctx.strokeStyle = 'rgba(100,210,255,.8)'; ctx.lineWidth = 1.6; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(X(pts[0].i0), Y(pts[0].a));
      for (const q of pts) ctx.lineTo(X(q.i1), Y(q.b));
      ctx.stroke();
    }
    const placed = [];
    ctx.textBaseline = 'middle';
    for (let k = 0; k < pts.length; k++) {
      const q = pts[k];
      const col = wv.valid ? (q.up ? '#30d158' : '#ff453a') : 'rgba(255,255,255,.72)';
      const label = (wv.valid ? '' : '✗') + 'W' + (k + 1);
      ctx.font = 'bold 12px ui-monospace, monospace';
      const tw = ctx.measureText(label).width + 14, th = 18;
      const cx = Math.round((X(q.i0) + X(q.i1)) / 2);
      let cy = Math.round((Y(q.a) + Y(q.b)) / 2) + (q.up ? -24 : 24);
      for (let t = 0; t < 8; t++) {
        const clash = placed.some(function (r) {
          return Math.abs(r.cx - cx) < (r.tw + tw) / 2 + 6 &&
                 Math.abs(r.cy - cy) < (r.th + th) / 2 + 4;
        });
        if (!clash) break;
        cy += (q.up ? -18 : 18);
      }
      placed.push({ cx: cx, cy: cy, tw: tw, th: th });
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(8,8,10,.92)'; ctx.strokeStyle = col; ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(cx - tw / 2, cy - th / 2, tw, th, 5);
      else ctx.rect(cx - tw / 2, cy - th / 2, tw, th);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = col; ctx.fillText(label, cx, cy + 0.5);
    }
    wvTxt = '五浪基准 ' + wvTf + '：' + wv.labels.map((L, i) =>
      'W' + (i + 1) + ' ' + (L.chg_pct >= 0 ? '+' : '') + L.chg_pct.toFixed(2) + '%').join(' · ');
    BADGES.push(['五浪 ' + (wv.valid ? '✓' : '✗') + ' · ' + wvTf, wv.valid ? '#30d158' : '#ffd60a']);
    if (wv.current_leg && pv.length) {
      const lastpv = pv[pv.length - 1];
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(X(lastpv.idx), Y(lastpv.price)); ctx.lineTo(X(n - 1), Y(cs[n - 1][4])); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  /* 神奇九转 */
  if (S.ov.td) {
    const tdc = tdCounts(cs);
    for (let i = 4; i < n; i++) {
      const t = tdc[i]; if (!t) continue;
      if (t.count < 7) continue;        // 只画 7/8/9 —— 每次重新计数都画个 "1" 是纯噪声
      const c = cs[i], buy = t.dir === 'buy';
      const y = buy ? Y(c[3]) + 12 : Y(c[2]) - 12;
      ctx.fillStyle = t.count >= 9 ? (buy ? '#30d158' : '#ff453a') : 'rgba(245,245,247,.62)';
      ctx.font = (t.count === 9 ? 'bold ' : '') + '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(t.count), X(i), y);
    }
  }

  /* ═══ 结构共振买卖点 ═══
     只画服务端筛出来的那几个：≥3 条独立条件同时成立、**且至少含一条结构类证据**
     （插针/放量/突破/双底双顶/顺趋势），同向间隔≥12根，多空各≤3 个。
     每个点带一个分数，鼠标停上去给具名理由 —— 理由是可核对的，不是"看着要涨"。
     **逆分钟趋势的点画成空心**：趋势向下还敢做多，图上就该一眼看出来它更可疑。 */
  S.sigMarkers = [];
  for (const sg of (useMinutePoints ? [] : (p.signals || []))) {
    const si = sg.i;
    if (!(si >= 0 && si < n)) continue;
    const buy = sg.side === 'buy';
    const x = X(si);
    const y = buy ? Y(cs[si][3]) + 22 : Y(cs[si][2]) - 22;
    const col = buy ? '#30d158' : '#ff453a';
    ctx.beginPath();
    if (buy) { ctx.moveTo(x, y - 8); ctx.lineTo(x - 8, y + 5); ctx.lineTo(x + 8, y + 5); }
    else { ctx.moveTo(x, y + 8); ctx.lineTo(x - 8, y - 5); ctx.lineTo(x + 8, y - 5); }
    ctx.closePath();
    if (sg.against) {                       /* 逆势 = 空心 */
      ctx.fillStyle = '#0b0b0d'; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    } else {
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineWidth = 1; ctx.stroke();
    }
    /* 分数不再画在标记旁边 —— 它本来是压在 K 线实体上的小字，跟九转数字、价格轴挤在一起。
       分数是「这条信号有多硬」的证据，不是「在哪」的证据：图上看方向（三角/颜色/实心空心），
       要看几分去鼠标悬停，或看下方「依据」折叠块里的明细。 */
    S.sigMarkers.push({ x: x, y: y, sg: sg });
  }

  /* ═══ 分钟级趋势徽标 ═══
     主人 2026-09-20 要求"先判断是上升还是下降趋势"。这个判断必须画在图上 ——
     否则下面那些买卖点就没有方向可言，跟"超卖就买"没区别。
     2026-09-21：不再单独画，改成塞进左上角那一行徽标的**第一个**。 */
  (function () {
    const T = { up: ['▲ 上升', '#30d158'],
                down: ['▼ 下降', '#ff453a'],
                range: ['◆ 震荡', '#8e8e93'] };
    BADGES.unshift(T[p.trend] || T.range);
  })();

  /* ═══ 左上角状态徽标 · 排成一行画 ═══ */
  (function () {
    let x = padL + 6;
    const y = priceT + 6;
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const b of BADGES) {
      const tw = ctx.measureText(b[0]).width + 14;
      ctx.fillStyle = 'rgba(0,0,0,.62)';
      ctx.fillRect(x, y, tw, 17);
      ctx.fillStyle = b[1];
      ctx.fillText(b[0], x + 7, y + 9);
      x += tw + 6;
    }
    badgeBottom = y + 17;
  })();

  /* 图内右上角颜色图例 —— 画在画布里不占布局高度，且解决"黄线到底是 EMA 还是摆动"的歧义 */
  const lg = [];
  if (S.ov.ema) { lg.push(['#ffd60a', 'EMA20']); lg.push(['#bf5af2', 'EMA50']); }
  if (S.ov.boll) lg.push(['#0a84ff', '布林20,2']);
  if (S.ov.fib) lg.push(['#d9a6ff', '斐波那契']);
  lg.push(['#ff9f0a', '摆动折线']);
  if (S.ov.td) lg.push(['#f5f5f7', '九转7-9']);
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  let lx = padL + pw - 4;
  for (let i = lg.length - 1; i >= 0; i--) {
    const c = lg[i][0], t2 = lg[i][1];
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillText(t2, lx, priceT + 8);
    lx -= (ctx.measureText(t2).width + 13);
    ctx.fillStyle = c;
    ctx.fillRect(lx + 4, priceT + 5, 6, 6);
  }

  /* 现价线 */
  const lastC = cs[n - 1][4];
  ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, Y(lastC)); ctx.lineTo(padL + pw, Y(lastC)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#f5f5f7'; ctx.textAlign = 'left'; ctx.font = 'bold 10px ui-monospace, monospace';
  ctx.fillText(fmtPrice(lastC), padL + pw + 6, Y(lastC));

  /* 成交量 */
  const vmax = Math.max.apply(null, p.vol.concat([1]));
  for (let i = 0; i < n; i++) {
    const up = cs[i][4] >= cs[i][1];
    ctx.fillStyle = up ? 'rgba(48,209,88,.42)' : 'rgba(255,69,58,.42)';
    const h = p.vol[i] / vmax * (volH - 4);
    ctx.fillRect(X(i) - bw / 2, volT + volH - h, bw, h);
  }
  ctx.fillStyle = '#636368'; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'left';
  ctx.fillText('成交量', padL + 2, volT + 6);

  /* RSI */
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.strokeRect(padL, rsiT, pw, rsiH);
  for (const lv2 of [30, 50, 70]) {
    const y = rsiT + rsiH - lv2 / 100 * rsiH;
    ctx.strokeStyle = lv2 === 50 ? 'rgba(255,255,255,.08)' : 'rgba(255,214,10,.16)';
    ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#636368'; ctx.textAlign = 'right'; ctx.fillText(String(lv2), padL + pw - 3, y - 5);
  }
  ctx.beginPath(); let s4 = false;
  for (let i = 0; i < n; i++) {
    const v = p.rsi[i]; if (v == null) continue;
    const y = rsiT + rsiH - v / 100 * rsiH;
    s4 ? ctx.lineTo(X(i), y) : (ctx.moveTo(X(i), y), s4 = true);
  }
  ctx.strokeStyle = '#0a84ff'; ctx.lineWidth = 1.2; ctx.stroke();
  const rLast = p.rsi[n - 1];
  ctx.fillStyle = '#8ab6f9'; ctx.textAlign = 'left'; ctx.font = '9.5px ui-monospace, monospace';
  ctx.fillText('RSI14 ' + (rLast == null ? '--' : rLast.toFixed(2)) + (rLast > 70 ? ' 超买' : (rLast < 30 ? ' 超卖' : '')), padL + 2, rsiT + 6);

  if (window.ManualMinuteChart) {
    S.sigMarkers.push(...window.ManualMinuteChart.draw({ctx:ctx,canvas:cv,chart:p,symbol:S.sym,tf:S.tf,X:X,Y:Y,
      area:{left:padL,right:padL+pw,top:priceT,bottom:priceT+priceH}}));
  }

  /* 右侧常驻只留「一眼扫」的两个数：最新收盘 + 相对本根开盘的涨跌%。
     开/高/低没丢 —— 鼠标停到任意一根 K 线上，浮层里写着 开/高/低/收/量（见 kTip）。
     原来那一串「最新 开… 高… 低… 收…」占掉大半行，和浮层完全重复。 */
  const kb = cs[n - 1];
  const kn = $('kNow');
  if (kn) {
    const up = kb[4] >= kb[1];
    const pct = kb[1] ? (kb[4] - kb[1]) / kb[1] * 100 : 0;
    kn.innerHTML = '<span class="glab">最新</span><b>' + esc(S.sym) + '</b> '
      + '<b class="' + (up ? 'gain' : 'loss') + '">' + fmtPrice(kb[4]) + '</b> '
      + '<span class="' + (up ? 'gain' : 'loss') + '">' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</span>';
  }
  /* 吸顶行情条上的「当前看的标的」—— 不写这一行，条上是 BTC、图上是别的币，谁看谁懵 */
  const mk = $('mkSym');
  if (mk) {
    const chg = kb[4] >= kb[1];
    mk.innerHTML = '当前图表 ' + esc(S.sym) + ' <b class="' + (chg ? 'gain' : 'loss') + '">' + fmtPrice(kb[4]) + '</b>';
  }

  /* 页脚：结构文字。
     主人 2026-09-21：「字太多了不太好看」。所以分两层 ——
     第一层只留**结论**（一行，扫一眼就够），第二层把"为什么这么判"折进 <details>，
     想核对的时候点开，平时不占版面。 */
  const td = ta.td || {};
  const bits = [], notes = [];
  /* 第一行只放「现在什么状态」——周期/根数/ZigZag/摆动点这类**统计口径**挪进「依据」，
     它们不是结论，是核对用的。（三轮自动迭代的终审把这一条列为最该改的靶点：124 字太挤） */
  notes.push('口径：<b>' + esc(p.label) + '</b> ' + n + ' 根 · ZigZag 阈值 ' + p.zz_pct + '% · 摆动点 '
    + (ta.pivots_clean_n != null ? ta.pivots_clean_n : (ta.pivots || []).length) + ' 个（图上只画最近 '
    + (ta.pivots || []).length + ' 个）');
  if (td.dir) bits.push('九转 ' + (td.dir === 'buy' ? '买' : '卖') + td.count
    + (td.count >= 9 ? ' <span class="warn">(到 9，易衰竭)</span>' : ''));
  if (fib.ok) {
    const rtv = Number(fib.retrace_now_pct);
    const inRange = rtv >= 0 && rtv <= 100;
    bits.push('斐波 <b>' + esc(fa.label) + '</b> '
      + (inRange ? '回撤 <b>' + rtv.toFixed(1) + '%</b>'
                 : '<span class="warn">已在摆动区间外</span>'));
    notes.push('斐波那契：基准 = ' + esc(fa.label) + '（ZigZag ' + fa.zz_pct + '%），摆动 '
      + fmtPrice(fib.leg.from) + ' → ' + fmtPrice(fib.leg.to) + '（' + fib.leg.dir + '，'
      + fib.leg.size_pct.toFixed(1) + '%）。'
      + (inRange ? '现价在其' + (fib.leg.dir === 'up' ? '上升' : '下降') + '段 ' + rtv.toFixed(1) + '% 位置。'
        : '现价已' + (rtv > 100 ? '越过' : '反向跌破') + '该摆动区间（' + rtv.toFixed(0)
          + '%）—— 这条摆动不再是有效基准，换一段或换基准周期。'));
  } else bits.push('<span class="warn">斐波：取数失败</span>');
  /* 斐波那契完整比例表 —— 图上已经只留比例数字，价格在这里可查（对齐右侧价格轴） */
  if (S.ov.fib && fib.ok && lv.length) {
    notes.push('斐波那契比例位（' + (inR.length + outR.length) + ' 条）：'
      + lv.map(L => L.ratio.toFixed(3) + ' = ' + fmtPrice(L.price)
          + (L.kind === 'extend' ? '（扩展）' : '')).join(' · ')
      + '。图上只标比例数字，压在虚线下方；价格去右侧价格轴对。');
  }
  if (wvTxt) bits.push('五浪 ' + (wv.valid ? '<span style="color:var(--green)">✓</span>' : '<span class="warn">✗</span>'));
  if (wvTxt) notes.push(wvTxt);
  if (!wv.valid && wv.reason) notes.push('五浪未通过的原因：' + esc(wv.reason));
  const sigs = useMinutePoints ? [] : (p.signals || []);
  const TRN = { up: '<span class="gain">上升</span>', down: '<span class="loss">下降</span>',
                range: '<span style="color:var(--faint);">震荡</span>' };
  bits.push('趋势 <b>' + (TRN[p.trend] || '—') + '</b>');
  if (!useMinutePoints) notes.push('分钟级趋势怎么写出来的：更高的高点 + 更高的低点 = 上升，反之 = 下降，其余算震荡（'
    + '只看已确认的摆动点，所以是"当时能看出来的趋势"）。买点不采信"顺趋势"——实测上升趋势里的'
    + '买点最差；逆势信号一概不给，除非趋势反转已确认；震荡里的卖点必须有位置证据。');
  if (useMinutePoints) {
    bits.push('分钟买卖点：与上方双卡同源');
    notes.push('买卖点：1分收盘回收/回落与量能确认，5分强下降阻止新买点；卖点用于已有多仓减仓。图上“趋势”徽标仍是原摆动结构描述，不代替买卖点的5分过滤。');
    notes.push('图中每侧只标最近一次确认点，锚定确认K线收盘价，不回标最低/最高价。历史·到期/失效不是当前指令；观察虚线未确认。点击或悬停标签查看确认时间与失效界限。卖点为减仓参考。');
  } else if (sigs.length) {
    bits.push('买卖点 ' + sigs.map(s => (s.side === 'buy' ? '<span class="gain">▲买</span>' : '<span class="loss">▼卖</span>')
      + s.score + (s.against ? '<span style="color:var(--faint);">空</span>' : '')).join(' '));
    notes.push('买卖点：实心 = 顺势，空心 = 逆势（已经过反转确认才放行）；鼠标停到图上的标记看具名理由。'
      + '图上的三角标记不再标数字，分数是这几条：'
      + sigs.map(s => (s.side === 'buy' ? '▲买' : '▼卖') + ' 第' + s.i + '根 ' + s.score + ' 分'
          + (s.against ? '（逆势·空心）' : '')).join('；') + '。');
  } else {
    bits.push('<span style="color:var(--faint);">无共振买卖点</span>');
  }
  notes.push('结构只描述"现在长什么样"，不预测方向。');
  $('kFoot').innerHTML = '<div class="kfline">' + bits.join(' <i class="kfsep">·</i> ') + '</div>'
    + '<details class="kfmore"><summary>依据 / 说明（' + notes.length + '）</summary>'
    + notes.map(x => '<div class="kfnote">' + x + '</div>').join('') + '</details>';
}

/* 买卖点悬停提示的内容 —— 抽成函数，好被无头渲染直接验证（见文件末尾的 tipprobe 钩子）。
   坐标命中是 3 行几何判断，容易看；真正会写错的是这里拼的字符串。 */
function sigTipHtml(s) {
  const buy = s.side === 'buy';
  const col = buy ? '#30d158' : '#ff453a';
  const TR = { up: '上升', down: '下降', range: '震荡' };
  /* 标签按**实际成立的证据**给，不按当时趋势值给 —— 买点已经不采信"顺分钟趋势"了，
     若还按 trend=up 显示"顺分钟趋势"，等于把一条没算分的条件说成算分的。 */
  const aligned = (s.tags || []).indexOf('顺分钟趋势') >= 0;
  return '<b style="color:' + col + ';font-size:12px;">' + (buy ? '▲ 买点' : '▼ 卖点') + '</b> ' +
    '<span style="color:#98989d;">' + s.score + ' 条条件共振</span>' +
    (s.against ? '<span style="color:#ff9f0a;"> · 逆分钟趋势</span>'
               : (aligned ? '<span style="color:#30d158;"> · 顺分钟趋势</span>' : '')) +
    '<br><span style="color:#636368;">' + bjFull(s.ts) + '（本机时区）· 当时趋势 '
    + (TR[s.trend] || '—') + '</span><br>' +
    '价 ' + fmtPrice(s.price) + '<br>' +
    '<span style="color:#ffd60a;">理由：</span><br>' +
    (s.reasons || []).map(t => '· ' + esc(t)).join('<br>');
}

/* 鼠标十字线读数 */
(function () {
  const cv = $('kline'), tip = $('kTip');
  function showKlineTip(ev) {
    const p = S.kl; if (!p || !p.ok) return;
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    /* 先判是不是停在买卖点上 —— 停上了就优先给"确定的理由"（主人要的核心） */
    const hit = (S.sigMarkers || []).find(m => (m.box && x >= m.box.x && x <= m.box.x + m.box.w && y >= m.box.y && y <= m.box.y + m.box.h) || (Math.abs(m.x - x) < 15 && Math.abs(m.y - y) < 17));
    if (hit) {
      tip.style.whiteSpace = 'normal';
      tip.style.maxWidth = '290px';
      tip.innerHTML = hit.kind === 'minute' && window.ManualMinuteChart ? window.ManualMinuteChart.tipHtml(hit.sg) : sigTipHtml(hit.sg);
      tip.style.display = 'block';
      tip.style.left = Math.min(Math.max(4, cv.clientWidth - 300), x + 14) + 'px';
      tip.style.top = Math.min(Math.max(4, y - 50), Math.max(4, cv.clientHeight - 96)) + 'px';
      return;
    }
    /* 不在买卖点上就给普通 OHLC 读数 */
    tip.style.whiteSpace = 'nowrap';
    tip.style.maxWidth = 'none';
    const padL = 10, padR = 86, pw = cv.clientWidth - padL - padR;
    const n = p.candles.length;
    const i = Math.max(0, Math.min(n - 1, Math.floor((x - padL) / pw * n)));
    const c = p.candles[i];
    const tdc = tdCounts(p.candles)[i];
    tip.innerHTML = '本机 ' + bjFull(c[0]) + '<br>开 ' + fmtPrice(c[1]) + ' 高 ' + fmtPrice(c[2]) +
      '<br>低 ' + fmtPrice(c[3]) + ' 收 ' + fmtPrice(c[4]) +
      '<br>量 ' + fmtNum(p.vol[i], 0) + (p.rsi[i] != null ? ' ｜ RSI ' + p.rsi[i].toFixed(1) : '') +
      (tdc ? '<br>九转 ' + (tdc.dir === 'buy' ? '买' : '卖') + ' ' + tdc.count : '');
    tip.style.display = 'block';
    tip.style.left = Math.min(cv.clientWidth - 180, x + 14) + 'px';
    tip.style.top = Math.max(4, y - 40) + 'px';
  }
  cv.addEventListener('mousemove', showKlineTip);
  cv.addEventListener('click', showKlineTip);
  cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  window.addEventListener('resize', () => { if (S.tab === 'manual') renderKline(); });
})();

/* ═════════════════════ 综合研判面板 ═════════════════════ */
async function loadVerdict(force) {
  if (S.verdictPending === S.sym) return;
  if (!force && Date.now() - (S.last.vd || 0) < 30000) return;
  S.last.vd = Date.now();
  const symbol = S.sym, requestId = (S.verdictRequestId || 0) + 1;
  S.verdictRequestId = requestId; S.verdictPending = symbol;
  const isCurrent = () => S.sym === symbol && S.verdictRequestId === requestId;
  if (!S.vd || S.vd.sym !== symbol) { S.vd = null; $('judgeBody').innerHTML = '<span class="loading">读取 ' + esc(symbol) + ' 最新研判…</span>'; $('judgeAge').textContent = '更新中'; }
  try {
    const v = await getJSON(API + '/verdict?symbol=' + encodeURIComponent(symbol));
    if (!isCurrent()) return;
    if (!v.ok) throw new Error(v.err || '研判失败');
    if (v.sym !== symbol || !Number.isFinite(v.ts) || Date.now() - v.ts > 120000 || v.ts - Date.now() > 10000) throw new Error('研判币种或采集时间无效');
    S.vd = v;
    const age = (Date.now() - v.ts) / 1000;
    $('judgeAge').textContent = v.sym + ' · ' + bjNow(v.ts) + ' 北京 · ' + ageStr(age);
    const k = v.vcls === 'bull' ? 'bull' : (v.vcls === 'bear' ? 'bear' : 'neut');
    const mfOrder = [['d1', '日线'], ['4h', '4小时'], ['1h', '1小时'], ['15m', '15分'], ['1m', '1分']];
    /* 布局 v2：结论压成条，依据收进折叠。
       旧版把 9 格指标 + 两张完整账单 + 风险清单全摊开 = 一张卡 750px，
       主人的 912px 视口被它一张吃光，K线图完全在屏幕外。 */
    const wasOpen = !!document.querySelector('.vdet[open]');
    let h = '<div class="vstrip">';
    h += '<div class="vbig ' + k + '"><div class="vv">' + esc(v.verdict) + '</div>' +
      '<div class="vs">综合 ' + v.total + ' 分</div></div>';
    h += '<div><div class="vact ' + cls(v.total) + '">' + esc(v.action) + '</div></div>';
    h += '<div class="vmf">' +
      mfOrder.map(([t, l]) => {
        const m = (v.mf || {})[t] || {};
        return '<div class="m"><div class="k">' + l + '</div><div class="d ' +
          (m.dir === '多' ? 'gain' : m.dir === '空' ? 'loss' : 'flat') + '">' +
          esc(m.dir || '--') + ' ' + (m.score || 0) + '</div></div>';
      }).join('') + '</div></div>';

    h += '<div class="vnums">' +
      '<span>现价<b>' + fmtPrice(v.price) + '</b></span>' +
      '<span>共振<b>' + esc(v.base.reso || '--') + '</b></span>' +
      '<span>1h箱体<b>' + (v.boxpos != null ? v.boxpos + '%' : '--') + '</b></span>' +
      '<span>ATR(1h)<b>' + fmtPrice(v.atr) + '</b></span>' +
      '<span>多单止损参考<b class="loss">' + fmtPrice(v.stop_long_ref) + '</b></span>' +
      '<span>空单止损参考<b class="loss">' + fmtPrice(v.stop_short_ref) + '</b></span>' +
      '<span>资金费率<b>' + (v.base.funding == null ? '--' : v.base.funding + '%') + '</b></span>' +
      '<span>24h<b class="' + cls(v.base.pct24) + '">' + pct(v.base.pct24) + '</b></span>' +
      '<span>布林位置<b>' + (v.base.pb == null ? '--' : Math.round(v.base.pb * 100) + '%') + '</b></span>' +
      '</div>';

    h += '<div class="vsr">' +
      '<div><div class="t">支撑</div>' +
      (v.support.length ? v.support.map(x => '<div class="r"><span class="gain mono">' + fmtPrice(x.price) + '</span></div>').join('') : '<span class="loading">无</span>') +
      '</div><div><div class="t">阻力</div>' +
      (v.resistance.length ? v.resistance.map(x => '<div class="r"><span class="loss mono">' + fmtPrice(x.price) + '</span></div>').join('') : '<span class="loading">无</span>') +
      '</div></div>';

    let d = '';
    if (v.breakdown && v.breakdown.length) {
      d += '<div class="bill"><div class="bt">技术面</div>' +
        v.breakdown.map(b => '<div class="billrow"><span class="n">' + esc(b.name) + '</span><span class="s ' + cls(b.score) + '">' + (b.score > 0 ? '+' : '') + b.score + '</span></div>').join('') + '</div>';
    }
    if (v.struct_evidence && v.struct_evidence.length) {
      d += '<div class="bill"><div class="bt">结构面</div>' +
        v.struct_evidence.map(e => '<div class="billrow"><span class="n">' + esc(e.src) + '</span><span class="s ' + cls(e.score) + '">' + (e.score > 0 ? '+' : '') + e.score + '</span><span class="w">' + esc(e.note) + '</span></div>').join('') +
        '<div class="billrow" style="border-top:1px solid var(--line);margin-top:5px;padding-top:5px;"><span class="n">结构原始分</span><span class="s ' + cls(v.struct_raw) + '">' + v.struct_raw + '</span><span class="w">乘以 1.5 封顶 ±100 → ' + v.struct_norm + '</span></div></div>';
    }
    d += '<div class="risklist">' + (v.risk || []).map((r, i) => '<div class="' + (i === (v.risk.length - 1) ? 'soft' : '') + '">' + esc(r) + '</div>').join('') + '</div>';
    h += '<details class="vdet"' + (wasOpen ? ' open' : '') + '><summary>依据</summary>' + d + '</details>';

    $('judgeBody').innerHTML = h;
  } catch (e) {
    if (!isCurrent()) return;
    S.vd = null; $('judgeAge').textContent = '更新失败';
    $('judgeBody').innerHTML = '<span class="bad">研判暂不可用：' + esc(e.message) + '</span>';
  } finally {
    if (S.verdictRequestId === requestId) S.verdictPending = null;
  }
}

/* ═════════════════════ 结构分析表（全周期）═════════════════════ */
async function loadTaAll(force) {
  if (S.taPending === S.sym) return;
  if (!force && Date.now() - (S.last.ta || 0) < 30000) return;
  S.last.ta = Date.now();
  const symbol = S.sym, requestId = (S.taRequestId || 0) + 1;
  S.taRequestId = requestId; S.taPending = symbol;
  const isCurrent = () => S.sym === symbol && S.taRequestId === requestId;
  if (!S.taAll || S.taAll.sym !== symbol) { S.taAll = null; $('taBody').innerHTML = '<span class="loading">读取 ' + esc(symbol) + ' 结构…</span>'; $('taAge').textContent = '更新中'; }
  let src = '在线读取';
  try {
    const d = await getJSON(API + '/ta_all?symbol=' + encodeURIComponent(symbol));
    if (!isCurrent()) return;
    if (!d.ok) throw new Error(d.err || 'no data');
    if (d.sym !== symbol) throw new Error('返回币种不符');
    d.read_at = Date.now();
    S.taAll = d;
  } catch (e) {
    if (!isCurrent()) return;
    /* 兜底：本机代理挂了就退回 refresh.ps1 经 VPS 产出的 ta.json（会旧 5~10 分钟，如实标注） */
    try {
      const t = await getJSON('ta.json?t=' + Date.now());
      if (!isCurrent()) return;
      const fr = (t.symbols || {})[symbol];
      if (!fr) throw new Error('缓存没有当前币种');
      if (!Number.isFinite(t.ts) || Date.now() - t.ts > 120000 || t.ts - Date.now() > 10000) throw new Error('缓存已过期');
      S.taAll = { ok: true, sym: symbol, frames: fr, read_at: t.ts, fallback: true };
      src = '缓存采集';
    } catch (e2) {
      if (!isCurrent()) return;
      S.taAll = null; $('taAge').textContent = '更新失败';
      $('taBody').innerHTML = '<span class="bad">结构数据取不到：实时接口 ' + esc(e.message) + '；兜底 ta.json 也失败 ' + esc(e2.message) + '</span>';
      return;
    }
  } finally {
    if (S.taRequestId === requestId) S.taPending = null;
  }
  if (!isCurrent()) return;
  const d = S.taAll;
  $('taAge').className = 'chip ' + (d.fallback ? 'warn' : 'on');
  $('taAge').textContent = d.sym + ' · ' + src + ' ' + bjNow(d.read_at) + ' 北京';
  const rows = TFS.map(([k, l]) => {
    const a = (d.frames || {})[k];
    if (!a) return '<tr><td class="tf">' + l + '</td><td colspan="6" style="color:var(--faint);">无数据</td></tr>';
    if (a.ok === false) return '<tr><td class="tf">' + l + '</td><td colspan="6" style="color:var(--red);">' + esc(a.reason || '取数失败') + '</td></tr>';
    const td = a.td || {}, wv = a.wave || {}, fb = a.fib || {};
    const tdB = td.dir ? '<span class="badge ' + (td.dir === 'buy' ? 'g' : 'r') + '">' + (td.dir === 'buy' ? '买' : '卖') + td.count + '</span>' : '<span class="badge n">-</span>';
    const wvB = wv.valid
      ? '<span class="badge ' + (wv.dir === 'up' ? 'g' : 'r') + '">成立 ' + (wv.dir === 'up' ? '↑' : '↓') + '</span>'
      : '<span class="badge n">未过</span>';
    const rtv = fb.ok ? Number(fb.retrace_now_pct) : null;
    const fibTxt = !fb.ok ? '<span style="color:var(--faint);">--</span>'
      : (rtv >= 0 && rtv <= 100
        ? '<span class="mono">' + (fb.leg.dir === 'up' ? '上升' : '下降') + '段 ' + rtv.toFixed(1) + '%</span>'
        : '<span class="badge y">超出区间 ' + rtv.toFixed(0) + '%</span>');
    const near = fb.ok ? fb.levels.slice(0, 5).map(x => fmtPrice(x.price)).join(' / ') : '--';
    return '<tr><td class="tf">' + l + '</td><td>' + tdB + '</td><td>' + wvB + '</td><td>' + fibTxt +
      '<div style="color:var(--faint);font-size:9.5px;margin-top:2px;">' + esc((wv.valid ? '' : (wv.reason || '')).slice(0, 54)) + '</div></td>' +
      '<td class="mono" style="font-size:10px;">' + near + '</td>' +
      '<td class="mono">' + (a.pivots_clean_n != null ? a.pivots_clean_n : (a.pivots || []).length) + '</td>' +
      '<td class="mono">' + fmtPrice(a.price) + '</td></tr>';
  }).join('');
  $('taBody').innerHTML =
    '<table class="tatable"><thead><tr><th>周期</th><th>神奇九转</th><th>五浪</th><th>斐波那契（现价位置）</th><th>回撤位 0.236~0.786</th><th>摆动点</th><th>现价</th></tr></thead><tbody>' +
    rows + '</tbody></table>' +
    '<div class="disc">九转 = DeMark Setup 原始 9 计数；五浪 = 最近 6 个摆动点按 Elliott 三条硬规则校验（未过就如实写违反了哪条，不硬套）；斐波 = 最近一段已确认摆动的回撤/扩展位。三者都只描述结构，不预测方向。</div>';
}

/* ═════════════════════ 机器人 · 影子盘 ═════════════════════ */
/* 原版做市机器人的卡片抽成函数：它的数字每 300ms 就变，
   所以由 mmTick() 单独重渲染这一张卡（见 renderShadow 之后），不整页刷。 */
function mmCardHtml(x) {
  const m = x.mm || {};
  const isHype = (x.mode === 7 || x.kind === 'hype_mm');
  const upMin = m.started ? Math.round((Date.now() - m.started) / 60000) : (m.minutes || null);
  const nCount = (isHype ? m.ticks : m.blocks) || 0;
  /* HYPE 这条是**原版循环的移植**：同样的"每 tick 撤单挂单"，但换到 Bybit。
     它多两个原版没有的数：免手续费口径、以及手续费是毛赚的几倍 —— 因为结论就在那里。 */
  const ratio = (isHype && m.gross_no_fee_usd)
    ? (x.fees / m.gross_no_fee_usd) : null;
  return '<div id="mmCard" class="horse"><div class="hh"><span class="n">' + esc(x.name) +
    '</span><span class="badge ' + ((x.ret_pct || 0) >= 0 ? 'g' : 'r') + '">' + pct(x.ret_pct) + '</span>' +
    '<span class="s">' + (isHype ? '原版做市循环 → Bybit ' : '原版 jev-trader · ') + esc(x.symbol) +
    ' @ ' + fmtPrice(x.price) +
    (m.dry_run ? ' · <span style="color:var(--yellow);">干跑</span>' : '') + '</span></div>' +
    row('决策频率', '每 ~300ms 一次（不等信号、不等买卖点）', 'flat') +
    row(isHype ? 'tick / 决策 / 挂单' : '区块 / 决策 / 挂单',
      nCount + ' / ' + (m.decisions || 0) + ' / ' + (m.quotes || 0), 'flat') +
    row('成交', (m.fills || 0) + ' 笔' + (m.decisions ? '（成交率 ' + fmtNum((m.fills || 0) / m.decisions * 100, 1) + '%）' : ''), 'flat') +
    row('超时阻塞 late', (m.late || 0) + '（' + (m.late_pct == null ? '--' : m.late_pct + '%') +
      '）—— 一次决策比一个 tick 还慢', (m.late_pct || 0) > 20 ? 'loss' : 'flat') +
    row('模型', esc(m.model || '--') + (upMin != null ? ' · 已跑 ' + upMin + ' 分钟' : ''), 'flat') +
    row('累计盈亏', fmtNum(x.pnl_u, 4) + ' U（本金 ' + fmtNum(x.invest_u, 0) + 'U）', cls(x.pnl_u)) +
    /* 别把两个费用混成一个：HYPE 腿的 x.fees 是**maker 手续费**（$1.54），
       Jev 模型费在 m.model_cost_usd（$0.115）。之前这里一律写"模型费"，是标错的。 */
    (isHype
      ? row('maker 手续费', fmtNum(x.fees, 5) + ' USD', 'flat') +
        row('Jev 模型费', fmtNum(m.model_cost_usd, 5) + ' USD', 'flat')
      : row('模型费', fmtNum(x.fees, 5) + ' USD', 'flat')) +
    (ratio != null ? row('毛赚 vs 手续费',
      fmtNum(m.gross_no_fee_usd, 4) + ' vs ' + fmtNum(x.fees, 4) + ' USD（手续费是毛赚的 ' +
      fmtNum(ratio, 2) + ' 倍）', ratio > 1 ? 'loss' : 'gain') : '') +
    (ratio != null ? row('已实现（含费）', fmtNum(m.realized_usd, 4) + ' USD', cls(m.realized_usd)) : '') +
    row('盘口价差', (m.spread_bps == null ? '--' : fmtNum(m.spread_bps, 2) + ' bps') +
      ' · 仓位 ' + esc(x.position || '空仓'), 'flat') +
    (m.size_usd ? row('每单 / 仓位上额', '$' + fmtNum(m.size_usd, 0) + ' / $' + fmtNum(m.max_pos_usd, 0) +
      ' · maker 费 ' + fmtNum(m.maker_fee_pct, 2) + '%/边', 'flat') : '') +
    (x.note ? '<div class="disc" style="font-size:9.5px;">' + esc(x.note) + '</div>' : '') +
    (isHype ? '<div class="disc" style="font-size:9.5px;color:var(--yellow);">' +
      '本模拟**忽略排队位置**：挂单价在 touch 上、队列里排着 200+ HYPE，实际成交率会远低于这里。</div>' : '') +
    (isHype ? '' : '<div class="disc" style="font-size:9.5px;color:var(--faint);">干跑里 gas 记 0 —— 它省掉了实盘最大的那项成本。</div>') +
    '</div>';
}

/* 快通道不单独起定时器 —— 这里已经有一个每 15 秒的 loadShadow（见文件末尾），
   它用 shadow.json（5 分钟一次的快照）重渲染整个页签，会把单独刷的卡片冲掉。
   所以直接在 loadShadow 里合并 mm_live.json，两条路走同一份数据，没有竞态。 */
async function _mergeMm(d) {
  try {
    const mm = await getJSON('mm_live.json?t=' + Date.now());
    if (!mm || !mm.name) return;
    const arr = (d.books || (d.books = []));
    const i = arr.findIndex(b => b.name === 'orig_jev_trader' || b.kind === 'origmm');
    if (i >= 0) arr[i] = Object.assign({}, arr[i], mm);
    else arr.push(mm);
  } catch (e) { /* 快通道挂了不影响主页面 */ }
}

/* ── 实盘条目（主人 2026-10-07 令：把在跑的实盘机器人放进赛马榜同榜对照）────────
   数据源与影子**完全不同**：实盘走 Bybit 交易所只读接口（closedPnl 已是扣费后净额
   ＋ 资金费），由 scripts\live_rank_sync.ps1 拉取后写 dashboard/live.json；
   影子走模拟账本。两者不可直接比较 —— 所以单独一组、单独标注来源。 */
let RANK_GROUP = 'all';
const RANK_GROUPS = [
  ['all', '全部'], ['live', '实盘'], ['shadow', '影子·结构正常'], ['doubt', '影子·存疑'],
];

async function _mergeLive(d) {
  try {
    const lv = await getJSON('live.json?t=' + Date.now());
    if (lv && lv.entries && lv.entries.length) d.live = lv;
  } catch (e) { /* 实盘读不到不拖累影子盘 */ }
}

/* 结构存疑判定（可复算，不靠人工点名）：
   net_pos(张) × 现价 = 当前名义敞口；投入本金 × 杠杆 = 应有名义。
   比值 > 2 ⇒ 持仓被跨品种/跨轮次带过来了，账本上的浮盈不是这一腿挣的。 */
function _doubtOf(b) {
  const px = Number(b.price), np = Math.abs(Number(b.net_pos) || 0);
  const cap = Number(b.invest_u) || 0, lev = Number(b.lev) || 0;
  if (!(px > 0) || !(np > 0) || !(cap > 0) || !(lev > 0)) return null;
  const notional = np * px, margin = cap * lev, ratio = notional / margin;
  if (!(ratio > 2)) return null;
  return { ratio: ratio, notional: notional, margin: margin,
           unreal: Number(b.unrealized) || 0, cum: Number(b.pnl_u) || 0 };
}

function rankDetHtml(x) {
  const q = x.doubt || {};
  const share = q.cum ? (q.unreal / q.cum * 100) : null;
  return '<div class="rdt"><b>统计存疑 · 依据（本席按 shadow.json + 模拟器源码复核，可复算）</b>' +
    '<div>· 当前名义敞口 <code>' + fmtNum(q.notional, 2) + 'U</code> ＝ 应有名义（本金 ' +
      fmtNum(x.obj.invest_u, 2) + 'U × ' + esc(String(x.obj.lev)) + 'x ＝ ' + fmtNum(q.margin, 2) +
      'U）的 <b>' + q.ratio.toFixed(1) + ' 倍</b> —— 越界。</div>' +
    '<div>· 累计盈亏 ' + fmtNum(q.cum, 2) + 'U 里 <code>' + fmtNum(q.unreal, 2) + 'U</code>' +
      (share == null ? '' : '（' + share.toFixed(1) + '%）') +
      ' 是这一个越界持仓的<b>浮盈（未实现）</b>，不是这一腿挣出来的。</div>' +
    '<div>· 网格模拟器 <code>ledger/shadow_grid.py</code> 只有 taker 0.055% 手续费与资金费，' +
      '<b>没有滑点项</b>（源码里无滑点常量）；而账本 note 却声明「含滑点 0.02%」⇒ 口径声明与实现不符。</div>' +
    '<div>· 价格跑出区间时只做 <code>range_resets += 1</code> 重锚区间，<b>不清仓、无保证金/强平检查、无仓位上限</b>' +
      ' ⇒ 旧品种的持仓被一路带到新品种（一条账本串过多个品种）。</div>' +
    '<div>· 系统自己的闸门已否决：<b>PnL_VALIDATED = false</b>，晋级器原文「名次不能当晋级依据」。</div>' +
    '<div>· 独立审计（2026-10-07）结论：<b>真实成分 ≈ 0</b>。本条目<b>保留、不删</b>，只置灰并标注，不参与可比性判断。</div>' +
    '</div>';
}

async function loadShadow(force) {
  if (!force && Date.now() - (S.last.sh || 0) < 30000) return;
  S.last.sh = Date.now();
  try {
    const d = await getJSON('shadow.json?t=' + Date.now());
    await _mergeMm(d);   // 原版做市腿的数字换用快通道 mm_live.json（shadow.json 是 5 分钟一次的快照）
    await _mergeLive(d); // 实盘条目（交易所口径），读不到就只显示影子
    S.shadow = d;
    renderShadow(d);
  } catch (e) {
    $('rankBody').innerHTML = '<span class="bad">shadow.json 读不到：' + esc(e.message) + '（它由 refresh.ps1 循环里的 shadow_sync.py 产出）</span>';
  }
}

function renderShadow(d) {
  const age = (Date.now() / 1000) - (d.synced_at || 0);
  $('rankAge').className = 'chip ' + (d.ok && age < 1200 ? 'on' : 'warn');
  $('rankAge').textContent = (d.ok ? '' : '同步失败 · ') + bjFull((d.synced_at || 0) * 1000) + '（' + ageStr(age) + '）';
  /* 实盘数据源与截止时间单独一个角标 —— 实盘与影子是两份不同的数据，时间戳不能混用一个 */
  const la = $('liveAge');
  if (la) {
    if (d.live) {
      la.className = 'chip on';
      la.textContent = '实盘 ' + (d.live.cutoff_bj || '?') + ' · 交易所 closedPnl';
    } else {
      la.className = 'chip warn';
      la.textContent = '实盘：live.json 未同步';
    }
  }
  $('horseAge').innerHTML = '<span class="chip gray">数据源：VPS 影子盘 runner</span>';

  /* 闸门横幅 —— 这是全页最重要的一句话，不许被美化掉 */
  const g = $('gateBanner');
  if (d.pnl_validated) {
    g.className = 'gate ok';
    g.innerHTML = '<div class="gt">✓ PnL 验证闸门：已开</div><div class="gs">影子盘绩效可信，赛马名次可以作为晋级依据。</div>';
  } else {
    g.className = 'gate';
    g.innerHTML = '<div class="gt">⚠ PnL 验证闸门：未开（PnL_VALIDATED = false）</div>' +
      '<div class="gs">所以下面<b>没有任何机器人被真正晋升</b> —— 榜上的名次只是"如果闸门开了排第几"，不是晋级决定。<br>' +
      '闸门未开的原因是影子盘计价口径还没被独立验证过（2026-09-12 修过一次穿越次数平方缺陷，修复前的绩效已作废重算）。' +
      '在这个闸门打开之前，影子盘的成绩不能拿去加仓、也不能上新实盘。</div>';
  }

  /* 赛马榜：网格 book 与方向型 horse 合成一张榜 */
  const list = [];
  for (const b of (d.books || [])) {
    /* 信号腿/ Jev 腿跟网格腿不是一回事：类型、备注、"笔数"的含义都不同。
       原来这里 kind 写死 '网格'、备注用 cells（信号腿没这字段 → 显示 "?格"），
       会让人以为它是个坏掉的网格。 */
    const isSig = (b.mode === 4 || b.mode === 5 || b.kind === 'signal' || b.kind === 'jev');
    const isJev = (b.mode === 5 || b.kind === 'jev');
    const isMM = (b.mode === 6 || b.mode === 7 || b.kind === 'origmm' || b.kind === 'hype_mm');
    let sub;
    if (isMM) {
      const m = b.mm || {};
      const n = (m.blocks != null ? m.blocks : m.ticks) || 0;
      sub = (m.blocks != null ? '每 ~300ms 一次决策' : '每 ~300ms 一次决策（原版循环移植）') +
        ' · 已跑 ' + n + (m.blocks != null ? ' 块' : ' tick') + ' · 阻塞 ' +
        (m.late_pct == null ? '--' : m.late_pct + '%') + ' · ' +
        (m.dry_run ? '干跑' : '实盘') + ' · ' + esc(m.model || '');
    } else if (isSig) {
      sub = (b.tf || '?') + '分 · ' + (b.lev || '?') + 'x · ' + esc(b.position || '空仓') +
        (b.verify_blocked ? ' · 已停开仓' : '');
      /* 主人问"为什么是 0" —— 把原因写在榜上，别让人去翻日志。 */
      if (isJev && b.jev_stats && b.jev_stats._summary) {
        const s = b.jev_stats._summary;
        sub += ' · Jev 判过 ' + (s.total_decisions || 0) + ' 次';
        if (s.avg_conviction != null && s.total_decisions) {
          sub += '（平均信心 ' + s.avg_conviction + '/5）';
        }
      } else if (b.trades) {
        sub += ' · ' + b.trades + ' 笔';
      }
    } else {
      sub = (b.cells || '?') + '格 · ' + (b.lev || '?') + 'x' +
        (b.hit_sl ? ' · 已触止损线' : '') + (b.rebaselined_at ? ' · 已重算' : '');
    }
    const dq = _doubtOf(b);
    list.push({
      name: b.name, symbol: b.symbol,
      kind: isMM ? '原版做市' : (isJev ? '信号+Jev仓位' : (isSig ? '信号' : '网格')),
      ret: b.ret_pct, pnl: b.pnl_u, sub: sub, obj: b, doubt: dq,
      group: dq ? 'doubt' : 'shadow',
      /* 一笔没做过的腿不该被说成"亏损" —— 0.00% 不是亏损，是还没开张。 */
      noTrades: isSig && !(b.trades > 0),
    });
  }
  for (const h of (d.horses || [])) {
    if (!h || !h.horse) continue;
    list.push({
      name: h.horse, symbol: (h.pos && h.pos[0] && h.pos[0].sym) || '—', kind: '方向',
      ret: h.ret_pct, pnl: h.cum_pnl, group: 'shadow', doubt: null,
      sub: h.trades + ' 笔 · 胜率 ' + (h.winrate == null ? '--' : h.winrate + '%'),
      obj: h,
    });
  }

  /* 实盘条目（真金）—— 与影子**同榜对照**，但单独一组、单独标注数据来源。
     实盘走 Bybit 交易所只读接口（closedPnl 已是扣费后净额 + 资金费）；
     影子走模拟账本。两者不是一回事，绝不许被看成同一种东西。 */
  for (const L of ((d.live && d.live.entries) || [])) {
    list.push({
      name: L.name, symbol: L.symbol, kind: '实盘', ret: L.ret_pct, pnl: L.pnl_u,
      group: 'live', doubt: null, isLive: true, obj: L,
      sub: (L.lev || '?') + 'x · 起点本金 ' + fmtNum(L.invest_u, 2) + 'U · 未实现 ' +
        fmtNum(L.unrealized_now, 2) + 'U',
    });
  }
  list.sort((a, b) => (b.ret == null ? -1e9 : b.ret) - (a.ret == null ? -1e9 : a.ret));

  /* 组别筛选（主人 2026-10-07 令）：实盘 / 影子·结构正常 / 影子·存疑 三组分开看。
     为什么要分组：影子那边有一条 +100398% 是**结构缺陷**（越界持仓的浮盈），
     跟实盘的 +15.92%（真金）放在同一根轴上比，会让人误判 —— 所以既能筛，
     存疑的条目又**置灰并保留可展开依据**，不删除别人的条目。 */
  const CNT = { all: 0, live: 0, shadow: 0, doubt: 0 };
  for (const x of list) { CNT.all++; CNT[x.group] = (CNT[x.group] || 0) + 1; }
  const SHOWN = list.filter(x => RANK_GROUP === 'all' || x.group === RANK_GROUP);

  let h = '<div class="rankfilter">';
  for (const g of RANK_GROUPS) {
    h += '<button class="mbtn' + (RANK_GROUP === g[0] ? ' on' : '') + '" data-rg="' + g[0] + '">' +
      esc(g[1]) + ' <b>' + (CNT[g[0]] || 0) + '</b></button>';
  }
  if (RANK_GROUP === 'live') {
    h += '<span class="rfnote">实盘＝Bybit 交易所真值（closedPnl 已扣手续费 ＋ 资金费，真金）；' +
      '影子＝模拟账本，两者不可直接比较。</span>';
  } else if (RANK_GROUP === 'doubt') {
    h += '<span class="rfnote">这些腿的名义敞口越界，账本上的浮盈不是它自己挣的 —— 名次不可比，仅留档。</span>';
  } else {
    h += '<span class="rfnote">实盘与影子同榜但不同源：绿框＝真金（交易所），其余＝模拟账本；红色置灰行＝统计存疑。</span>';
  }
  h += '</div>';

  h += '<div class="rankrow head"><span>名次</span><span>名字</span><span class="num">收益</span><span class="num">累计U</span><span class="num">笔数</span><span class="num">类型</span><span class="tag">状态 / 数据来源</span></div>';
  if (!SHOWN.length) {
    h += '<span class="loading">' + (list.length ? '该筛选下没有条目' : '影子盘暂无在跑的马') + '</span>';
  } else {
    SHOWN.forEach((x, i) => {
      const rk = i + 1;
      /* 名次只是名次: 亏钱的马排进前三, 也不构成晋级理由 —— 所以"晋升候选"必须同时满足"前三 + 正收益" */
      const losing = x.ret != null && x.ret <= -20;
      const inTop3 = rk <= 3 && SHOWN.length >= 3;
      const profitable = x.ret != null && x.ret > 0;
      let kls = '';
      let tag;
      if (x.isLive) {
        /* 实盘不是"晋升候选"—— 它已经在真金上跑，不参与影子晋级。 */
        kls = ' live';
        tag = '<span class="badge g">交易所 closedPnl · 真金</span> ' +
          '<span class="badge g">💰 实盘（非模拟）</span>';
        if (losing) tag += ' <span class="badge r">⚠️ 触 -20% 降级线</span>';
      } else {
        if (inTop3 && profitable) kls = rk === 1 ? 'p1' : 'p2';
        if (losing || (rk === SHOWN.length && SHOWN.length > 3)) kls += ' down';
        if (x.doubt) kls += ' doubt';
        if (x.noTrades) tag = '<span class="badge n">模拟</span> <span class="badge n">未开张（还没成交过，0% 不是亏损）</span>';
        else if (x.doubt) {
          tag = '<span class="badge r">模拟</span> <span class="badge r" data-rd="' + i + '" ' +
            'style="cursor:pointer;">⚠️ 统计存疑 · 点开看依据</span>';
        } else if (inTop3 && profitable) tag = '<span class="badge n">模拟</span> <span class="badge y">🏆 前三（晋升候选）</span>';
        else if (inTop3) tag = '<span class="badge n">模拟</span> <span class="badge n">前三但亏损 → 不构成晋级理由</span>';
        else tag = '<span class="badge n">模拟</span> <span class="badge n">观察</span>';
        if (!x.noTrades && !x.doubt && losing) tag += ' <span class="badge r">⚠️ 触 -20% 降级线</span>';
        else if (!x.noTrades && !x.doubt && rk === SHOWN.length && SHOWN.length > 3) tag += ' <span class="badge r">⚠️ 垫底</span>';
      }
      h += '<div class="rankrow ' + kls + '"><span class="rk">' + rk + '</span>' +
        '<span class="nm">' + esc(x.name) + '<small>' + esc(x.symbol) + ' · ' + esc(x.sub) + '</small></span>' +
        '<span class="num ' + cls(x.ret) + '">' + (x.doubt ? '⚠ ' : '') + pct(x.ret) + '</span>' +
        '<span class="num ' + cls(x.pnl) + '">' +
          (x.isLive ? (Number(x.pnl) >= 0 ? '+' : '') + Number(x.pnl).toFixed(2) : fmtNum(x.pnl, 2)) + '</span>' +
        '<span class="num">' + (x.obj.trades != null ? x.obj.trades : (x.obj.arbitrage_num != null ? x.obj.arbitrage_num : '--')) + '</span>' +
        '<span class="num" style="color:var(--dim);font-size:10px;">' + esc(x.kind) + '</span>' +
        '<span class="tag">' + tag + '</span></div>';
      if (x.doubt) h += '<div class="rankdet hidden" id="rd' + i + '">' + rankDetHtml(x) + '</div>';
    });
  }
  const rep = d.report_ts ? bjFull(d.report_ts * 1000) : '--';  h += '<div class="disc">口径：收益 = 累计盈亏 ÷ 该腿本金（网格/方向马 10U，信号腿与 Jev 腿 5U，原版做市 100U）· VPS runner 报告时间 ' + rep + '（本机时区＝墨尔本）· 网格类"笔数"列是套利次数，其余是真交易笔数。' +
    '<b>三种腿不是一回事</b>：网格腿逐格吃价差；信号腿等驾驶舱的买卖点（约 3 小时一个）；<b>原版做市腿不等任何信号</b>，每 ~300ms 撤旧单挂新单。' +
    '网格的 grid_profit 是逐格累计、无成交血缘，不可信；只有 pnl_u 可信。</div>';

  /* 实盘条目的口径与数据截止时间 —— 必须写在页面上，不许让主人以为实盘是模拟 */
  if (d.live && d.live.entries) {
    const lv = d.live;
    const le = lv.entries.map(e => '<b>' + esc(e.name) + '</b>：标的 ' + esc(e.symbol) +
      ' · 起点本金 ' + fmtNum(e.invest_u, 2) + 'U（' + esc(e.started_bj || '?') + ' 北京）· 已实现净额 ' +
      fmtNum(e.pnl_u, 2) + 'U ＝ 交易所 closedPnl ' + fmtNum(e.closed_pnl_u, 2) + 'U ＋ 资金费 ' +
      fmtNum(e.funding_u, 4) + 'U · 收益 ' + pct(e.ret_pct) + ' · ' + e.trades + ' 笔 · 未实现 ' +
      fmtNum(e.unrealized_now, 2) + 'U（另列，不计入收益）').join('；');
    h += '<div class="disc livesrc"><b>实盘口径（真金 · 与影子不同源）</b>：' + le +
      '。<br>数据来源：Bybit <code>/v5/position/closed-pnl</code>（交易所口径，<b>已扣手续费</b>）＋ ' +
      '<code>/v5/account/transaction-log</code> 资金费；只读拉取，未改任何实盘状态。' +
      '起始本金＝「现在权益 − 期间已实现 − 现在未实现 − 划转」反推的该时点账户权益（同一 UNIFIED 账户，两个实例共用）。' +
      '数据截止 <b>' + esc(lv.cutoff_bj || '?') + '（北京时间）</b>。<br>' +
      '<b>影子口径</b>：本机/VPS 模拟账本，零真实资金、零真实下单 —— 两者不可直接比较。</div>';
  }

  /* 可比性缺陷（2026-10-07 独立审计 + 本席源码复核）—— 写清楚，不藏 */
  h += '<div class="disc rankcaveat"><b>⚠️ 榜的可比性缺陷（务必先读）</b>' +
    '<div>· 影子盘自己的闸门 <b>PnL_VALIDATED = false</b>：晋级器原文「名次不能当晋级依据」。所以<b>影子名次都不算数</b>，只是排队看。</div>' +
    '<div>· 红色置灰行＝<b>名义敞口越界</b>（持仓被跨品种带过来），收益里绝大部分是那个越界头寸的浮盈，不是它自己挣的 —— 已标「统计存疑」，可点开看依据；<b>保留未删</b>。</div>' +
    '<div>· 网格腿的账本 note 声明「含滑点 0.02%」，但模拟器 <code>ledger/shadow_grid.py</code> 只算了 taker 0.055% 与资金费，<b>没有滑点项</b> ⇒ 该声明对网格腿不成立。</div>' +
    '<div>· 结论：<b>实盘行（绿框）才是有真金证据的</b>；影子行只能当假设，不能当业绩。</div></div>';

  $('rankBody').innerHTML = h;

  /* 组别筛选 + 存疑依据展开（不删条目，只换视角） */
  for (const btn of $('rankBody').querySelectorAll('[data-rg]')) {
    btn.onclick = () => { RANK_GROUP = btn.getAttribute('data-rg'); renderShadow(S.shadow); };
  }
  for (const btn of $('rankBody').querySelectorAll('[data-rd]')) {
    btn.onclick = () => {
      const el = document.getElementById('rd' + btn.getAttribute('data-rd'));
      if (el) el.classList.toggle('hidden');
    };
  }

  /* 每匹马的实时数据 */
  let b = '<div class="horsegrid">';
  for (const x of (d.books || [])) {
    /* 原版做市机器人（mode 6）：跟网格腿、信号腿都不是一回事 ——
       它不等信号、没有买卖点，每 ~300ms 撤旧单挂新单。所以单独一张卡。 */
    if (x.mode === 6 || x.mode === 7 || x.kind === 'origmm' || x.kind === 'hype_mm') {
      b += mmCardHtml(x);
      continue;
    }
    /* 信号腿（mode 4）：结构跟网格腿完全不是一回事 —— 它没有区间/格数/网格利润，
       但有权益、存款、阶梯、仓位、爆仓次数。硬塞进网格卡会显示一堆 "--" 和 "undefined格"，
       所以单独一张卡。字段来自 shadow_sync.py 的 mode-4 白名单。 */
    if (x.mode === 4 || x.mode === 5 || x.kind === 'signal' || x.kind === 'jev') {
      const isJev = (x.kind === 'jev' || x.mode === 5);
      const stale = (x.age_sec != null && x.age_sec > 300);
      b += '<div class="horse"><div class="hh"><span class="n">' + esc(x.name) +
        '</span><span class="badge ' + ((x.ret_pct || 0) >= 0 ? 'g' : 'r') + '">' + pct(x.ret_pct) + '</span>' +
        '<span class="s">' + (isJev ? '⚖ Jev 闸门 · ' : '') + esc(x.symbol) + ' ' + esc(x.tf || '') +
        '分 @ ' + fmtPrice(x.price) +
        (stale ? ' <span class="loss">· 报告 ' + x.age_sec + 's 未更新</span>' : '') + '</span></div>' +
        row('权益 / 存款', fmtNum(x.equity, 4) + ' / ' + fmtNum(x.bank, 4) + ' U', 'flat') +
        row('阶梯进度', '第 ' + (x.rung != null ? x.rung : '--') + ' 档 → 目标 ' +
          fmtNum(x.rung_top, 0) + 'U（满则存一半）· 第 ' + (x.cycle || 1) + ' 轮', 'flat') +
        row('当前仓位', esc(x.position || '--') + (x.pos_avg ? ' @ ' + fmtPrice(x.pos_avg) : '') +
          ' · ' + x.lev + 'x', x.position && x.position !== '空仓' ? 'flat' : 'flat') +
        row('累计盈亏', fmtNum(x.pnl_u, 4) + ' U（本金 ' + fmtNum(x.invest_u, 2) + 'U）', cls(x.pnl_u)) +
        row('成交 / 胜 / 负', (x.trades || 0) + ' / ' + (x.wins || 0) + ' / ' + (x.losses || 0), 'flat') +
        row('止盈 / 信号平 / 爆仓', (x.tp_hits || 0) + ' / ' + (x.signal_exits || 0) + ' / ' +
          (x.liquidations || 0), (x.liquidations ? 'loss' : 'flat')) +
        row('手续费', fmtNum(x.fees, 4), 'flat') +
        row('爆仓距离', (x.liq_distance_pct == null ? '--' : x.liq_distance_pct + '%'), 'flat') +
        /* 信号来源校验：主人 2026-09-20 要求"根据驾驶舱实时给出来的买卖点交易"。
           驾驶舱是权威；不一致就必须一眼看见，不能藏在日志里。 */
        (function () {
          const vs = x.verify_state;
          const badge = { verified: ['g', '✓ 与驾驶舱逐条一致'],
                          drift: ['r', '✗ 与驾驶舱不一致 —— 已停止开新仓'],
                          unverified: ['', '? 还没能核对'],
                          none: ['', '? 无信号腿'] }[vs] || ['', '? 未上报'];
          const age = (x.verify_age_h == null ? '' : '（' + fmtNum(x.verify_age_h, 1) + ' 小时前）');
          return row('信号来源', '<span class="badge ' + badge[0] + '">' + badge[1] + '</span>' + age,
                     vs === 'drift' ? 'loss' : 'flat') +
            (x.verify_detail ? '<div class="disc" style="font-size:9.5px;">' +
              esc(x.verify_detail) + '</div>' : '');
        })() +
        (x.last_close ? row('最近平仓', esc(x.last_close.why) + ' ' + fmtNum(x.last_close.pnl, 4) + 'U (' +
          fmtNum((x.last_close.ret || 0) * 100, 1) + '%)', cls(x.last_close.pnl)) : '') +
        (isJev && x.jev_stats ? (function () {
          const js = x.jev_stats, s = js._summary || {};
          let h2 = row('Jev 判断', (s.total_decisions || 0) + ' 次 · 已验 ' + (s.resolved || 0) +
            ' 次 · 退回标准仓 ' + (s.fallbacks || 0) + ' 次 · 平均信心 ' +
            (s.avg_conviction == null ? '--' : s.avg_conviction + '/5'), 'flat');
          for (const k of ['低(0-1分)', '中(2-3分)', '高(4-5分)']) {
            const v = js[k];
            if (v) h2 += row('信心' + k, v.n + ' 次 · 60根后平均 ' + fmtNum(v.avg_move_pct, 3) +
              '% · 胜率 ' + fmtNum(v.win, 0) + '%', cls(v.avg_move_pct));
          }
          if (s.high_avg != null && s.low_avg != null) {
            h2 += row('高信心 vs 低信心',
              fmtNum(s.high_avg, 3) + '% vs ' + fmtNum(s.low_avg, 3) + '%' +
              (s.high_avg > s.low_avg ? '（信心有用）' : '（信心没用）'),
              s.high_avg > s.low_avg ? 'gain' : 'loss');
          }
          return h2;
        })() : '') +
        /* 决策明细：让主人直接看到它每次判了什么、信心多少、事后对不对 */
        (isJev && (x.decisions_recent || []).length ? (function () {
          let h3 = '<div class="hist"><div class="h" style="color:var(--faint);">' +
            '<span>时间</span><span>信号</span><span>信心→仓位</span><span>事后60根</span></div>';
          for (const d of x.decisions_recent) {
            const t = new Date(d.ts * 1000);
            const hh = String((t.getUTCHours() + 8) % 24).padStart(2, '0') + ':' +
                       String(t.getUTCMinutes()).padStart(2, '0');
            h3 += '<div class="h"><span>' + hh + '</span>' +
              '<span>' + (d.side === 'buy' ? '▲买' : '▼卖') + ' ' + d.score + '条</span>' +
              '<span>' + (d.conviction == null ? '--' : d.conviction + '/5') + ' → ' +
              fmtNum((d.frac || 0) * 100, 0) + '%</span>' +
              '<span class="' + cls(d.out) + '">' +
              (d.out == null ? '待验证' : fmtNum(d.out, 3) + '%') + '</span></div>';
          }
          return h3 + '</div>';
        })() : (isJev ? '<div class="disc" style="font-size:9.5px;">还没有 Jev 判断记录（等下一个信号）</div>' : '')) +
        (x.note ? '<div class="disc" style="font-size:9.5px;">' + esc(x.note) + '</div>' : '') +
        (x.close_reason ? '<div class="disc" style="font-size:9.5px;color:var(--yellow);">' +
          esc(x.close_reason) + '</div>' : '') +
        '</div>';
      continue;
    }
    /* 网格卡：若这条腿名义敞口越界，卡片上也挂同一枚「统计存疑」—— 榜和卡不能互相打脸 */
    const dq2 = _doubtOf(x);
    b += '<div class="horse' + (dq2 ? ' doubtcard' : '') + '"><div class="hh"><span class="n">' + esc(x.name) + '</span>' +
      '<span class="badge ' + (x.ret >= 0 ? 'g' : 'r') + '">' + pct(x.ret) + '</span>' +
      '<span class="s">' + esc(x.symbol) + ' @ ' + fmtPrice(x.price) + '</span></div>' +
      (dq2 ? '<div class="doubtnote">⚠️ <b>统计存疑</b>：当前名义敞口 ' + fmtNum(dq2.notional, 2) +
        'U ＝ 应有名义 ' + fmtNum(dq2.margin, 2) + 'U 的 <b>' + dq2.ratio.toFixed(1) + ' 倍</b>（越界）；' +
        '累计盈亏里 ' + fmtNum(dq2.unreal, 2) + 'U 是这一个越界持仓的<b>浮盈（未实现）</b>，不是它自己挣的。' +
        '名次不可比，仅留档 —— 依据见赛马榜该行的「点开看依据」。</div>' : '') +
      row('累计盈亏', fmtNum(x.pnl_u, 3) + ' U', cls(x.pnl_u)) +
      row('网格累计(不可信)', fmtNum(x.grid_profit, 2), 'flat') +
      row('手续费 / 资金费', fmtNum(x.fees, 2) + ' / ' + fmtNum(x.funding, 2), 'flat') +
      row('未实现', fmtNum(x.unrealized, 3), cls(x.unrealized)) +
      row('持仓量 / 均价', fmtNum(x.net_pos, 2) + ' / ' + fmtPrice(x.pos_avg), 'flat') +
      row('套利次数', fmtNum(x.arbitrage_num, 0), 'flat') +
      row('区间 / 格数 / 杠杆', fmtPrice((x.range || [])[0]) + '~' + fmtPrice((x.range || [])[1]) + ' · ' + x.cells + '格 · ' + x.lev + 'x', 'flat') +
      row('爆仓距离', (x.liq_distance_pct == null ? '--' : x.liq_distance_pct + '%'), 'flat') +
      row('止盈 / 止损', (x.hit_tp ? '已触止盈' : '未触') + ' / ' + (x.hit_sl ? '已触止损线' : '未触'), x.hit_sl ? 'loss' : 'flat') +
      row('区间重置次数', (x.range_resets == null ? '--' : x.range_resets), 'flat') +
      (x.rebaseline_reason ? '<div class="disc" style="font-size:9.5px;">' + esc(x.rebaseline_reason) + '</div>' : '') +
      '</div>';
  }
  for (const hh of (d.horses || [])) {
    if (!hh || !hh.horse) continue;
    b += '<div class="horse"><div class="hh"><span class="n">' + esc(hh.horse) + '</span>' +
      '<span class="badge ' + (hh.ret_pct >= 0 ? 'g' : 'r') + '">' + pct(hh.ret_pct) + '</span>' +
      '<span class="s">方向型 · 本金 ' + hh.capital + 'U</span></div>' +
      row('权益', fmtNum(hh.equity, 5) + ' U', cls(hh.ret_pct)) +
      row('累计盈亏', fmtNum(hh.cum_pnl, 5) + ' U', cls(hh.cum_pnl)) +
      row('交易 / 胜率', hh.trades + ' 笔 · ' + (hh.winrate == null ? '--' : hh.winrate + '%'), 'flat') +
      row('今日', fmtNum(hh.day_pnl, 5) + ' U（' + (hh.day_trades || 0) + ' 笔）· ' + esc(hh.day || ''), cls(hh.day_pnl)) +
      row('持仓', (hh.pos && hh.pos.length) ? hh.pos.map(p => esc(p.sym || '') + ' ' + esc(p.side || '')).join(', ') : '空仓', 'flat') +
      row('最近平仓', esc(hh.last_trade_at || '--'), 'flat') +
      (hh.history && hh.history.length
        ? '<div class="hist"><div class="h" style="color:var(--faint);"><span>标的</span><span>原因</span><span>盈亏U</span><span>持有</span></div>' +
          hh.history.slice(-6).reverse().map(t => '<div class="h"><span>' + esc(t.sym) + '</span><span>' + esc(t.reason || '') + '</span><span class="' + cls(t.pnl) + '">' + fmtNum(t.pnl, 4) + '</span><span>' + (t.hold_h == null ? '--' : t.hold_h + 'h') + '</span></div>').join('') + '</div>'
        : '<div class="empty">还没有平仓记录</div>') +
      '</div>';
  }
  b += '</div>';
  if (!(d.books || []).length && !(d.horses || []).length) b = '<span class="loading">影子盘暂无数据</span>';
  $('horseBody').innerHTML = b;

  /* 晋级登记册 */
  const cands = d.candidates || [];
  $('candBody').innerHTML = cands.length
    ? '<table class="tatable"><thead><tr><th>候选</th><th>策略</th><th>版本</th><th>状态</th><th>范围</th><th>最近变更</th></tr></thead><tbody>' +
      cands.map(c => {
        const sc = c.state === 'SHADOW' ? 'y' : (c.state === 'LIVE' || c.state === 'UPGRADE' ? 'g' : (c.state === 'QUARANTINED' || c.state === 'REJECTED' ? 'r' : 'n'));
        return '<tr><td class="mono" style="font-size:10px;">' + esc(c.candidate_id) + '</td><td>' + esc(c.strategy_id || '') + '</td>' +
          '<td class="mono">' + esc(c.version || '') + '</td><td><span class="badge ' + sc + '">' + esc(c.state || '') + '</span></td>' +
          '<td style="font-size:10.5px;color:var(--dim);">' + esc(c.change_scope || '') + '</td>' +
          '<td style="font-size:10px;color:var(--faint);">' + (c.notes || []).map(esc).join('<br>') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="disc">这是 VPS 上的晋级状态机（ledger/research/candidates.json）。SHADOW = 在影子/试运行，不等于已晋级。</div>'
    : '<span class="loading">没有登记候选</span>';

  /* 历史存档 */
  const lg = d.legacy || [];
  const old = lg.slice().sort((a, b2) => (b2.mtime || 0) - (a.mtime || 0));
  $('legacyBody').innerHTML =
    '<div style="font-size:11.5px;color:var(--dim);line-height:1.85;">' +
    '本机旧台账里有 <b>' + lg.length + '</b> 匹早期马，最后一次更新是 <b>' + (old[0] ? bjFull(old[0].mtime * 1000) : '--') + '</b>，' +
    '它们的 runner 早已不在，数据不再变化 —— 列在这里是为了"不假装它们不存在"，不是还在跑。' +
    '<br>另外 2026-09-20 已把一批<b>确定死掉</b>的机器人移到 <code>_retired-20260920/</code>（VPS 19 个文件 / 本机 14 个）：' +
    'bot_trend、box_grid_bot、skr_clone、niulai_watch、scalp_shadow、bot_range。判定标准是"无进程 + 状态停更 ≥4 天 + 无产线引用"三条同时成立；' +
    '<b>没有一个是按业绩删的</b> —— PnL 闸门没开，谁都没资格判它们死刑。</div>' +
    '<table class="tatable" style="margin-top:11px;"><thead><tr><th>老马</th><th>本金</th><th>权益</th><th>累计盈亏</th><th>笔数</th><th>最后更新</th></tr></thead><tbody>' +
    old.map(x => '<tr><td>' + esc(x.horse) + '</td><td class="mono">' + fmtNum(x.capital, 1) + '</td><td class="mono">' + fmtNum(x.equity, 4) + '</td>' +
      '<td class="mono ' + cls(x.cum_pnl) + '">' + fmtNum(x.cum_pnl, 4) + '</td><td class="mono">' + (x.trades == null ? '--' : x.trades) + '</td>' +
      '<td class="mono" style="font-size:10px;color:var(--faint);">' + bjFull((x.mtime || 0) * 1000) + '</td></tr>').join('') +
    '</tbody></table>';
  $('legacyBody').style.display = S.legacyOpen ? 'block' : 'none';
  $('legacyToggle').textContent = S.legacyOpen ? '收起' : '展开';
}
function row(k, v, c) {
  return '<div class="row"><span class="k">' + k + '</span><span class="v ' + (c || '') + '">' + v + '</span></div>';
}
$('legacyToggle').addEventListener('click', () => {
  S.legacyOpen = !S.legacyOpen;
  $('legacyBody').style.display = S.legacyOpen ? 'block' : 'none';
  $('legacyToggle').textContent = S.legacyOpen ? '收起' : '展开';
});

/* ═════════════════════ 策略工坊 ═════════════════════ */
async function loadShop(force) {
  if (!force && Date.now() - (S.last.shop || 0) < 30000) return;
  S.last.shop = Date.now();
  try {
    const d = await getJSON(API + '/strategy/list');
    $('shopAge').textContent = bjNow() + ' 刷新';
    const items = d.items || [];
    const stc = { '待处理': 'y', '已收到': 'y', '开发中': 'n', '已上影子盘': 'g', '已否决': 'r' };
    /* 页签上直接挂待处理数 —— 否则提交完就沉底了, 没人会想起来看 */
    const pend = items.filter(it => ['待处理', '已收到', '开发中'].indexOf(it.status) >= 0).length;
    const ts = document.querySelector('.tab[data-tab="shop"] .ts');
    if (ts) {
      ts.textContent = pend > 0 ? ('⚠ ' + pend + ' 条待处理') : '写策略 → 生成机器人';
      ts.style.color = pend > 0 ? 'var(--yellow)' : '';
    }
    $('shopBody').innerHTML = items.length
      ? items.map(it => '<div class="shoprow" onclick="openStrategy(\'' + esc(it.id) + '\')">' +
          '<span class="id">' + esc(it.created_at || '') + '<br>' + esc(it.id) + '</span>' +
          '<span class="nm">' + esc(it.name) + '<small>' + esc((it.note || '') || '点击看全文') + '</small></span>' +
          '<span class="mono" style="color:var(--dim);font-size:10.5px;">' + esc(it.symbol || '—') + '<br>' + esc(it.tf || '') + '</span>' +
          '<span class="st"><span class="badge ' + (stc[it.status] || 'n') + '">' + esc(it.status) + '</span></span></div>').join('')
      : '<span class="loading">还没有提交过策略。在上面写完点「提交给总管 →」。</span>';
  } catch (e) {
    $('shopBody').innerHTML = '<span class="bad">读不到策略列表：' + esc(e.message) + ' —— 确认信号服务(8091)在跑</span>';
  }
}
async function openStrategy(id) {
  const box = $('shopBody');
  try {
    const d = await getJSON(API + '/strategy/one?id=' + encodeURIComponent(id));
    if (!d.ok) { alert(d.err); return; }
    const it = d.item;
    const old = document.getElementById('shopFull');
    if (old) old.remove();
    const div = document.createElement('div');
    div.id = 'shopFull';
    div.className = 'shopfull';
    div.textContent = '《' + it.name + '》 ' + it.created_at + ' · 状态：' + it.status + (it.note ? ' · ' + it.note : '') + '\n\n' + (it.text || '');
    box.insertBefore(div, box.firstChild);
  } catch (e) { alert('读不到全文：' + e.message); }
}
/* 草稿落 localStorage —— 提交失败一次就得重写整段策略太坑，页面更新/强刷也不该丢 */
const SHOP_DRAFT = 'dsh.cockpit.shopDraft';
function saveDraft() {
  try {
    localStorage.setItem(SHOP_DRAFT, JSON.stringify({
      n: $('stName').value, s: $('stSym').value, t: $('stTf').value, x: $('stText').value,
    }));
  } catch (e) {}
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(SHOP_DRAFT) || '{}');
    if (d.n) $('stName').value = d.n;
    if (d.s) $('stSym').value = d.s;
    if (d.t) $('stTf').value = d.t;
    if (d.x) $('stText').value = d.x;
    if (d.x) { const m = $('stMsg'); m.className = 'shopmsg'; m.textContent = '（已恢复上次未提交的草稿）'; }
  } catch (e) {}
}
['stName', 'stSym', 'stTf', 'stText'].forEach(id => { const el = $(id); if (el) el.addEventListener('input', saveDraft); });
loadDraft();

$('stSend').addEventListener('click', async () => {
  const text = ($('stText').value || '').trim();
  const msg = $('stMsg');
  if (text.length < 10) { msg.className = 'shopmsg bad'; msg.textContent = '至少写 10 个字，总管才看得懂要做什么。'; return; }
  $('stSend').disabled = true;
  msg.className = 'shopmsg'; msg.textContent = '提交中…';
  try {
    const r = await fetch(API + '/strategy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('stName').value, text, symbol: $('stSym').value, tf: $('stTf').value }),
    });
    const d = await r.json();
    if (!d.ok) { msg.className = 'shopmsg bad'; msg.textContent = '提交失败：' + (d.err || ''); return; }
    msg.className = 'shopmsg ok';
    msg.textContent = '已提交（编号 ' + d.id + '）。' + d.note;
    $('stText').value = ''; $('stName').value = '';
    try { localStorage.removeItem(SHOP_DRAFT); } catch (e) {}
    loadShop(true);
  } catch (e) {
    /* "Failed to fetch" 有两种完全不同的原因，必须分开说 ——
       2026-09-20 就是这里含糊，把「服务端缺 OPTIONS 预检处理」说成了「服务没起」，把主人带偏。
       判据：GET 若能通，服务就是活的，那这次失败一定是跨域预检被拦。 */
    msg.className = 'shopmsg bad';
    let why = '网络层失败（' + e.message + '）。';
    try {
      const h = await fetch(API + '/strategy/list?probe=' + Date.now(), { cache: 'no-store' });
      why += h.ok
        ? '但接口是活的（GET 通），所以是**跨域预检被拦**：服务端缺 OPTIONS 处理。'
        : '接口回了 HTTP ' + h.status + '。';
    } catch (e2) {
      why += '连 GET 都不通 —— 8091 大概真的没起（检查计划任务 DSH-Quant-Signal）。';
    }
    msg.textContent = '提交失败：' + why + ' 你的草稿已自动保留，刷新不丢。';
  } finally { $('stSend').disabled = false; }
});

/* ═════════════════════ 轮询调度：只刷当前页签 ═════════════════════ */
setInterval(() => { if (S.tab === 'manual') { loadKline(false); } }, 5000);
setInterval(() => { if (S.tab === 'manual') { loadVerdict(false); } }, 10000);
setInterval(() => { if (S.tab === 'manual') { loadTaAll(false); } }, 15000);
setInterval(() => { if (S.tab === 'manual' && !document.hidden) { loadSignals(); loadRadar(); loadPaSignals(); loadExtremes(); } }, 15000);
setInterval(() => {
  const panel = $('mtab-signals');
  if (S.tab === 'manual' && !document.hidden && panel && !panel.classList.contains('hidden') &&
      S.signalActive && $('sigInput').value.trim().toUpperCase() === S.signalActive) querySignal(undefined, true);
}, 30000);
setInterval(() => { if (S.tab === 'bots') loadShadow(false); }, 15000);
setInterval(() => { if (S.tab === 'shop') loadShop(false); }, 15000);
setInterval(tick, 15000);

/* ═════════════════════ 启动 ═════════════════════ */
loadView();                 // 恢复上次看的标的/周期/基准/叠加层
$('kSym').value = S.sym;    // 输入框必须与真实状态一致，否则会出现「框里 HYPE、图上 BTC」
buildTfBar();
tick();
const h0 = (location.hash || '').replace('#', '');
setTab(['manual', 'bots', 'shop'].indexOf(h0) >= 0 ? h0 : 'manual', true);

/* 调试钩子：URL 带 ?tipprobe=N 时，首次画完直接把第 N 个买卖点的悬停提示渲染出来。
   为什么需要它：无头渲染能用 --dump-dom 读到提示内容，从而**确定性**地验证
   「鼠标停上去给出的理由」这段文案是对的 —— 靠 OCR 在密集的图上找三角并不可靠。 */
(function () {
  const m = /[?&]tipprobe=(\d+)/.exec(location.search || '');
  if (!m) return;
  const want = parseInt(m[1], 10);
  let tries = 0;
  const t = setInterval(function () {
    tries++;
    const ms = S.sigMarkers || [];
    const tip = $('kTip');
    if (ms.length > want) {
      clearInterval(t);
      tip.style.whiteSpace = 'normal';
      tip.style.maxWidth = '290px';
      tip.style.display = 'block';
      tip.style.left = '40px';
      tip.style.top = '60px';
      tip.innerHTML = sigTipHtml(ms[want].sg) + '<br><span style="color:#636368;">[tipprobe ' + want + ']</span>';
    } else if (tries > 60) {
      clearInterval(t);
      tip.style.display = 'block';
      tip.innerHTML = '[tipprobe 失败] 只有 ' + ms.length + ' 个买卖点，取不到第 ' + want + ' 个';
    }
  }, 250);
})();
