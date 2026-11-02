/* redesign.js — 驾驶舱界面重做（2026-10-07）
   这一层不新增数据源、不改任何后台进程：只接管四个渲染函数（setTab / loadShadow /
   renderShadow / loadShop），把 cockpit.js 的原始数据**换一套模块化小组件**摆出来。
   安全联锁（本轮重点）：
     ① 前三名 → 真上实盘 这一步默认停在「待上实盘」；
     ② 开关 AUTO_LIVE_PROMOTE 默认 OFF，且只有 PnL_VALIDATED = true 能点亮（硬拦）；
     ③ 主按钮「放行上实盘」**只登记排队，绝不下单**（下单通路本轮不做，只留接口）。
   ⚠️ 前端任何情况下都不得出现下单调用；证据：交付报告附 grep 结果（下单端点 0 命中）。 */
'use strict';

/* ═══════════════ 1. 时间：一律自己按 UTC+8 算，不直接印 JSON 里的 *_bj 字符串 ═══════════════
   实测（2026-10-07，逐条与 epoch 对过）：
     · live.json 的 cutoff_bj / started_bj **是对的**（＝ epoch + 8 小时，北京）。
     · shadow.json 的 synced_at_bj = 19:41:49 是**墨尔本本机时间**，同一条 epoch 换算北京应为 16:41:49
       —— 字段名叫 bj，值不是北京时间。驾驶舱旧版把它当北京印出来，标签和数值差 3 小时。
   处置：所有时间戳一律从 epoch 自己换算，标签才敢写「北京」。 */
function rdPad(n) { return String(n).padStart(2, '0'); }
function rdBJ(ts, mode) {
  if (ts == null || ts === '') return '--';
  const n = Number(ts);
  if (!isFinite(n)) {
    /* 非 epoch：live_detail.updated_at 实测是 ISO 串（2026-10-07T18:30:00+08:00）。
       这里交给 rdStamp 解析，否则会静默显示 '--'（陈旧提示也就永远不亮）。 */
    const s = (typeof rdStamp === 'function') ? rdStamp(ts) : String(ts);
    if (mode === 'hm') { const m = /(\d{2}:\d{2})/.exec(s); return m ? m[1] : s; }
    return s;
  }
  if (n <= 0) return '--';
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms + 8 * 3600 * 1000);
  const hm = rdPad(d.getUTCHours()) + ':' + rdPad(d.getUTCMinutes());
  if (mode === 'hm') return hm;
  if (mode === 'full') return d.getUTCFullYear() + '-' + rdPad(d.getUTCMonth() + 1) + '-' + rdPad(d.getUTCDate()) + ' ' + hm + ':' + rdPad(d.getUTCSeconds());
  return rdPad(d.getUTCMonth() + 1) + '-' + rdPad(d.getUTCDate()) + ' ' + hm;
}
/* epoch（秒/毫秒）或 ISO 串或纯日期 'YYYY-MM-DD' → 毫秒时间戳；都不像就 null。无偏移的串按**北京**解读。 */
function rdTsMs(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const off = /([+-])(\d{2}):?(\d{2})\s*$/.exec(s);
  if (off) { const sign = off[1] === '-' ? -1 : 1; return base - sign * (parseInt(off[2], 10) * 60 + parseInt(off[3], 10)) * 60000; }
  return base - 8 * 3600 * 1000;                  /* 无偏移 ⇒ 当作北京时间 */
}
function rdAge(ts) {
  if (!ts) return '--';
  const n = Number(ts); const ms = n > 1e12 ? n : n * 1000;
  const s = Date.now() / 1000 - ms / 1000;
  if (!isFinite(s) || s < 0) return '--';
  if (s < 60) return Math.round(s) + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  return (s / 3600).toFixed(1) + ' 小时前';
}

/* ═══════════════ 2. 安全联锁（硬闸 · 不靠文案）═══════════════ */
/* 🔴 2026-10-12 改（QUANT-LIVE-PREP-20261012 · D / N1 双源消除）：
   原实现在这里写死 `PNL_VALIDATED: false`，而数据侧 shadow.json 另有一个 pnl_validated，
   闸门 = 前端常量 **与** 数据字段（`redesign.js` 旧 `rdGateOpen()`）⇒ **两个真源**：
   数据侧把 pnl_validated 改成 true，闸门**仍然打不开**（前端那个恒 false）——
   于是"改闸门"的工作全部白做，且账户真值块（只看 JSON）与闸门行（看两个源）对同一件事给两个答案。
   ⇒ 现在**唯一真源 = shadow.json.pnl_validated**（`RD.d.pnl_validated`），前端不再持有独立常量；
      取不到 / 认不出 ⇒ `rdBool()` 返回 false ⇒ 闸门**关**（fail-closed）。
   ⚠️ 原文那句「想看它变 true 必须有人先改这里」**作废**：改数据字段即应生效（判据见交付报告负控）。
   保留 REASON 仅作**文案**（它不是闸门，不参与判断；是否可信由数据字段说了算）。 */
const HARD_GATE = {
  REASON: '影子盘计价口径是否已独立验证，以 shadow.json.pnl_validated 为唯一真源；未开 ⇒ 名次不能当晋级依据',
  WHERE: 'dashboard/redesign.js · HARD_GATE 仅存文案；rdGateOpen() 只读 RD.d.pnl_validated（2026-10-12 去双源）',
};
function rdGateOpen() {
  /* 单一真源：数据字段。不再与前端的独立常量做「与」运算。
     RD.d == null（榜还没加载）⇒ false，绝不默认开。 */
  return !!(RD.d && rdBool(RD.d.pnl_validated));
}
const LS_AUTO = 'dsh.cockpit.autoLivePromote';
const LS_QUEUE = 'dsh.cockpit.liveQueue';
const RD = { d: null, live: null, pos: null, truth: null, filter: 'all', autoLive: false, queue: {}, shop: null, lastCore: 0, lastShop: 0, ld: null, ldErr: null, lastLD: 0 };
/* ── 数据新鲜度阈值（2026-10-18 · hengpan-sync · P04-HENGPAN-LIVE-SYNC-20261018-01）──
   RD_STALE_SEC        = 180：live.json / pos.json 的"当前/过期"判据（60s 一轮只读采集，3 轮未成功即过期）。
   RD_DETAIL_STALE_SEC = 600：live_detail.json 只在新鲜时才允许当总览 KPI 主源。
     为什么必须挡：live_detail.json 自 2026-10-15 13:45 起已停更（写它的那一路不跑了），
     它的 account.equity=18.9745；而 2026-10-18 交易所真值 equity_now≈8.86。
     旧逻辑"live_detail 优先" ⇒ 总览一直印 10-15 的 18.99，与账户真值块(读 live.json)打架。
     这条阈值把"过期快照"降级为回退源，页面卡面同时写明"已过期 N 分钟 ⇒ 回退 live.json"。 */
const RD_STALE_SEC = 180;
const RD_DETAIL_STALE_SEC = 600;
/* UI 时钟偏差容差：时间戳比浏览器时间还晚超过 60s ⇒ 显示"时钟偏差"，绝不显示"新鲜"。
   （tick 侧用的是严格有符号 age；UI 侧留 60s 容差只为容忍浏览器/VPS 的 NTP 漂移。） */
const RD_CLOCK_SKEW_TOL_SEC = 60;

/* ── 渲染层隐藏名单（主人 2026-10-07 令：这两条从榜上彻底拿掉）─────────────────
   它们是同一类**模拟器缺陷**：名义敞口越界（持仓被跨品种/跨轮次带过来），
   账本上的"收益"绝大部分是那个越界头寸的浮盈，不是它自己挣的 —— 名次不可比。
   ⚠️ 拿掉的只是**展示**：shadow.json / live.json / 后台进程一律不动，数据仍在，
   依据仍可在影子榜底部的「已隐藏 · 依据」里展开复算。 */
const RD_HIDE = {
  shadow_grid_roll: '模拟器缺陷 · 越界持仓带走',
  shadow_box: '模拟器缺陷 · 越界持仓带走',
};
function rdIsHidden(name) { return !!RD_HIDE[name]; }

function rdLoadStored() {
  try { RD.autoLive = localStorage.getItem(LS_AUTO) === '1'; } catch (e) { RD.autoLive = false; }
  try { RD.queue = JSON.parse(localStorage.getItem(LS_QUEUE) || '{}') || {}; } catch (e) { RD.queue = {}; }
  /* 兜底：存过 ON 但闸门是关的 ⇒ 强制回 OFF（不许靠界面骗过联锁） */
  if (RD.autoLive && !rdGateOpen()) { RD.autoLive = false; try { localStorage.removeItem(LS_AUTO); } catch (e) {} }
}
function setAutoLive(on) {
  if (on && !rdGateOpen()) {                       // ← 硬拦：闸门没开，开关点不亮
    const m = $('lockMsg');
    if (m) { m.className = 'lockmsg bad'; m.textContent = '拒绝开启：PnL 验证闸门未开（' + HARD_GATE.WHERE + '）'; }
    rdRenderLock();
    return false;
  }
  RD.autoLive = !!on;
  try { if (RD.autoLive) localStorage.setItem(LS_AUTO, '1'); else localStorage.removeItem(LS_AUTO); } catch (e) {}
  rdRenderLock();
  return true;
}
/* 主按钮 = 主人放行。只写本地登记簿（登记/排队），**没有任何下单调用**。 */
function rdRelease() {
  const cands = rdPromoCands(RD.d);
  if (!cands.length) return;
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const c of cands) {
    if (RD.queue[c.key]) continue;
    RD.queue[c.key] = { name: c.name, ret: c.ret, doubt: !!c.doubt, ts: now, mode: 'register-only', by: '主人' };
    n++;
  }
  try { localStorage.setItem(LS_QUEUE, JSON.stringify(RD.queue)); } catch (e) {}
  const m = $('lockMsg');
  if (m) {
    m.className = 'lockmsg';
    m.textContent = n ? ('已登记 ' + n + ' 个进「待接通路」队列（' + rdBJ(now, 'hm') + ' 北京）—— 本轮不下任何单') : '这些已经登记过了';
  }
  rdRenderPromote();
}
function rdSaveQueue() { try { localStorage.setItem(LS_QUEUE, JSON.stringify(RD.queue)); } catch (e) {} }

/* ═══════════════ 3. 榜单数据合成（逻辑沿用 cockpit.js，未改口径）═══════════════ */
function rdDoubt(b) { return (typeof _doubtOf === 'function') ? _doubtOf(b) : null; }
function rdRankList(d) {
  const list = [];
  for (const b of (d.books || [])) {
    if (rdIsHidden(b.name)) continue;   /* ← 隐藏名单：渲染层拿掉，数据源不删 */
    const isSig = (b.mode === 4 || b.mode === 5 || b.kind === 'signal' || b.kind === 'jev');
    const isJev = (b.mode === 5 || b.kind === 'jev');
    const isMM = (b.mode === 6 || b.mode === 7 || b.kind === 'origmm' || b.kind === 'hype_mm');
    let sub;
    if (isMM) {
      const m = b.mm || {};
      const n = (m.blocks != null ? m.blocks : m.ticks) || 0;
      sub = '每 ~300ms 决策 · 已跑 ' + n + (m.blocks != null ? ' 块' : ' tick') + ' · ' + (m.dry_run ? '干跑' : '实盘');
    } else if (isSig) {
      sub = (b.tf || '?') + '分 · ' + (b.lev || '?') + 'x · ' + (b.position || '空仓') + (b.verify_blocked ? ' · 已停开仓' : '');
      if (b.trades) sub += ' · ' + b.trades + ' 笔';
    } else {
      sub = (b.cells || '?') + '格 · ' + (b.lev || '?') + 'x' + (b.hit_sl ? ' · 已触止损线' : '') + (b.rebaselined_at ? ' · 已重算' : '');
    }
    const dq = rdDoubt(b);
    list.push({
      key: 'shadow:' + (b.name || b.symbol || Math.random()),
      name: b.name, symbol: b.symbol,
      kind: isMM ? '原版做市' : (isJev ? 'Jev 仓位' : (isSig ? '信号' : '网格')),
      ret: b.ret_pct, pnl: b.pnl_u, sub: sub, obj: b, doubt: dq,
      group: dq ? 'doubt' : 'shadow',
      noTrades: isSig && !(b.trades > 0),
    });
  }
  for (const h of (d.horses || [])) {
    if (!h || !h.horse) continue;
    list.push({
      key: 'horse:' + h.horse, name: h.horse, symbol: (h.pos && h.pos[0] && h.pos[0].sym) || '—',
      kind: '方向', ret: h.ret_pct, pnl: h.cum_pnl, group: 'shadow', doubt: null,
      sub: h.trades + ' 笔 · 胜率 ' + (h.winrate == null ? '--' : h.winrate + '%'), obj: h,
    });
  }
  for (const L of ((d.live && d.live.entries) || [])) {
    list.push({
      key: 'live:' + L.name, name: L.name, symbol: L.symbol, kind: '实盘', ret: L.ret_pct, pnl: L.pnl_u,
      group: 'live', doubt: null, isLive: true, obj: L,
      sub: (L.lev || '?') + 'x · 起点本金 ' + fmtNum(L.invest_u, 2) + 'U · 未实现 ' + fmtNum(L.unrealized_now, 2) + 'U',
    });
  }
  list.sort((a, b) => (b.ret == null ? -1e9 : b.ret) - (a.ret == null ? -1e9 : a.ret));
  return list;
}
function rdTop3(d) {
  if (!d) return [];
  return rdRankList(d).filter(x => x.group === 'shadow' || x.group === 'doubt').slice(0, 3);
}
/* 可放行的候选：前三名 **且正收益**。
   沿用 cockpit.js 原有判据（原文：「名次只是名次; 亏钱的马排进前三, 也不构成晋级理由」）。
   拿掉 grid_roll / box 之后，第三名变成了亏钱的腿 ⇒ 若不过滤，一个 -58% 的马会占着「待放行」名额。 */
function rdPromoCands(d) {
  return rdTop3(d).filter(x => x.ret != null && x.ret > 0);
}
/* 被隐藏的那几条：只用于榜底「已隐藏 · 依据」的展开层（数据没删，能复算） */
function rdHiddenRows(d) {
  const out = [];
  for (const b of ((d && d.books) || [])) {
    if (!rdIsHidden(b.name)) continue;
    out.push({ name: b.name, symbol: b.symbol, ret: b.ret_pct, pnl: b.pnl_u, reason: RD_HIDE[b.name], doubt: rdDoubt(b), obj: b });
  }
  return out;
}
function rdHiddenFootHtml(d) {
  const rows = rdHiddenRows(d);
  if (!rows.length) return '';
  let ev = '<b>已隐藏 ' + rows.length + ' 条 · 依据（可复算 · 数据未删）</b>';
  for (const x of rows) {
    const q = x.doubt || {};
    ev += '<div>· <b>' + esc(x.name) + '</b>（' + esc(x.symbol || '') + '）：账本收益 ' + pct(x.ret) +
      '，但当前名义敞口 <code>' + fmtNum(q.notional, 2) + 'U</code> ＝ 应有名义 ' + fmtNum(q.margin, 2) + 'U 的 <b>' +
      (q.ratio ? q.ratio.toFixed(1) : '--') + ' 倍</b>（越界）；累计盈亏里 <code>' + fmtNum(q.unreal, 2) +
      'U</code> 是这个越界头寸的浮盈，不是它自己挣的 ⇒ 名次不可比。</div>';
  }
  ev += '<div>· 处置：按主人 2026-10-07 令，从影子榜 / 总览在跑的马 / 「影子第一名」KPI / 晋级队列<b>全部拿掉</b>；' +
    '<b>数据源 shadow.json 与后台 runner 一律未动</b>，本条仍可在下面这些地方查到。</div>' +
    '<div>· 依据文件：<code>量化交易/工程/影子盘异常审计-shadow_grid_roll-20261007.md</code>、' +
    '<code>量化交易/工程/赛马榜-实盘入榜-20261007.md</code>；系统闸门 <code>PnL_VALIDATED = false</code>（名次本就不能当晋级依据）。</div>';
  return '<div class="hiddennote">已隐藏 ' + rows.length + ' 条（模拟器缺陷 · 越界，详见存档）' +
    '<button class="more" data-more="hidDet">依据</button></div>' +
    '<div class="morebody hidden" id="hidDet">' + ev + '</div>';
}

/* ═══════════════ 4. 渲染 · 影子榜 ═══════════════ */
const RD_GROUPS = [['all', '全部'], ['live', '实盘'], ['shadow', '影子纸面·结构正常'], ['doubt', '影子纸面·存疑']];
function rdRowHtml(x, i, total) {
  const rk = i + 1;
  const inTop3 = rk <= 3 && total >= 3;
  const profitable = x.ret != null && x.ret > 0;
  const losing = x.ret != null && x.ret <= -20;
  let kls = 'rankrow';
  if (x.isLive) kls += ' live';
  else if (inTop3 && profitable) kls += (rk === 1 ? ' p1' : ' p2');
  if (x.doubt) kls += ' doubt';
  let tags = '';
  if (x.isLive) {
    tags = '<span class="badge g"><i class="dotb g"></i>真金</span><span class="badge g">交易所 closedPnl</span>' +
      (losing ? '<span class="badge r">触 -20% 降级线</span>' : '');
  } else if (x.noTrades) {
    tags = '<span class="badge n">模拟</span><span class="badge n">未开张</span>';
  } else if (x.doubt) {
    tags = '<span class="badge n">模拟</span><button class="badge y" data-more="rd' + i + '">' +
      '<i class="dotb a"></i>存疑 · 依据</button>';
  } else if (inTop3 && profitable) {
    tags = '<span class="badge n">模拟</span><span class="badge y">前三</span>';
  } else {
    tags = '<span class="badge n">模拟</span>';
  }
  if (!x.isLive && !x.noTrades && losing) tags += '<span class="badge r">触 -20% 降级线</span>';
  const pnlTxt = x.isLive ? ((Number(x.pnl) >= 0 ? '+' : '') + Number(x.pnl).toFixed(2) + ' U') : (fmtNum(x.pnl, 2) + ' U');
  let h = '<div class="' + kls + '">' +
    '<div class="rk">' + rk + '</div>' +
    '<div class="mid"><div class="nm">' + esc(x.name) + '</div>' +
      '<div class="mt">' + esc(x.symbol || '') + ' · ' + esc(x.kind) + ' · ' + esc(x.sub || '') + '</div>' +
      '<div class="tags">' + tags + '</div></div>' +
    '<div class="ret ' + cls(x.ret) + '">' + (x.doubt ? '⚠ ' : '') + pct(x.ret) + '</div>' +
    '<div class="pnl">' + pnlTxt + '</div>' +
    '</div>';
  if (x.doubt) h += '<div class="rankdet hidden" id="rd' + i + '">' + rdDoubtHtml(x) + '</div>';
  return h;
}
function rdDoubtHtml(x) {
  const q = x.doubt || {};
  const share = q.cum ? (q.unreal / q.cum * 100) : null;
  return '<b>统计存疑 · 依据（可复算）</b>' +
    '<div>· 当前名义敞口 <code>' + fmtNum(q.notional, 2) + 'U</code> ＝ 应有名义（本金 ' +
      fmtNum(x.obj.invest_u, 2) + 'U × ' + esc(String(x.obj.lev)) + 'x ＝ ' + fmtNum(q.margin, 2) +
      'U）的 <b>' + q.ratio.toFixed(1) + ' 倍</b> —— 越界。</div>' +
    '<div>· 累计盈亏 ' + fmtNum(q.cum, 2) + 'U 里 <code>' + fmtNum(q.unreal, 2) + 'U</code>' +
      (share == null ? '' : '（' + share.toFixed(1) + '%）') + ' 是这个越界持仓的<b>浮盈</b>，不是它自己挣的。</div>' +
    '<div>· 模拟器 <code>ledger/shadow_grid.py</code> 只有 taker 0.055% 与资金费，<b>没有滑点项</b>，' +
      '而账本 note 声明「含滑点 0.02%」⇒ 口径声明与实现不符。</div>' +
    '<div>· 价格跑出区间只做 <code>range_resets += 1</code> 重锚，<b>不清仓、无保证金/强平检查、无仓位上限</b>。</div>' +
    '<div>· 系统自己的闸门已否决：<b>PnL_VALIDATED = false</b>，晋级器原文「名次不能当晋级依据」。</div>' +
    '<div>· 独立审计（2026-10-07）：真实成分 ≈ 0。本条<b>保留不删</b>，只置灰。</div>';
}
function rdGateBanner(d) {
  const g = $('gateBanner'); if (!g) return;
  const ok = rdGateOpen();
  g.className = 'gline' + (ok ? ' ok' : '');
  g.innerHTML = '<i class="gw"></i><b>' + (ok ? 'PnL 验证闸门：已开' : 'PnL 验证闸门：未开') + '</b>' +
    '<span class="gd">' + (ok ? '影子绩效可信，名次可作晋级依据' : '名次只是「如果闸门开了排第几」，不是晋级决定') + '</span>' +
    '<button class="more" data-more="gateDet">依据</button>' +
    '<div class="morebody hidden" id="gateDet" style="flex:1 1 100%;">' +
      '· 闸门真值：<code>PnL_VALIDATED = ' + String(!!(d && d.pnl_validated)) + '</code>（shadow.json）。<br>' +
      '· 未开的原因：影子盘计价口径还没被独立验证 —— 模拟器无强平/无保证金检查、越界持仓会被带到新品种、无滑点项（2026-09-12 修过一次穿越次数平方缺陷，修复前绩效已作废重算）。<br>' +
      '· 后果：闸门打开之前，影子成绩不能拿去加仓、也不能上新实盘；<b>本次界面重做不改变这个结论</b>。' +
    '</div>';
}
function rdRenderRank(d) {
  const list = rdRankList(d);
  const CNT = { all: 0, live: 0, shadow: 0, doubt: 0 };
  for (const x of list) { CNT.all++; CNT[x.group] = (CNT[x.group] || 0) + 1; }
  const SHOWN = list.filter(x => RD.filter === 'all' || x.group === RD.filter);
  let h = '<div class="rankfilter">';
  for (const g of RD_GROUPS) {
    h += '<button class="mbtn' + (RD.filter === g[0] ? ' on' : '') + '" data-rg="' + g[0] + '">' + esc(g[1]) +
      ' <b>' + (CNT[g[0]] || 0) + '</b></button>';
  }
  h += '<span class="rfnote">' + (RD.filter === 'live'
      ? '实盘＝Bybit 交易所真值（closedPnl 已扣手续费 ＋ 资金费，真金）。'
      : RD.filter === 'doubt'
      ? '这些腿的名义敞口越界，浮盈不是它自己挣的 —— 名次不可比，仅留档。'
      : '绿＝真金（交易所），其余＝模拟账本；置灰＝统计存疑。同榜不同源，不可直接比较。') + '</span>';
  h += '</div><div class="ranklist">';
  if (!SHOWN.length) {
    h += '<span class="loading">' + (list.length ? '该筛选下没有条目' : '影子盘暂无在跑的马') + '</span>';
  } else {
    SHOWN.forEach((x, i) => { h += rdRowHtml(x, i, SHOWN.length); });
  }
  h += '</div>';
  /* 口径与来源：全部收进可展开层，台面上只留结论 */
  const rep = d.report_ts ? rdBJ(d.report_ts, 'full') : '--';
  h += '<div style="margin-top:14px;"><button class="more" data-more="rankCaveat">口径 · 来源 · 可比性缺陷</button>' +
    '<div class="morebody hidden" id="rankCaveat">' +
    '<b>收益口径</b>：收益 = 累计盈亏 ÷ 该腿本金（网格/方向马 10U，信号腿与 Jev 腿 5U，原版做市 100U）。' +
    '网格类「笔数」是套利次数，其余是真交易笔数。VPS runner 报告时间 <b>' + rep + '（北京）</b>。<br>' +
    '<b>三种腿不是一回事</b>：网格腿逐格吃价差；信号腿等驾驶舱买卖点（约 3 小时一个）；原版做市腿不等任何信号，每 ~300ms 撤旧单挂新单。' +
    '网格的 grid_profit 是逐格累计、无成交血缘，不可信；只有 pnl_u 可信。<br>' +
    '<b>实盘口径（真金 · 与影子不同源）</b>：' + rdLiveSrcHtml(d) + '<br>' +
    '<b>⚠️ 可比性缺陷</b>：① 闸门 PnL_VALIDATED = false ⇒ 影子名次都不算数；' +
    '② 置灰行＝名义敞口越界，收益里绝大部分是越界头寸的浮盈；' +
    '③ 网格账本 note 声明含滑点 0.02%，但模拟器没有滑点项。' +
    '<b>结论：实盘行（绿）才有真金证据；影子行只能当假设，不能当业绩。</b>' +
    '</div></div>';
  h += rdHiddenFootHtml(d);
  $('rankBody').innerHTML = h;
  for (const btn of $('rankBody').querySelectorAll('[data-rg]')) {
    btn.onclick = () => { RD.filter = btn.getAttribute('data-rg'); rdRenderRank(RD.d); };
  }
}
function rdLiveSrcHtml(d) {
  const lv = d.live;
  if (!lv || !lv.entries) return 'live.json 未同步。';
  const le = lv.entries.map(e => '<b>' + esc(e.name) + '</b>（' + esc(e.symbol) + '，起点本金 ' +
    fmtNum(e.invest_u, 2) + 'U，' + rdBJ(e.started_at, 'full') + ' 北京起）已实现净额 ' + fmtNum(e.pnl_u, 2) +
    'U ＝ closedPnl ' + fmtNum(e.closed_pnl_u, 2) + 'U ＋ 资金费 ' + fmtNum(e.funding_u, 4) + 'U，' + e.trades + ' 笔').join('；');
  return le + '。来源：Bybit <code>/v5/position/closed-pnl</code> ＋ <code>/v5/account/transaction-log</code>（只读）。' +
    '数据截止 <b>' + rdBJ(lv.fetched_at, 'full') + '（北京）</b>。';
}

/* ── 样本跨度（文案一律叫「可查区间」）──────────────────────────────────────
   ⚠️ 口径纠错（2026-10-07 主人实测）：Bybit closed-pnl **单次跨度上限 7 天**、可回溯深度远小于 90 天
   ⇒ 数据侧那套 `*_90d` 键实际是「**全部可查区间**」，不是 90 天样本（本账号约 41 天：08-28→10-07；
   HYPE 只有 27 天：09-11 起）。数值没错，**错的是「90 天」这四个字** —— 会让人以为样本有 90 天。
   处置：① 文案只写「可查区间」；② 有 `window_span` 就显示起止与天数（每台分开）；③ 没有就用日桶反推，
   并写明推出来的是"有成交的天数"，不冒充跨度；④ 都没有 → 「跨度未取到」。 */
function rdSpan(b) {
  const ws = rdPick(b, ['window_span', 'span', 'query_span']);
  if (ws && typeof ws === 'object') {
    return {
      has: true, derived: false,
      from: rdPick(ws, ['from', 'start', 'first']), to: rdPick(ws, ['to', 'end', 'last']),
      days: rdNumIn(ws, ['days', 'span_days']), symDays: rdNumIn(ws, ['symbol_days', 'sym_days']),
      firstFill: rdPick(ws, ['first_fill_at']), note: rdPick(ws, ['note']),
    };
  }
  const arr = rdPick(b, ['pnl_by_day_90d']);
  if (Array.isArray(arr) && arr.length) {
    const ks = arr.map(x => rdDayKey(rdPick(x, ['date', 'day', 'd', 't']) || '')).filter(k => k && k !== '?').sort();
    if (ks.length) return { has: true, derived: true, from: ks[0], to: ks[ks.length - 1], filledDays: ks.length };
  }
  return { has: false };
}
function rdSpanText(sp) {
  if (!sp || !sp.has) return '可查区间（跨度未取到）';
  const a = sp.from ? rdDayLbl(rdDayKey(String(sp.from))) : null;
  const z = sp.to ? rdDayLbl(rdDayKey(String(sp.to))) : null;
  const rng = (a && z) ? (a + ' → ' + z) : '';
  if (sp.derived) return '可查区间 ' + rng + '（其中 ' + sp.filledDays + ' 天有成交）';
  const bits = [];
  if (sp.days != null) bits.push(sp.days + ' 天');
  if (sp.symDays != null && (sp.days == null || sp.symDays !== sp.days)) bits.push('本标的 ' + sp.symDays + ' 天');
  return '可查区间 ' + (rng || '（起止未取到）') + (bits.length ? '（' + bits.join(' · ') + '）' : '');
}
function rdSpanUnion(bots) {
  const sps = (bots || []).map(rdSpan).filter(s => s.has && s.from && s.to);
  if (!sps.length) return null;
  return { has: true, derived: sps.some(s => s.derived),
           from: sps.map(s => String(s.from)).sort()[0], to: sps.map(s => String(s.to)).sort().slice(-1)[0] };
}

/* ── 总览 KPI 的唯一数据源：live_detail.json（可查区间优先）；缺了才回退 live.json ──
   为什么必须统一：live.json 是按需脚本产出的、**不会自动刷新**，而 live_detail.json 是另一路在写
   ⇒ 同一屏两处数字不同源 → 主人看到「总览没更新」（2026-10-07 事故）。
   为什么优先可查区间：运行窗口口径会被**进程重启清零**（当天 17:10 刚发生一次：HYPE 的
   realized_net/funding 直接归 0，卡片从 +5.37 掉下去 —— 那不是亏损，是口径重置）。 */
function rdLiveKpis() {
  const det = RD.ld, d = RD.d, lv = (d && d.live) || null;
  const out = { src: 'none', basis: '', equity: null, realized: null, n: 0, trades: null, at: null, per: [] };
  const bots = (det && Array.isArray(det.bots)) ? det.bots : [];
  /* 2026-10-18 hengpan-sync：live_detail.json 已停更（最后 10-15 13:45，account.equity=18.9745），
     若继续让它当 KPI 主源，总览会印 18.99 而账户真值块印 8.86 —— 同一屏两个答案。
     ⇒ 只有 det 新鲜（<= RD_DETAIL_STALE_SEC）时才允许它胜出；否则回退 live.json 并在卡面写明原因。 */
  const detAt = det ? rdPick(det, ['updated_at']) : null;
  const detMs = detAt == null ? null : rdTsMs(detAt);
  const detAgeSec = (detMs == null) ? null : Math.max(0, Math.round((Date.now() - detMs) / 1000));
  const detFresh = (detAgeSec != null && detAgeSec <= RD_DETAIL_STALE_SEC);
  if (bots.length && !detFresh) { out.detStaleSec = detAgeSec; }
  if (bots.length && detFresh) {
    const at = rdPick(det, ['updated_at']);
    const eq = rdNumIn(det.account || {}, ['equity']);
    /* ① 可查区间（跨重启不清零）：逐台 pnl_window_90d.all.net；没这键就用 pnl_by_day_90d 求和 */
    let sum = 0, ok = 0, tr = 0, haveTr = false;
    const per = [];
    for (const b of bots) {
      const all = rdPick(rdPick(b, ['pnl_window_90d']) || {}, ['all', 'total']) || {};
      let net = rdNumIn(all, ['net', 'net_u']);
      if (net == null) {
        const days = rdPick(b, ['pnl_by_day_90d']);
        if (Array.isArray(days) && days.length && days.every(x => rdNum(x && x.net) != null)) net = days.reduce((a, x) => a + rdNum(x.net), 0);
      }
      const t = rdNumIn(all, ['trades', 'n']);
      const wr = rdNumIn(all, ['win_rate', 'winrate']);
      if (net != null) { sum += net; ok++; }
      if (t != null) { tr += t; haveTr = true; }
      per.push({ name: rdG(b, 'name'), net: net, trades: t, wr: wr, span: rdSpan(b) });
    }
    if (ok) {
      const uni = rdSpanUnion(bots);
      out.src = 'detail-span'; out.realized = ok === bots.length ? sum : null; out.n = bots.length; out.trades = haveTr ? tr : null;
      out.equity = eq; out.at = at; out.per = per; out.union = uni;
      out.basis = bots.length + ' 个实盘实例 · 可查区间 · 交易所 closedPnl ＋ 资金费' +
        (uni ? ' · ' + rdSpanText(uni) : ' · 跨度未取到') +
        (ok === bots.length ? '' : ' · 部分实例缺数据，合计未提供');
      return out;
    }
    /* ② 次选：live_detail 的运行窗口口径（卡面写明重启会清零） */
    let s2 = 0, ok2 = 0;
    const per2 = [];
    for (const b of bots) {
      // Collector contract: realized_net already includes funding; never add it twice.
      const rn = rdNum(rdG(b, 'realized_net'));
      if (rn != null) { s2 += rn; ok2++; }
      per2.push({ name: rdG(b, 'name'), net: rn, trades: rdCount(rdG(b, 'trades')) });
    }
    if (ok2) {
      out.src = 'detail-window'; out.realized = ok2 === bots.length ? s2 : null; out.n = bots.length; out.equity = eq; out.at = at;
      out.per = per2.map(x => Object.assign({}, x, { span: null }));
      out.basis = bots.length + ' 个实盘实例 · 运行窗口口径（重启会清零）· closedPnl ＋ 资金费' + (ok2 === bots.length ? '' : ' · 部分实例缺数据，合计未提供');
      return out;
    }
  }
  /* ③ 回退：live.json（由 D 盘只读采集循环 live_rank_sync.ps1 刷新，卡面必须写清截止时间） */
  if (lv && lv.entries && lv.entries.length) {
    out.src = 'live';
    out.equity = rdNum(rdG(lv, 'equity_now'));
    out.realized = lv.entries.every(e => rdNum(e.pnl_u) != null) ? lv.entries.reduce((a, e) => a + rdNum(e.pnl_u), 0) : null;
    out.n = lv.entries.length; out.at = rdG(lv, 'fetched_at');
    out.basis = lv.entries.length + ' 个实盘实例 · 运行窗口口径（回退 live.json' +
      (out.detStaleSec == null ? '' : '；live_detail.json 已过期 ' + Math.round(out.detStaleSec / 60) + ' 分钟') +
      '）· closedPnl ＋ 资金费';
    out.per = lv.entries.map(e => ({ name: e.name, net: rdNum(e.pnl_u), trades: rdNum(e.trades) }));
    return out;
  }
  return out;   /* 都没有 ⇒ 上层显示「本次未取到」，绝不用 0 冒充 */
}
function rdKpiAge(k) {
  const ms = rdTsMs(k.at);
  if (ms == null) return { txt: '', min: null, sec: null, signedSec: null, future: false, stale: true };
  const signed = Math.round((Date.now() - ms) / 1000);     /* signed：负数 = 时间戳在未来 */
  const future = signed < -RD_CLOCK_SKEW_TOL_SEC;
  const sec = Math.max(0, signed);
  const min = Math.round(sec / 60);
  /* 2026-10-18 hengpan-sync：阈值 180s（原 10 分钟）—— 与 live.json/pos.json 的 3 分钟过期口径一致；
     时间戳在未来 ⇒ clock skew，必须等同于"不可信"，不得显示当前正常。 */
  return {
    txt: future ? ('未来 ' + Math.abs(signed) + ' 秒（时钟偏差）') : (sec < 60 ? '刚刚' : (min + ' 分钟前')),
    min: min, sec: sec, signedSec: signed, future: future,
    stale: future || sec > RD_STALE_SEC,
  };
}
function rdKpiRunHtml(k) {
  return '<span class="miss">' + esc(k.basis) + '</span>' +
    (k.per && k.per.length ? ' · <button class="more" data-more="ovRunDet">看名单</button>' : '') +
    (k.per && k.per.length
      ? '<div class="morebody hidden" id="ovRunDet">' + k.per.map((x, i) =>
          '<div>· ' + (i + 1) + '. <b>' + esc(String(x.name || '未命名')) + '</b> ｜ 净 ' +
          (x.net == null ? '--' : rdTrSgn(x.net, 4, 'U')) +
          (x.trades == null ? '' : ' ｜ ' + x.trades + ' 笔') +
          (x.wr == null ? '' : ' ｜ 胜率 ' + fmtNum(x.wr, 1) + '%') +
          (x.span ? ' ｜ 样本 ' + esc(rdSpanText(x.span)) : '') + '</div>').join('') +
        '<div class="miss">口径与时间：' + esc(k.basis) + '；数据截止 ' +
        (k.at == null ? '--' : rdBJ(k.at, 'full')) + ' 北京（' + rdKpiAge(k).txt + '）</div>' +
        '<div class="miss">样本长度说明：这里的数值＝<b>全部查询区间</b>（不是固定天数的样本，也<b>不等于</b>有成交天数）；' +
        '两台样本长度不同，各自查询起止 / 首末成交 / 缺失天数见总览顶部「数据覆盖 · 每标的」。</div></div>'
      : '');
}

/* ── 极简四步动线带（主人 2026-10-08 令）──────────────────────────────────
   要求：**总高 ≤72px、一行 4 格、每格只有「一个数字 + 标签」、不要副标题**；
   数字必须与「晋级 / 影子榜」**同源**（不新造），取不到显示 `--`、不拿 0 冒充。
   位置：必须在实盘聚焦面板（live-focus.js prepend 的 #liveFocus）**上方** ——
   那个面板也是 prepend 进 #pane-overview 的，所以这里用 MutationObserver 把动线带钉在第一位。 */
function rdFlowStripHtml() {
  const d = RD.d;
  const items = (RD.shop && RD.shop.items) || null;
  const submitted = items ? items.length : null;                                   /* 与「策略工坊」同源 */
  const botsN = (d && Array.isArray(d.candidates)) ? d.candidates.length : null;    /* 与「生成机器人」同源 */
  const running = d ? ((d.books || []).length + (d.horses || []).length) : null;    /* 与「影子榜」同源 */
  const promo = rdPromoCands(d);                                                    /* 与「晋级」同源 */
  const left = d ? promo.filter(c => !RD.queue[c.key]).length : null;
  const cell = (go, n, unit, label, act) =>
    '<button class="fs' + (act && n ? ' act' : '') + '" data-go="' + go + '" title="' + esc(label) + '">' +
      '<span class="fsnum' + (n == null ? ' missnum' : '') + '">' + (n == null ? '--' : n) +
        (n == null || !unit ? '' : '<small>' + unit + '</small>') + '</span>' +
      '<span class="fslbl">' + label + '</span></button>';
  return cell('shop', submitted, '条', '写策略') +
         cell('shop', botsN, '个', '生成机器人') +
         cell('bots', running, '个', '影子盘开跑') +
         cell('promote', left, '个', '前三晋级实盘', true);
}
/* ── 固定挂载点 #rdTop（Codex P1.6）────────────────────────────────────────
   以前靠 MutationObserver + firstElementChild 跟 live-focus.js 的 prepend 抢位置；
   现在改成**固定容器**：本脚本（先于 live-focus.js 执行）同步把 #rdTop 插成 #pane-overview 的第一个子元素，
   live-focus.js 改成「插到 #rdTop 之后」⇒ 顺序由代码写死，不再有竞争、不需要观察者。 */
function rdMountTop() {
  const pane = $('pane-overview'); if (!pane) return;
  let top = document.getElementById('rdTop');
  if (!top) {
    top = document.createElement('div');
    top.id = 'rdTop'; top.className = 'rdtop';
    top.innerHTML = '<div class="flowstrip" id="rdFlowStrip"></div><div id="rdRiskBar"></div><div id="rdCoverage"></div>';
    pane.insertBefore(top, pane.firstElementChild);
  }
  const s = document.getElementById('rdFlowStrip'); if (s) s.innerHTML = rdFlowStripHtml();
  const rb = document.getElementById('rdRiskBar'); if (rb) rb.innerHTML = rdRiskBarHtml();
  const cv = document.getElementById('rdCoverage'); if (cv) cv.innerHTML = rdCoverageHtml();
  rdSyncTopClock();   /* 顶栏时间跟着同一份快照走：页面刷新(浏览器) vs 快照采集(数据)，都按北京 */
}

/* ═══════════════ 5b. 风险条（只展示；不含任何交易按钮）═══════════════
   Codex P1.1：危险值不能继续用普通白色。阈值集中在 RD_RISK_T，改一处即可调。
   关键解释：**IM 高 ≠ 即时强平**（IM 是占用；是否强平看 MM/权益 与标记价）。
   缺数据/取不到一律「不可算」灰色，**绝不给绿灯**。 */
const RD_RISK_T = {
  imPctDanger: 100,                     /* 初始保证金 / 权益 > 100% ⇒ 红 */
  mmPctWarn: 50, mmPctDanger: 80,       /* 维持保证金 / 权益 */
  notionalXWarn: 3, notionalXDanger: 5, /* 名义敞口 / 权益（倍） */
  staleMin: 10,
};
rdMountTop();   /* ← 必须放在 RD_RISK_T 声明**之后**（const 有 TDZ，早调会 ReferenceError） */
function rdRiskData() {
  const det = RD.ld, lv = (RD.d && RD.d.live) || null;
  const acct = (det && det.account) || {};
  const bots = (det && Array.isArray(det.bots)) ? det.bots : [];
  const out = {
    at: null, src: 'none', incomplete: false,
    equity: rdNumIn(acct, ['equity']), available: rdNumIn(acct, ['available']),
    im: rdNumIn(acct, ['im']), mm: rdNumIn(acct, ['mm']), perSym: [], total: null,
  };
  const bySym = {};
  let anyLeg = false;
  for (const b of bots) {
    const legs = Array.isArray(b.positions_all) ? b.positions_all : (b.position ? [b.position] : []);
    for (const p of legs) {
      const size = rdNum(p.size), mark = rdNum(p.mark);
      if (size == null || mark == null) { out.incomplete = true; continue; }
      anyLeg = true;
      const sym = String(p.symbol || rdG(b, 'symbol') || '—');
      bySym[sym] = (bySym[sym] || 0) + Math.abs(size * mark);
    }
  }
  if (!anyLeg && lv && Array.isArray(lv.positions)) {     /* 回退：live.json 的持仓 */
    for (const p of lv.positions) {
      const size = rdNum(p.size), mark = rdNum(p.mark) != null ? rdNum(p.mark) : rdNum(p.avg);
      if (size == null || mark == null) { out.incomplete = true; continue; }
      anyLeg = true;
      const sym = String(p.symbol || '—');
      bySym[sym] = (bySym[sym] || 0) + Math.abs(size * mark);
    }
  }
  out.perSym = Object.keys(bySym).map(k => ({ sym: k, notional: bySym[k] })).sort((a, b) => b.notional - a.notional);
  out.total = anyLeg ? out.perSym.reduce((a, x) => a + x.notional, 0) : null;
  out.at = det ? rdPick(det, ['updated_at']) : (lv ? rdG(lv, 'fetched_at') : null);
  out.src = (det && (det.account || bots.length)) ? 'live_detail' : (lv ? 'live.json' : 'none');
  return out;
}
function rdRiskBarHtml() {
  const R = rdRiskData(), T = RD_RISK_T, AGE = rdKpiAge({ at: R.at });
  const items = [];
  const add = (level, label, value, note) => items.push({ level: level, label: label, value: value, note: note });
  const pctOf = v => (v == null || R.equity == null || R.equity <= 0) ? null : v / R.equity * 100;
  if (R.available == null) add('na', '可用余额', '不可算', '未取到');
  else if (R.available < 0) add('bad', '可用余额', fmtNum(R.available, 2) + ' U', '为负 ⇒ 可用被打满，开不了新仓');
  else add('ok', '可用余额', fmtNum(R.available, 2) + ' U', '');
  const imPct = pctOf(R.im);
  if (imPct == null) add('na', '初始保证金 / 权益', '不可算', '未取到');
  else if (imPct > T.imPctDanger) add('bad', '初始保证金 / 权益', fmtNum(imPct, 2) + '%', '> ' + T.imPctDanger + '%（占用超过权益）');
  else add('ok', '初始保证金 / 权益', fmtNum(imPct, 2) + '%', '');
  const mmPct = pctOf(R.mm);
  if (mmPct == null) add('na', '维持保证金 / 权益', '不可算', '未取到');
  else if (mmPct > T.mmPctDanger) add('bad', '维持保证金 / 权益', fmtNum(mmPct, 2) + '%', '> ' + T.mmPctDanger + '%');
  else if (mmPct > T.mmPctWarn) add('warn', '维持保证金 / 权益', fmtNum(mmPct, 2) + '%', '> ' + T.mmPctWarn + '%');
  else add('ok', '维持保证金 / 权益', fmtNum(mmPct, 2) + '%', '');
  const xOf = n => (n == null || R.equity == null || R.equity <= 0) ? null : n / R.equity;
  const totX = xOf(R.total);
  if (totX == null) add('na', '名义敞口 / 权益（整体）', '不可算', R.incomplete ? '有腿缺 size/mark' : '未取到');
  else if (totX > T.notionalXDanger) add('bad', '名义敞口 / 权益（整体）', fmtNum(totX, 2) + '×', '> ' + T.notionalXDanger + '×');
  else if (totX > T.notionalXWarn) add('warn', '名义敞口 / 权益（整体）', fmtNum(totX, 2) + '×', '> ' + T.notionalXWarn + '×');
  else add('ok', '名义敞口 / 权益（整体）', fmtNum(totX, 2) + '×', '');
  const perTxt = R.perSym.length
    ? R.perSym.map(x => { const k = xOf(x.notional); return esc(x.sym) + ' ' + (k == null ? '不可算' : fmtNum(k, 2) + '×'); }).join(' · ')
    : '不可算（未取到持仓）';
  const worst = ['bad', 'warn', 'na', 'ok'].find(l => items.some(i => i.level === l)) || 'ok';
  let h = '<div class="riskbar lv-' + worst + (AGE.stale ? ' stale' : '') + '">' +
    '<div class="rbhead"><b>风险（只展示 · 不含任何交易动作）</b>' +
    '<span class="miss">阈值：可用&lt;0 / IM÷权益&gt;' + T.imPctDanger + '% / MM÷权益&gt;' + T.mmPctWarn + '% / 名义÷权益&gt;' + T.notionalXWarn + '×' +
    (AGE.stale
      ? (R.src === 'live_detail'
        ? ' · ⚠ live_detail 历史快照（' + esc(AGE.txt) + '，非当前；当前账户真值见顶部块）'
        : ' · ⚠ 快照陈旧（' + esc(AGE.txt) + '）')
      : '') + '</span></div><div class="rbitems">';
  for (const it of items) {
    h += '<span class="rbi lv-' + it.level + '"><i>' + esc(it.label) + '</i><b>' + it.value + '</b>' +
      (it.note ? '<em>' + esc(it.note) + '</em>' : '') + '</span>';
  }
  h += '</div><div class="rbnote">各标的名义 / 权益：' + perTxt +
    ' <button class="more" data-more="rdRiskWhy">IM 高 ≠ 即时强平 · 口径</button></div>' +
    '<div class="morebody hidden" id="rdRiskWhy">' +
    '· <b>IM（初始保证金）</b>是「占用」：未实现亏损、挂单、双向持仓的两条腿都会占用它；IM ÷ 权益 &gt; 100% 只说明<b>可用被打满、开不了新仓</b>，不等于马上强平。<br>' +
    '· <b>是否强平看 MM（维持保证金）÷ 权益 与标记价</b>：交易所按 risk-limit 档位算 MM，价格走到强平价才触发。本页<b>不</b>预测强平价；取不到时写「不可算」，不估算。<br>' +
    '· <b>名义 / 权益</b>是杠杆倍数口径（对冲两条腿都算，不净额合并）；它高说明名义敞口大，风险随价格波动放大。<br>' +
    '· 阈值集中在 <code>redesign.js · RD_RISK_T</code>，改一处即可调整；<b>缺数据一律显示「不可算」（灰），不会给绿灯</b>。<br>' +
    '· 数据来源 ' + esc(R.src === 'live.json' ? 'live.json（回退）' : (R.src === 'live_detail' ? 'live_detail.json' : '未取到')) +
    (R.at ? ' · 快照 ' + rdBJ(R.at, 'full') + ' 北京（' + esc(AGE.txt) + '）' : ' · 快照时间未取到') + '</div></div>';
  return h;
}

/* ═══════════════ 5c. 数据覆盖区间（常驻，Codex P1.3）═══════════════
   每标的给：查询起止 / 首末成交 / 覆盖天数（查询天数 vs 有成交天数）/ 缺失区间 / 更新时间。
   ⚠️ 只写**可复算事实**：不写「交易所硬性只保留 N 天」、不写「可回溯深度有限」（原因未知，不归因）。 */
function rdCoverage(b) {
  const sp = rdSpan(b);
  const days = rdPick(b, ['pnl_by_day_90d']);
  const filled = new Set();
  if (Array.isArray(days)) for (const x of days) { const k = rdDayKey(rdPick(x, ['date', 'day', 'd', 't']) || ''); if (k && k !== '?') filled.add(k); }
  const tr = rdPick(b, ['trades_90d']);
  let lastFill = null;
  if (Array.isArray(tr) && tr.length) lastFill = rdPick(tr[tr.length - 1], ['t', 'time']);
  if (!lastFill && filled.size) lastFill = Array.from(filled).sort().slice(-1)[0];
  const miss = [];
  let missOk = filled.size > 0;   /* 没有日桶就**不要**宣称缺失天数（否则会把整个区间说成"无成交"） */
  if (missOk && sp.has && sp.from && sp.to) {
    const a = rdTsMs(rdYmd(sp.from) + 'T00:00:00+08:00');
    const z = rdTsMs(rdYmd(sp.to) + 'T00:00:00+08:00');
    if (a != null && z != null) {
      for (let t = a; t <= z && miss.length < 400; t += 86400000) {
        const k = rdYmd(t);
        if (!filled.has(k)) miss.push(k);
      }
    }
  }
  return { has: sp.has, derived: !!sp.derived, from: sp.from, to: sp.to, qDays: sp.days, symDays: sp.symDays,
           firstFill: sp.firstFill, lastFill: lastFill, filledN: filled.size, miss: missOk ? miss : null };
}
function rdCoverageHtml() {
  const det = RD.ld;
  const bots = (det && Array.isArray(det.bots)) ? det.bots : [];
  const at = det ? rdPick(det, ['updated_at']) : null;
  /* 2026-10-18 hengpan-sync：live_detail 已停更（10-15 13:45）⇒ 覆盖区间不能用它的 08-27→10-15
     冒充当前。优先用 live.json 的逐腿窗口口径（当前真值），旧覆盖只在有明确历史标识时列一行。 */
  const detMs = det ? rdTsMs(at) : null;
  const detAge = detMs == null ? null : Math.max(0, Math.round((Date.now() - detMs) / 1000));
  const detStale = detAge == null || detAge > RD_DETAIL_STALE_SEC;
  const lv = RD.live;
  const span = (lv && Array.isArray(lv.entries) && lv.entries[0] && lv.entries[0].window_span) ? lv.entries[0].window_span : null;
  if (detStale && lv) {
    const liveAt = rdG(lv, 'fetched_at');
    const sym = (lv.entries && lv.entries[0] && lv.entries[0].symbol) ? String(lv.entries[0].symbol) : 'HYPEUSDT';
    let h = '<div class="covbar"><div class="covhead"><b>数据覆盖 · 当前（来源 live.json）</b>' +
      '<span class="miss">截至 ' + (liveAt ? rdBJ(liveAt, 'full') + ' 北京' : '时间未取到') + ' · 逐腿窗口口径 · live_detail 历史覆盖已移入历史折叠</span></div>';
    h += span
      ? ('<div class="covrows"><span class="covrow"><b>' + esc(sym) + '</b>' +
         '<i>窗口</i>' + esc(String(span.from || '--')) + '→' + esc(String(span.to || '--')) + '（' + esc(String(span.days != null ? span.days : '--')) + ' 天）' +
         '<i>首笔成交</i>' + esc(String(span.first_fill_at || '不可算')) +
         '<i>有成交</i>' + (span.symbol_days != null ? esc(String(span.symbol_days)) + ' 天' : '不可算') + '</span></div>')
      : '<div class="covrows"><span class="miss">live.json.entries[0].window_span 未取到（不当作 0 天）</span></div>';
    if (bots.length) h += '<details class="fold"><summary>历史覆盖 live_detail.json（截至 ' + esc(rdStamp(at) + ' 北京') + ' · 已过期 ' + esc(Math.round(detAge / 60) + ' 分钟') + '）</summary>' + bots.map(b => {
      const c = rdCoverage(b);
      const name = String(rdG(b, 'symbol') || rdG(b, 'name') || '—');
      const rng = (c.from && c.to) ? (rdDayLbl(rdDayKey(String(c.from))) + '→' + rdDayLbl(rdDayKey(String(c.to)))) : '不可算';
      return '<span class="covrow"><b>' + esc(name) + '</b><i>查询</i>' + esc(rng) + (c.qDays != null ? '（' + c.qDays + ' 天）' : '') + '<i>末单</i>' + esc(c.lastFill ? rdStamp(c.lastFill) : '不可算') + '</span>';
    }).join('') + '</details>';
    return h + '</div>';
  }
  if (!bots.length) return '<div class="covbar"><b>数据覆盖</b><span class="miss">不可算（live_detail.json 未就绪；当前覆盖请见 live.json 真值块）</span></div>';
  const rows = bots.map(b => {
    const c = rdCoverage(b);
    const name = String(rdG(b, 'symbol') || rdG(b, 'name') || '—');
    const rng = (c.from && c.to) ? (rdDayLbl(rdDayKey(String(c.from))) + '→' + rdDayLbl(rdDayKey(String(c.to)))) : '不可算';
    return '<span class="covrow"><b>' + esc(name) + '</b>' +
      '<i>查询</i>' + esc(rng) + (c.qDays != null ? '（' + c.qDays + ' 天）' : (c.derived ? '（跨度未取到）' : '')) +
      '<i>首单</i>' + esc(c.firstFill ? rdStamp(c.firstFill) : '不可算') +
      '<i>末单</i>' + esc(c.lastFill ? rdStamp(c.lastFill) : '不可算') +
      '<i>有成交</i>' + (c.symDays != null ? c.symDays + ' 天' : (c.filledN ? c.filledN + ' 天（按日桶）' : '不可算')) +
      '<i>缺</i>' + esc(c.miss === null ? '不可算（无日桶）' : (c.miss.length ? (c.miss.length + ' 天无成交') : (c.has ? '无' : '不可算'))) + '</span>';
  }).join('');
  const anyMiss = bots.some(b => { const c = rdCoverage(b); return c.miss && c.miss.length; });
  return '<div class="covbar"><div class="covhead"><b>数据覆盖 · 每标的</b>' +
    '<span class="miss">查询范围 ≠ 有成交天数 · 快照 ' + (at ? rdBJ(at, 'full') + ' 北京' : '不可算') + '</span>' +
    '<button class="more" data-more="rdCovWhy">口径与缺失区间</button></div>' +
    '<div class="covrows">' + rows + '</div>' +
    '<div class="morebody hidden" id="rdCovWhy">' +
    '· <b>查询范围</b>＝采集侧实际装进来的闭区间；<b>有成交天数</b>＝该标的在这个区间里真有成交的天数 —— 两者不是一回事，本页分开列。<br>' +
    '· <b>缺的 N 天</b>＝查询区间内没有该标的成交的日子（按日桶算，不是行情缺失）。' +
    (anyMiss ? '<br>· 缺失日明细：' + bots.map(b => { const c = rdCoverage(b); return (c.miss && c.miss.length) ? (esc(String(rdG(b, 'symbol') || '')) + ' ' + c.miss.slice(0, 10).map(rdDayLbl).join('、') + (c.miss.length > 10 ? ' …' : '')) : null; }).filter(Boolean).join('<br>') : '') + '<br>' +
    '· 采集侧实测：<code>closed-pnl</code> 单次查询跨度上限 7 天（超出报 retCode=10001），数据是分块拼起来的；' +
    '<b>为什么只到起点那天，原因未知 —— 本页不做归因</b>（不写「交易所硬性只保留 N 天」这类未证实说法）。<br>' +
    '· 采集侧原始说明（含 first_fill_at 与 note）：' +
    bots.map(b => { const sp = rdPick(b, ['window_span']); const note = sp ? rdPick(sp, ['note']) : null;
      return note ? '<div style="margin-top:6px;">· <b>' + esc(String(rdG(b, 'symbol') || '')) + '</b>：' + esc(String(note)) + '</div>' : ''; }).join('') +
    '</div></div>';
}

/* ═══════════════ 5. 渲染 · 总览 ═══════════════ */
function rdRenderOverview() {
  const d = RD.d, lv = (d && d.live) || null;
  const list = d ? rdRankList(d) : [];
  const shadows = list.filter(x => x.group === 'shadow' || x.group === 'doubt');
  const liveN = list.filter(x => x.group === 'live').length;
  const LK = rdLiveKpis();
  const AGE = rdKpiAge(LK);

  const eq = $('ovEquity');
  if (eq) {
    if (LK.equity != null) {
      eq.innerHTML = fmtNum(LK.equity, 2) + '<span class="u">U</span>';
      eq.className = 'kv';
      eq.title = LK.basis;
    } else { eq.textContent = '--'; eq.title = '本次未取到'; }
  }
  const eqS = $('ovEquityS');
  if (eqS) {
    eqS.className = 'ks' + (AGE.stale ? ' warn' : '');
    eqS.innerHTML = LK.at == null
      ? '<span class="miss">本次未取到：数据截止时间</span>'
      : ('Bybit 只读 · 截止 ' + rdBJ(LK.at, 'hm') + ' 北京 · <b>' + esc(AGE.txt) + '</b>' +
         (AGE.stale
           ? (AGE.future
             ? ' <span class="stale">⚠ 时间戳在未来（时钟偏差 ' + Math.abs(AGE.signedSec) + ' 秒）</span>'
             : ' <span class="stale">⚠ 数据陈旧（> ' + Math.round(RD_STALE_SEC / 60) + ' 分钟）</span>')
           : '') +
         ' <span class="miss">（数据源=' + (LK.src === 'live' ? 'live.json' + (LK.detStaleSec == null ? '' : '；live_detail.json 已过期 ' + Math.round(LK.detStaleSec / 60) + ' 分钟') : (LK.src === 'live_detail' ? 'live_detail.json' : '未取到')) + '）</span>');
  }

  const rz = $('ovRealized');
  if (rz) {
    if (LK.realized != null) {
      rz.innerHTML = (LK.realized >= 0 ? '+' : '') + fmtNum(LK.realized, 2) + '<span class="u">U</span>';
      rz.className = 'kv ' + cls(LK.realized);
      rz.title = LK.basis;
    } else { rz.textContent = '--'; rz.title = '本次未取到'; }
  }
  const rzS = $('ovRealizedS');
  if (rzS) {
    rzS.className = 'ks';
    rzS.innerHTML = LK.realized == null
      ? '<span class="miss">本次未取到：live_detail.json 与 live.json 都读不到</span>'
      : rdKpiRunHtml(LK);
  }

  const t1 = shadows[0];
  const top = $('ovTop1');
  if (top) {
    if (t1) {
      top.innerHTML = (t1.doubt ? '⚠ ' : '') + pct(t1.ret);
      top.className = 'kv ' + (t1.doubt ? 'warn' : cls(t1.ret));
    } else { top.textContent = '--'; }
  }
  const topS = $('ovTop1S');
  if (topS) topS.textContent = t1 ? ('模拟账本 · ' + (t1.doubt ? '存疑不可比' : esc(t1.name))) : '模拟账本';
  const candsAll = rdTop3(d);
  const cands = rdPromoCands(d);
  const q = $('ovQueue');
  const qS2 = $('ovQueueS');
  const done = cands.filter(c => RD.queue[c.key]).length;   /* ← 必须在 if 外面声明：下面 qS2 也要用 */
  if (q) {
    q.innerHTML = cands.length ? String(cands.length) : '0';
    q.className = 'kv';
    q.title = cands.length ? ('待放行：' + cands.map(c => c.name).join('、')) : '队列为空';
  }
  if (qS2) {
    qS2.className = 'ks';
    qS2.innerHTML = '需你放行 · 已登记 ' + done + ' 个' + (rdGateOpen() ? '' : ' · 闸门未开') +
      (candsAll.length > cands.length ? '（前三里 ' + (candsAll.length - cands.length) + ' 个亏损，不构成理由）' : '') +
      (cands.length ? ' · <button class="more" data-more="ovQDet">看名单</button>' +
        '<div class="morebody hidden" id="ovQDet">' + cands.map((c, i) =>
          '<div>· ' + (i + 1) + '. <b>' + esc(c.name) + '</b> ｜ ' + pct(c.ret) +
          (RD.queue[c.key] ? ' ｜ <span class="miss">已登记</span>' : '') + '</div>').join('') +
        '<div class="miss">规则：影子榜前三名自动进队列（零点击）；真上实盘要你点「放行上实盘」，本轮只登记不下单。</div></div>'
        : '');
  }
  const qS = $('ovQueueS');

  /* 四步动线状态 */
  const shopItems = (RD.shop && RD.shop.items) || [];
  const pend = shopItems.filter(it => ['待处理', '已收到', '开发中'].indexOf(it.status) >= 0).length;
  const candN = (d && d.candidates || []).length;
  const runN = (d && ((d.books || []).length + (d.horses || []).length)) || 0;
  const setTxt = (id, t) => { const e = $(id); if (e) e.textContent = t; };
  setTxt('step1', shopItems.length ? ('已提交 ' + shopItems.length + ' 条' + (pend ? ' · ' + pend + ' 待处理' : '')) : '还没写过');
  setTxt('step2', candN ? ('候选 ' + candN + ' 个') : '--');
  setTxt('step3', runN ? ('在跑 ' + runN + ' 个 · 零点击自动登记') : '暂无在跑');
  setTxt('step4', cands.length ? ('待放行 ' + cands.filter(c => !RD.queue[c.key]).length + ' 个 · 需你点') : '--');
  for (const [i, on] of [[1, shopItems.length > 0], [2, candN > 0], [3, runN > 0], [4, cands.length > 0 && cands.every(c => RD.queue[c.key])]]) {
    const el = $('flow4') && $('flow4').querySelectorAll('.step')[i - 1];
    if (el) el.classList.toggle('done', !!on);
  }

  /* 闸门一行 */
  const gl = $('gateLine');
  if (gl) {
    const ok = rdGateOpen();
    gl.className = 'gline' + (ok ? ' ok' : '');
    gl.innerHTML = '<i class="gw"></i><b>' + (ok ? 'PnL 验证闸门：已开' : 'PnL 验证闸门未开') + '</b>' +
      '<span class="gd">' + (ok ? '影子绩效可信' : '影子名次不构成晋级依据 · 实盘只走「你放行」这一步') + '</span>' +
      '<button class="more" data-more="ovGateDet">依据</button>' +
      '<div class="morebody hidden" id="ovGateDet" style="flex:1 1 100%;">' +
      '<b>为什么没开</b>：影子盘计价口径没被独立验证 —— 模拟器无强平、无保证金检查、越界持仓被带到新品种、无滑点项；曾修过穿越次数平方缺陷。' +
      '闸门真值（唯一真源 <code>shadow.json.pnl_validated</code>）＝ <code>' + String(!!(d && rdBool(d.pnl_validated))) + '</code>' +
      (d && d.pnl_validated === undefined ? '（<span class="miss">字段缺失 ⇒ 按 fail-closed 判为关</span>）' : '') + '。<br>' +
      '<b>对动线的影响</b>：前三名只进「待上实盘」队列，<b>不会自动下单</b>；AUTO_LIVE_PROMOTE 开关被代码锁死。</div>';
  }

  /* 实盘条目 —— 🔴 2026-10-12 改（QUANT-LIVE-PREP-20261012 · D①/D④）：
     ① 原来只印「本腿收益率」，而账户级真值在页面顶部另一块 ⇒ 主人易把单腿数当账户数；
        ⇒ 现在**同一行并列**印「账户级」与「本腿」两个数，**各自带口径标签**（title）。
     ② 本腿数的分子分母已改为同口径（见 live_rank_fetch.py D④），不再与账户级分母混用。 */
  const rows = $('ovLiveRows');
  if (rows) {
    const es = (lv && lv.entries) || [];
    rows.innerHTML = es.length ? es.map(e => {
      const 账户级 = (e.account_ret_pct === undefined || e.account_ret_pct === null)
        ? null : Number(e.account_ret_pct);
      return '<div class="rankrow live" style="grid-template-columns:minmax(0,1fr) auto auto auto;">' +
      '<div class="mid"><div class="nm">' + esc(e.name) + '</div>' +
        '<div class="mt">' + esc(e.symbol) + ' · ' + (e.lev || '?') + 'x · ' + e.trades + ' 笔 · ' +
        rdBJ(e.started_at) + ' 北京起</div>' +
        '<div class="tags"><span class="badge g"><i class="dotb g"></i>真金</span>' +
        '<span class="badge n">未实现 ' + fmtNum(e.unrealized_now, 2) + 'U</span></div></div>' +
      '<div class="ret acct ' + (账户级 === null ? 'miss' : cls(账户级)) + '" title="' +
        esc(e.account_ret_basis || '账户级：总权益变动率（含已实现＋未实现＋划转抵扣）') + '">' +
        (账户级 === null ? '账户级 --' : '账户级 ' + pct(账户级)) + '</div>' +
      '<div class="ret leg ' + cls(e.ret_pct) + '" title="' +
        esc(e.ret_pct_basis || '本腿净额 ÷ 本腿窗口账面权益（逐腿口径）') + '">' +
        '本腿 ' + pct(e.ret_pct) + '</div>' +
      '<div class="pnl">' + (Number(e.pnl_u) >= 0 ? '+' : '') + fmtNum(e.pnl_u, 2) + ' U</div>' +
      '</div>'; }).join('') : '<span class="loading">live.json 未同步（实盘条目读不到）</span>';
  }
  const ola = $('ovLiveAge');
  if (ola) {
    /* 实盘卡片角标与 KPI 用同一个截止时间与陈旧阈值（>10 分钟变琥珀） */
    const kk = rdLiveKpis(), aa = rdKpiAge(kk);
    if (kk.at != null) {
      ola.className = 'chip ' + (aa.stale ? 'warn' : 'on');
      ola.textContent = '数据截止 ' + rdBJ(kk.at, 'full') + ' 北京 · ' + aa.txt + (aa.stale ? ' ⚠ 陈旧' : '');
    } else {
      ola.className = 'chip warn';
      ola.textContent = '数据截止时间本次未取到';
    }
  }
  const ols = $('ovLiveSrc');
  if (ols) ols.innerHTML = lv ? ('数据来源：Bybit 只读接口（ssh vps）→ <code>live_detail.json</code>（KPI 主源，口径＝<b>可查区间</b>；' +
    '仅当它 <= ' + Math.round(RD_DETAIL_STALE_SEC / 60) + ' 分钟新鲜时才生效，否则回退 <code>live.json</code> 并标陈旧）；' +
    '<code>live.json</code> 仅作回退 —— 由 D 盘只读采集循环刷新（60s；连续 3 分钟未成功即显示过期）。实盘＝交易所真值，影子＝本机模拟账本，两者不可直接比较。<br>' +
    '样本口径：采集侧实测 <code>closed-pnl</code> 单次跨度上限 7 天（超出报 retCode=10001），数据是分块拼起来的 ⇒ 卡片上的区间就是<b>全部查询区间</b>；' +
    '两台样本长度不同，各自起止见「看名单」。') : '';

  /* 在跑的马（影子侧；实盘条目在上面的「实盘（真金）」卡里，不重复摆放） */
  const run = $('ovRunners');
  if (run && d) {
    const items = [];
    for (const b of (d.books || [])) { if (rdIsHidden(b.name)) continue; items.push({ n: b.name, s: b.symbol, r: b.ret_pct, k: '影子' }); }
    for (const h of (d.horses || [])) { if (h && h.horse) items.push({ n: h.horse, s: (h.pos && h.pos[0] && h.pos[0].sym) || '—', r: h.ret_pct, k: '影子' }); }
    items.sort((a, b) => (b.r == null ? -1e9 : b.r) - (a.r == null ? -1e9 : a.r));
    run.innerHTML = items.length ? items.map(x =>
      '<div class="rankrow" style="grid-template-columns:minmax(0,1fr) auto auto;">' +
      '<div class="mid"><div class="nm">' + esc(x.n) + '</div><div class="mt">' + esc(x.s) + ' · ' + esc(x.k) + '</div></div>' +
      '<div class="ret" style="font-size:18px;min-width:96px;">' + pct(x.r) + '</div>' +
      '<div class="tags">' + (x.k === '实盘' ? '<span class="badge g">真金</span>' : '<span class="badge n">模拟</span>') + '</div>' +
      '</div>').join('') : '<span class="loading">影子盘暂无在跑的马</span>';
    const rets = run.querySelectorAll('.ret');
    items.forEach((x, i) => { if (rets[i]) rets[i].className = 'ret ' + cls(x.r); });
  }
  const osa = $('ovShadowAge');
  if (osa && d) {
    const age = Date.now() / 1000 - (d.synced_at || 0);
    osa.className = 'chip ' + (d.ok && age < 1200 ? 'on' : 'warn');
    osa.textContent = 'VPS runner 同步 ' + rdBJ(d.synced_at, 'hm') + ' 北京（' + rdAge(d.synced_at) + '）';
  }
  rdMountTop();   /* 每次刷新都重算动线带/风险条/覆盖提示（挂载点固定，不再移动节点） */
}

/* ═══════════════ 6. 渲染 · 晋级队列 + 联锁 ═══════════════ */
function rdRenderPromote() {
  const d = RD.d;
  const cands = rdTop3(d);
  const releasable = rdPromoCands(d);
  const pb = $('promoteBody');
  if (pb) {
    pb.innerHTML = cands.length ? cands.map((c, i) => {
      const losing = !(c.ret != null && c.ret > 0);
      return '<div class="prow' + (c.doubt || losing ? ' doubt' : '') + '">' +
      '<div class="rk" style="font-family:var(--mono);font-size:19px;font-weight:700;color:' + (i === 0 ? 'var(--yellow)' : 'var(--faint)') + ';text-align:center;">' + (i + 1) + '</div>' +
      '<div><div class="nm" style="font-size:14.5px;font-weight:600;">' + esc(c.name) +
        (RD.queue[c.key] ? ' <span class="badge n">已登记</span>' : '') + '</div>' +
        '<div class="mt" style="font-size:11px;color:var(--faint);margin-top:4px;">' + esc(c.symbol || '') + ' · ' + esc(c.kind) + ' · ' + esc(c.sub || '') + '</div>' +
        (c.doubt ? '<div class="mt" style="font-size:11px;color:var(--amber);margin-top:4px;"><i class="dotb a"></i> 统计存疑 · 名次不可比，不建议放行</div>' : '') +
        (losing ? '<div class="mt" style="font-size:11px;color:var(--red);margin-top:4px;"><i class="dotb r"></i> 前三但亏损 → 不构成晋级理由，<b>不占放行名额</b></div>' : '') +
      '</div>' +
      '<div class="ret ' + cls(c.ret) + '">' + (c.doubt ? '⚠ ' : '') + pct(c.ret) + '</div>' +
      '</div>';
    }).join('') : '<span class="loading">影子榜还没有可晋级的条目</span>';
    pb.insertAdjacentHTML('beforeend',
      '<div class="disc" style="margin-top:4px;">规则：影子榜前三名<b>自动进这个队列</b>（零点击）。' +
      '可放行的只有「前三 <b>且</b> 正收益」的 ' + releasable.length + ' 个 —— 沿用原榜判据（亏钱的马排进前三，也不构成晋级理由）；' +
      '它们仍停在「待上实盘」，不点下面的主按钮不会进入任何上实盘流程。</div>');
  }
  const pa = $('promoteAge');
  if (pa && d) { pa.className = 'chip gray'; pa.textContent = '榜单同步 ' + rdBJ(d.synced_at, 'hm') + ' 北京'; }
  rdRenderLock();
  const qb = $('queueBody');
  if (qb) {
    const ks = Object.keys(RD.queue);
    qb.innerHTML = ks.length ? ks.map(k => {
      const q = RD.queue[k];
      return '<div class="qrow"><i class="dotb g"></i><span class="qn">' + esc(q.name) + '</span>' +
        '<span class="badge n">' + pct(q.ret) + '</span>' +
        (q.doubt ? '<span class="badge y">放行时已标存疑</span>' : '') +
        '<span class="badge n">仅登记 · 未下单</span>' +
        '<span class="qt">' + rdBJ(q.ts, 'full') + ' 北京</span></div>';
    }).join('') : '<span class="empty">暂无 —— 在上面的卡里点「放行上实盘」</span>';
  }
  const ns = $('nextSteps');
  if (ns) {
    ns.innerHTML =
      '<div class="ni"><span class="no">1</span><div><b>接通下单通路（本轮不做）</b>：需要在 <code>live/</code> 下新增一个「实盘执行器」，' +
        '只接受白名单策略 ID ＋ 硬性风控（单笔上限、日亏上限、最大杠杆），并且必须由主人逐次拍板。谁拍板：主人。</div></div>' +
      '<div class="ni"><span class="no">2</span><div><b>先开闸门</b>：独立验证影子盘计价口径（补强平/保证金/仓位上限/滑点），' +
        '验证通过后把 <code>shadow.json.pnl_validated</code> 置 true —— 那一刻 AUTO_LIVE_PROMOTE 才允许点亮。</div></div>' +
      '<div class="ni"><span class="no">3</span><div><b>预留接口</b>：前端登记簿现在只写浏览器本地（<code>localStorage: ' + LS_QUEUE + '</code>）。' +
        '要变成真登记，需后端接一个只写不执行的 <code>POST /api/live/queue</code>（落 <code>dashboard/live_queue.json</code>），由主人拍板后实施。</div></div>';
  }
  const ts = $('promoteTabTs');
  if (ts) { const n = Object.keys(RD.queue).length; ts.textContent = n ? String(n) : ''; }
}
function rdRenderLock() {
  const open = rdGateOpen();
  const tg = $('autoLiveToggle');
  if (tg) {
    tg.setAttribute('aria-checked', RD.autoLive ? 'true' : 'false');
    tg.disabled = !open;
    tg.onclick = () => { if (!open) return; setAutoLive(!RD.autoLive); };
  }
  const st = $('lockSwitchState');
  if (st) { st.textContent = RD.autoLive ? 'ON' : 'OFF'; st.className = RD.autoLive ? 'on' : ''; }
  const rs = $('lockReason');
  if (rs) rs.textContent = open ? '闸门已开 —— 仍需你手动点亮' : 'PnL 闸门未开 → 开关被锁死（点不动）';
  const ld = $('lockDetail');
  if (ld) {
    ld.innerHTML =
      '<b>默认值</b>：AUTO_LIVE_PROMOTE = <code>OFF</code>（localStorage <code>' + LS_AUTO + '</code>，每次加载都重新校验）。<br>' +
      '<b>硬拦位置</b>：<code>' + HARD_GATE.WHERE + '</code>。<br>' +
      '<b>为什么现在关着</b>：' + HARD_GATE.REASON + '。<br>' +
      '<b>打开的条件（数据级 · 单一真源）</b>：<code>shadow.json.pnl_validated === true</code> ' +
      '—— 2026-10-12 起**只有这一个真源**（前端原有的独立常量已删，见 N1 双源缺陷）。' +
      '数据侧置 true ⇒ 闸门即开；置 false / 取不到 / 值认不出 ⇒ 一律关（fail-closed）。<br>' +
      '<b>主按钮的边界</b>：就算点亮了开关、就算点了「放行上实盘」，这一步也只做<b>登记/排队</b> —— ' +
      '真正的下单通路本轮<b>没有实现</b>，前端里没有任何下单调用。';
  }
  const rb = $('releaseBtn');
  if (rb) {
    const cands = rdPromoCands(RD.d);
    const left = cands.filter(c => !RD.queue[c.key]).length;
    rb.disabled = !cands.length || left === 0;
    rb.textContent = cands.length ? (left ? '放行上实盘（' + left + ' 个）' : '已全部登记') : '放行上实盘';
    rb.onclick = () => rdRelease();
  }
}

/* ═══════════════ 6c. 渲染 · 实盘详情（live_detail.v1 · 缺文件必须优雅降级）═══════════════
   数据由另一路产出（写 dashboard/live_detail.json），前端**只管渲染**：
   文件不在 / 字段缺失 / schema 不认 —— 一律显示「详情数据未就绪」，不猜数、不报错、不空白崩。 */
function rdG(o, path) {                    /* 安全取值：中间任何一段缺失都返回 undefined，不抛错 */
  let cur = o;
  for (const k of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
function rdNum(v) {
  /* ⚠️ 必须显式挡掉 null/undefined/空串：Number(null) === 0，
     否则 profit_factor: null 会被画成「盈亏比 0」、max_dd 缺失会变「0」—— 把"没取到"说成"是 0"。 */
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
/* 布尔取值（2026-10-12 加 · QUANT-LIVE-PREP-20261012 · D/N1）：
   闸门一类字段来自 JSON，可能是 bool、也可能是字符串。**只认明确写明的真**；
   其余（含缺字段、'false'、'0'、'no'、任意别的串）**一律 false** ——
   安全联锁方向 fail-closed：认不出就不开。 */
function rdBool(v) {
  if (v === true) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }
  if (v === 1) return true;
  return false;
}
/* 条数：契约里 trades 写的是个数，但**采集侧实测给的是数组**（逐笔明细）。
   两种都认 —— 数组取长度，数字原样用，缺了显示 --。 */
function rdCount(v) {
  if (Array.isArray(v)) return String(v.length);
  const n = rdNum(v);
  return n == null ? '--' : String(n);
}
function rdMoney(v, d) { const n = rdNum(v); return n == null ? '--' : (n >= 0 ? '+' : '') + n.toFixed(d == null ? 2 : d) + '<span class="u">U</span>'; }
/* 时间戳：契约写的是「北京时间 ISO」，但采集侧实测会带别的偏移（本机抓到 +11:00）。
   一律按偏移换算到 +08:00 再显示，标签才敢写「北京」；不是时间串就原样返回。 */
function rdStamp(v) {
  if (v == null || v === '') return '--';
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return s;
  const ss = m[6] || '00';
  const off = /([+-])(\d{2}):?(\d{2})\s*$/.exec(s);
  if (!off) return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + ss;
  const sign = off[1] === '-' ? -1 : 1;
  const offMin = sign * (parseInt(off[2], 10) * 60 + parseInt(off[3], 10));
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +ss) - offMin * 60000 + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + rdPad(d.getUTCMonth() + 1) + '-' + rdPad(d.getUTCDate()) + ' ' +
    rdPad(d.getUTCHours()) + ':' + rdPad(d.getUTCMinutes()) + ':' + rdPad(d.getUTCSeconds());
}
function rdStampHM(v) { const m = /(\d{2}:\d{2}(?::\d{2})?)/.exec(rdStamp(v)); return m ? m[1] : rdStamp(v); }
/* 方向：契约里可能是 buy/sell，也可能是 long/short（实测两种都出现过） */
function rdSide(s) {
  const k = String(s == null ? '' : s).toLowerCase();
  if (k === 'buy' || k === 'long') return '多';
  if (k === 'sell' || k === 'short') return '空';
  return '—';
}
function rdSideCls(s) { const k = String(s == null ? '' : s).toLowerCase(); return (k === 'buy' || k === 'long') ? 'gain' : ((k === 'sell' || k === 'short') ? 'loss' : 'flat'); }
function rdShort(t, n) {
  const s = String(t == null ? '' : t);
  const head = s.split(/[（(：:，,。]/)[0].trim() || s;
  const lim = n || 22;
  return head.length > lim ? head.slice(0, lim) + '…' : head;
}
function rdU(v, d) {                        /* 数字 + 单位，缺失显示 -- */
  const n = rdNum(v);
  return n == null ? '--' : fmtNum(n, d == null ? 2 : d) + '<span class="u">U</span>';
}
function rdSpark(curve) {                   /* 极简迷你曲线（内联 SVG，无依赖） */
  const pts = (Array.isArray(curve) ? curve : []).map(p => rdNum(p && p.cum_realized)).filter(v => v != null);
  if (pts.length < 2) return '<div class="sparkempty">曲线不足 2 个点 —— 画不出来</div>';
  const w = 280, h = 46;
  const min = Math.min.apply(null, pts), max = Math.max.apply(null, pts), rng = (max - min) || 1;
  const step = w / (pts.length - 1);
  const xy = pts.map((v, i) => [i * step, h - ((v - min) / rng) * (h - 8) - 4]);
  const path = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const col = pts[pts.length - 1] >= pts[0] ? '#30d158' : '#ff453a';
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<path d="' + path + ' L ' + w + ' ' + h + ' L 0 ' + h + ' Z" fill="' + col + '" opacity="0.10"/>' +
    '<path d="' + path + '" fill="none" stroke="' + col + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
    '</svg><div class="sparkmeta">' + pts.length + ' 个点 · ' + fmtNum(min, 2) + ' ~ ' + fmtNum(max, 2) + ' U</div>';
}
/* 取不到的东西，一律给一句短标题（台面上必须列全，长句折进明细） */
function rdUnaTitle(s) {
  let t = String(s == null ? '' : s).split(/[（(：:]/)[0].trim();
  t = t.replace(/\s*liq\s*$/i, '').replace(/的/g, '');
  const MAP = [
    [/历史权益曲线/, '历史权益曲线'],
    [/进程级归因|标的级/, '进程级归因'],
    [/资金费.*归因/, '资金费单笔归因'],
    [/强平价/, '强平价'],
    [/单腿(持仓)?快照/, '单腿快照'],
    [/窗口外|更早成交/, '窗口外更早成交'],
    [/实例自记账/, '实例自记账 own'],
  ];
  for (const m of MAP) if (m[0].test(t)) return m[1];
  return t.length > 14 ? t.slice(0, 14) + '…' : (t || '未说明');
}
function rdPosTable(legs) {
  if (!legs.length) return '<div class="empty">没有腿</div>';
  return '<table class="tatable"><thead><tr><th>标的</th><th>方向</th><th>张数</th><th>均价</th><th>标记</th><th>强平</th><th>保证金</th><th>未实现</th><th>杠杆</th></tr></thead><tbody>' +
    legs.map(x => '<tr><td>' + esc(x.symbol || '--') + '</td>' +
      '<td class="' + rdSideCls(x.side) + '">' + rdSide(x.side) + '</td>' +
      '<td class="mono">' + (x.size == null ? '--' : fmtNum(x.size, 2)) + '</td>' +
      '<td class="mono">' + (x.avg == null ? '--' : fmtPrice(x.avg)) + '</td>' +
      '<td class="mono">' + (x.mark == null ? '--' : fmtPrice(x.mark)) + '</td>' +
      '<td class="mono">' + (x.liq == null || x.liq === '' ? '--' : fmtPrice(x.liq)) + '</td>' +
      '<td class="mono">' + (x.im == null ? '--' : fmtNum(x.im, 4)) + '</td>' +
      '<td class="mono ' + cls(x.upnl) + '">' + (x.upnl == null ? '--' : fmtNum(x.upnl, 4)) + '</td>' +
      '<td class="mono">' + (x.lev == null ? '--' : esc(String(x.lev)) + 'x') + '</td></tr>').join('') + '</tbody></table>';
}
function rdUnavail(list, i, notes) {
  if (!Array.isArray(list) || !list.length) return '';
  /* 主人令（2026-10-07）：取不到的东西**必须显示出来**，不许当它不存在。
     处置：台面上把 6 条**短标题全列**（一行读完），上百字的长句折进「逐条明细」。 */
  const titles = list.map(rdUnaTitle);
  let h = '<div class="unavail"><b>本次取不到 ' + list.length + ' 项：</b>' + esc(titles.join(' / ')) +
    '<button class="more" data-more="una' + i + '">逐条明细</button></div>' +
    '<div class="morebody hidden" id="una' + i + '">' +
    list.map(x => '<div>· ' + esc(String(x)) + '</div>').join('');
  if (Array.isArray(notes) && notes.length) {
    h += '<div style="margin-top:12px;"><b>口径备注（notes）</b></div>' +
      notes.map(x => '<div>· ' + esc(String(x)) + '</div>').join('');
  }
  return h + '</div>';
}
function rdOrdersTable(o) {
  if (!o.length) return '<div class="empty">当前没有挂单</div>';
  return '<table class="tatable"><thead><tr><th>方向</th><th>价</th><th>量</th><th>只减仓</th><th>下单时间</th><th>id</th></tr></thead><tbody>' +
    o.map(x => '<tr><td class="' + rdSideCls(x.side) + '">' + rdSide(x.side) + '</td>' +
      '<td class="mono">' + (x.price == null ? '--' : fmtPrice(x.price)) + '</td>' +
      '<td class="mono">' + (x.qty == null ? '--' : fmtNum(x.qty, 4)) + '</td>' +
      '<td>' + (x.reduce_only ? '是' : '否') + '</td>' +
      '<td class="mono" style="color:var(--faint);font-size:10.5px;">' + rdStamp(x.created) + '</td>' +
      '<td class="mono" style="color:var(--faint);font-size:10px;">' + esc(x.id || '--') + '</td></tr>').join('') + '</tbody></table>';
}
function rdTradesTable(t) {
  if (!t.length) return '<div class="empty">暂无成交记录</div>';
  return '<table class="tatable"><thead><tr><th>时间</th><th>方向</th><th>量</th><th>开</th><th>平</th><th>已实现</th><th>手续费</th></tr></thead><tbody>' +
    t.map(x => '<tr><td class="mono" style="font-size:10.5px;color:var(--faint);">' + rdStamp(x.t) + '</td>' +
      '<td class="' + rdSideCls(x.side) + '">' + rdSide(x.side) + '</td>' +
      '<td class="mono">' + (x.qty == null ? '--' : fmtNum(x.qty, 4)) + '</td>' +
      '<td class="mono">' + (x.entry == null ? '--' : fmtPrice(x.entry)) + '</td>' +
      '<td class="mono">' + (x.exit == null ? '--' : fmtPrice(x.exit)) + '</td>' +
      '<td class="mono ' + cls(x.closed_pnl) + '">' + (x.closed_pnl == null ? '--' : fmtNum(x.closed_pnl, 4)) + '</td>' +
      '<td class="mono" style="color:var(--dim);">' + (x.fee == null ? '--' : fmtNum(x.fee, 5)) + '</td></tr>').join('') + '</tbody></table>';
}
function rdBotCard(b, i) {
  const pos = rdG(b, 'position') || {}, proc = rdG(b, 'process') || {};
  const orders = Array.isArray(rdG(b, 'open_orders')) ? b.open_orders : [];
  const trades = Array.isArray(rdG(b, 'trades')) ? b.trades : [];   /* trades 可能是数组（实测）也可能是个数 */
  const tradeN = rdCount(rdG(b, 'trades'));
  const legs = Array.isArray(rdG(b, 'positions_all')) ? b.positions_all : [];   /* schema 外的第三个键：全部腿 */
  const notes = Array.isArray(rdG(b, 'notes')) ? b.notes : [];                 /* schema 外的第四个键：口径备注 */
  const days = rdDays(b);                                          /* 日粒度（新键优先，否则由 trades 归集） */
  const ret = rdNum(rdG(b, 'return_pct')), rn = rdNum(rdG(b, 'realized_net')), up = rdNum(rdG(b, 'unrealized'));
  const side = pos.side ? rdSide(pos.side) : '无持仓';
  /* 快照 vs 历史：position / unrealized / open_orders 是取数那一刻的快照（实测两次运行之间
     ENA 未实现从 −0.667 变到 −0.442），必须显式标「快照 · 时间」，且不画成曲线、不与历史并列。
     只有 trades / pnl_curve(_net) 是历史序列。 */
  const snapAt = rdStampHM(rdG(RD.ld, 'updated_at'));
  /* 曲线优先用 pnl_curve_net（把资金费并进同一条时间线，末点 == realized_net，比 pnl_curve 真实） */
  const netCurve = rdG(b, 'pnl_curve_net'), rawCurve = rdG(b, 'pnl_curve');
  const curve = (Array.isArray(netCurve) && netCurve.length) ? netCurve : rawCurve;
  const curveName = (Array.isArray(netCurve) && netCurve.length) ? '净曲线（含资金费）' : '已实现曲线（不含资金费）';
  return '<div class="livebot">' +
    '<div class="lbh"><div class="lbn">' + esc(rdG(b, 'name') || '未命名') + '</div>' +
      '<div class="lbs">' + esc(rdG(b, 'symbol') || '—') +
        (proc.pid != null ? ' · pid ' + esc(String(proc.pid)) : '') +
        (proc.script ? ' · ' + esc(String(proc.script)) : '') + '</div></div>' +
    rdPeriodsHtml(b, days) +
    '<div class="lbnums">' +
      '<div><div class="kl">收益率</div><div class="kv ' + cls(ret) + '">' + (ret == null ? '--' : pct(ret)) + '</div></div>' +
      '<div><div class="kl">累计净额</div><div class="kv ' + cls(rn) + '">' + rdMoney(rn, 4) + '</div></div>' +
      '<div><div class="kl">未实现（快照）</div><div class="kv kvs ' + cls(up) + '">' +
        (up == null ? '--' : (up >= 0 ? '+' : '') + up.toFixed(4) + '<span class="u">U</span>') + '</div></div>' +
      '<div><div class="kl">笔数</div><div class="kv kvs">' + tradeN + '</div></div>' +
    '</div>' +
    '<div class="lbsnap">持仓 / 未实现 / 挂单 = 取数那一刻的<b>快照</b>（' + esc(snapAt) + ' 北京）；trades 与「' + esc(curveName) + '」才是历史序列</div>' +
    '<div class="lbmid">' +
      row('持仓（快照）', side + (pos.size != null ? ' ' + fmtNum(pos.size, 2) + ' 张' : ''), 'flat') +
      row('均价 / 标记', (pos.avg == null ? '--' : fmtPrice(pos.avg)) + ' / ' + (pos.mark == null ? '--' : fmtPrice(pos.mark)), 'flat') +
      row('清算 / 杠杆', (pos.liq == null || pos.liq === '' ? '--' : fmtPrice(pos.liq)) + ' / ' + (pos.lev == null ? '--' : esc(String(pos.lev)) + 'x'), 'flat') +
      row('保证金', rdU(pos.im, 4), 'flat') +
    '</div>' +
    '<div class="lbcurve">' + rdSpark(curve) + '</div>' +
    rdDayChartHtml(days) + rdStatsHtml(b, i) + rdFeeHtml(b, i) +
    '<div class="lbfoot">起点本金 ' + rdU(rdG(b, 'start_equity'), 2) +
      (rdG(b, 'start_equity_at') ? '（' + esc(String(rdG(b, 'start_equity_at'))) + '）' : '') +
      ' · 资金费 ' + rdU(rdG(b, 'funding'), 4) +
      ' · 阶梯 第 ' + (rdG(b, 'ladder.rung') == null ? '--' : esc(String(rdG(b, 'ladder.rung')))) +
      ' 档 / 基准价 ' + (rdNum(rdG(b, 'ladder.base')) == null ? '--' : fmtPrice(rdG(b, 'ladder.base'))) +
      ' · 来源 ' + esc(rdShort(rdG(RD.ld, 'source'), 12)) + '</div>' +
    rdUnavail(rdG(b, 'unavailable'), i, notes) +
    rdExecHtml(b) +
    '<div class="lbfolds">' +
      '<button class="more" data-more="ldord' + i + '">挂单（快照） ' + orders.length + '</button>' +
      '<button class="more" data-more="ldtrd' + i + '">成交（历史） ' + tradeN + '</button>' +
      (legs.length ? '<button class="more" data-more="ldleg' + i + '">全部腿 ' + legs.length + '</button>' : '') +
      '<button class="more" data-more="ldoh' + i + '">历史委托</button>' +
      '<button class="more" data-more="ldtx' + i + '">账户流水</button>' +
      '<button class="more" data-more="ldst' + i + '">bot 状态</button>' +
      '<button class="more" data-more="ldlg' + i + '">日志</button>' +
    '</div>' +
    '<div class="morebody hidden" id="ldord' + i + '">' + rdOrdersTable(orders) + '</div>' +
    '<div class="morebody hidden" id="ldtrd' + i + '">' + rdTradesTable(trades) + '</div>' +
    (legs.length ? '<div class="morebody hidden" id="ldleg' + i + '">' + rdPosTable(legs) +
      '<div class="disc" style="margin-top:8px;">positions_all = 交易所返回的<b>全部腿</b>（不做净额合并、不估算）；' +
      '上面「持仓」显示的只是名义最大的那条主腿。同样是<b>快照</b>。</div></div>' : '') +
    '<div class="morebody hidden" id="ldoh' + i + '">' +
      '<div class="blknote">orders_history · 含已撤单 · 快照 ' + rdStampHM(rdG(RD.ld, 'updated_at')) + ' 北京</div>' +
      rdGenericTable(rdPick(b, ['orders_history', 'order_history', 'orders']), [
        { k: ['created', 't', 'time', 'updated'], label: '时间', fmt: 'time' },
        { k: ['symbol', 'sym'], label: '标的' },
        { k: ['side'], label: '方向', fmt: 'side' },
        { k: ['type', 'order_type'], label: '类型' },
        { k: ['price', 'avg_price'], label: '价', fmt: 'px' },
        { k: ['qty', 'size'], label: '量', fmt: 'num' },
        { k: ['filled', 'cum_exec_qty', 'leaves_qty'], label: '成交量', fmt: 'num' },
        { k: ['status', 'state', 'order_status'], label: '状态' },
        { k: ['reduce_only'], label: '只减仓' },
      ], '本次未取到：orders_history') + '</div>' +
    '<div class="morebody hidden" id="ldtx' + i + '">' +
      '<div class="blknote">account_txns · 账户流水（含资金费／划转等）· 快照 ' + rdStampHM(rdG(RD.ld, 'updated_at')) + ' 北京</div>' +
      rdGenericTable(rdPick(b, ['account_txns', 'txns', 'transactions']) || rdPick(RD.ld || {}, ['account_txns']), [
        { k: ['t', 'time', 'created', 'ts'], label: '时间', fmt: 'time' },
        { k: ['type', 'txn_type', 'kind'], label: '类型' },
        { k: ['cashFlow', 'cash_flow', 'amount', 'change'], label: '金额', fmt: 'pnl' },
        { k: ['currency', 'coin'], label: '币种' },
        { k: ['feeRate', 'fee_rate'], label: '费率' },
        { k: ['info', 'note', 'remark'], label: '备注' },
      ], '本次未取到：account_txns') + '</div>' +
    '<div class="morebody hidden" id="ldst' + i + '">' + rdStateHtml(b) + '</div>' +
    '<div class="morebody hidden" id="ldlg' + i + '">' + rdLogsHtml(b) + '</div>' +
    '</div>';
}

/* ── 对打面板（2026-10-13）：衡盘带单 vs Codex AI；数据来自 live_detail.compete ── */
function rdCompeteSideCard(side, idx) {
  if (!side) return '';
  const ok = !!side.ok;
  const eq = rdNum(side.equity), up = rdNum(side.upnl), av = rdNum(side.available);
  const ret = rdNum(side.return_pct), rn = rdNum(side.realized_net);
  const pw = side.pnl_window || side.pnl_window_90d || {};
  const today = rdNum((rdPick(pw, ['today', 'd1']) || {}).net);
  const d7 = rdNum((rdPick(pw, ['last_7d', 'd7', '7d']) || {}).net);
  const all = rdNum((rdPick(pw, ['all', 'total']) || {}).net);
  const st = side.state || {};
  const todayV = today != null ? today : (st.realized != null ? null : null);
  const legs = Array.isArray(side.positions) ? side.positions : [];
  const orders = Array.isArray(side.open_orders) ? side.open_orders : [];
  const proc = side.process || {};
  const team = side.id === 'hengpan' ? 'heng' : 'codex';
  const posHtml = legs.length
    ? '<table class="tatable"><thead><tr><th>标的</th><th>方向</th><th>张数</th><th>均价</th><th>标记</th><th>未实现</th></tr></thead><tbody>' +
      legs.map(x => '<tr><td>' + esc(x.symbol || x.sym || '--') + '</td>' +
        '<td class="' + rdSideCls(x.side) + '">' + rdSide(x.side) + '</td>' +
        '<td class="mono">' + (x.size == null ? '--' : fmtNum(x.size, 4)) + '</td>' +
        '<td class="mono">' + (x.avg == null ? '--' : fmtPrice(x.avg)) + '</td>' +
        '<td class="mono">' + (x.mark == null ? '--' : fmtPrice(x.mark)) + '</td>' +
        '<td class="mono ' + cls(x.upnl) + '">' + (x.upnl == null ? '--' : fmtNum(x.upnl, 4)) + '</td></tr>').join('') +
      '</tbody></table>'
    : '<div class="empty">无持仓</div>';
  return '<div class="compete-card ' + team + (ok ? '' : ' bad') + '">' +
    '<div class="cch"><div class="ccn">' + esc(side.label || side.id || '账户') + '</div>' +
      '<div class="ccs">' + esc(side.role || '') +
        (proc.pid != null ? ' · pid ' + esc(String(proc.pid)) : ' · 进程未见到') +
        (ok ? '' : ' · <span class="miss">' + esc(side.err || '取数失败') + '</span>') + '</div></div>' +
    '<div class="ccnums">' +
      '<div><div class="kl">权益</div><div class="kv">' + rdU(eq, 2) + '</div></div>' +
      '<div><div class="kl">未实现</div><div class="kv kvs ' + cls(up) + '">' + rdMoney(up, 4) + '</div></div>' +
      '<div><div class="kl">收益率</div><div class="kv kvs ' + cls(ret) + '">' + (ret == null ? '--' : pct(ret)) + '</div></div>' +
      '<div><div class="kl">可用</div><div class="kv kvs">' + rdU(av, 2) + '</div></div>' +
    '</div>' +
    '<div class="ccperiods">' +
      '<span>今日 ' + (today == null && all == null ? '--' : rdMoney(today != null ? today : null, 4)) + '</span>' +
      '<span>近7日 ' + rdMoney(d7, 4) + '</span>' +
      '<span>全部 ' + rdMoney(all != null ? all : rn, 4) + '</span>' +
      (st.realized != null ? '<span>bot记账 ' + rdMoney(rdNum(st.realized), 4) + '</span>' : '') +
    '</div>' +
    '<div class="ccsec"><b>持仓 ' + legs.length + '</b>' + posHtml + '</div>' +
    '<div class="ccsec"><b>挂单 ' + orders.length + '</b>' +
      (orders.length ? rdOrdersTable(orders.slice(0, 8)) : '<div class="empty">当前没有挂单</div>') + '</div>' +
    '<div class="ccfoot">钱包 ' + rdU(side.wallet, 4) +
      (st.sym ? ' · state ' + esc(String(st.sym)) : '') +
      (side.bot_name ? ' · ' + esc(String(side.bot_name)) : '') + '</div>' +
    '</div>';
}
function rdCompeteHtml(d) {
  let c = rdG(d, 'compete');
  if (!c || !Array.isArray(c.sides) || !c.sides.length) {
    /* 无 compete 键时：用 account + bots 拼一列衡盘，Codex 显示未就绪 */
    const acct = rdG(d, 'account') || {};
    const bots = Array.isArray(rdG(d, 'bots')) ? d.bots : [];
    c = {
      race_strip: ['策略开发', '影子纸面', '前三晋级', '实盘对打', '互相借鉴'],
      note: '兼容旧 JSON（尚无 compete 键）',
      sides: [{
        id: 'hengpan', label: '衡盘 · 带单', role: '带单账户', ok: true,
        equity: acct.equity, available: acct.available, upnl: null,
        positions: (bots[0] && bots[0].positions_all) || [],
        open_orders: (bots[0] && bots[0].open_orders) || [],
        process: bots[0] && bots[0].process, bot_name: bots[0] && bots[0].name,
        return_pct: bots[0] && bots[0].return_pct, realized_net: bots[0] && bots[0].realized_net,
        pnl_window: bots[0] && bots[0].pnl_window, pnl_window_90d: bots[0] && bots[0].pnl_window_90d,
        state: bots[0] && bots[0].state, wallet: null,
      }, {
        id: 'codex', label: 'Codex · AI', role: 'AI 交易账户', ok: false,
        err: 'live_detail.compete 尚未产出 —— 等下一轮 live_detail_sync',
        positions: [], open_orders: [],
      }],
    };
  }
  const strip = Array.isArray(c.race_strip) ? c.race_strip : ['策略开发', '影子纸面', '前三晋级', '实盘对打', '互相借鉴'];
  let h = '<div class="race-strip"><span class="rs-lab">工作流</span>' +
    strip.map((s, i) => '<span class="rs-step">' + esc(String(s)) + '</span>' +
      (i < strip.length - 1 ? '<span class="rs-arw">→</span>' : '')).join('') + '</div>';
  h += '<div class="compete-grid">' + c.sides.map(rdCompeteSideCard).join('') + '</div>';
  if (c.note) h += '<div class="compete-note">' + esc(String(c.note)) +
    ' · 影子榜另开「影子」页，标<strong>纸面</strong>，不能当实盘。</div>';
  return h;
}

/* ── 当前真值块（2026-10-18 hengpan-sync · P04-HENGPAN-LIVE-SYNC-20261018-01）─────────
   为什么必须加：#live 页此前只吃 live_detail.json（2026-10-15 13:45 停更），页面印的是
   equity 18.97 / pid 819746 / 1 仓 1 挂单 —— 全是 10-15 的历史，和交易所真值(≈8.86, 2 腿,
   pid 3501539)不一致。本块只读 live.json / pos.json / live_truth.json（三者都由 60s 只读采集刷新），
   并把 live_detail 的旧内容降级为「历史快照」折叠块。绝不改数据文件、不下单。 */
function rdTruthFreshBadge(age) {
  if (!age) return '<span class="miss">时间未取到</span>';
  if (age.future) return '<span class="stale">⚠ 时钟偏差：时间戳在未来 ' + Math.abs(age.signedSec) + ' 秒</span>';
  if (age.stale) return '<span class="stale">⚠ 过期（> ' + Math.round(RD_STALE_SEC / 60) + ' 分钟）</span>';
  return '<span class="chip on">✓ 当前</span>';
}
function rdTruthHtml() {
  const lv = RD.live, pos = RD.pos, tr = RD.truth;
  if (!lv && !pos) return '';
  const la = lv ? rdKpiAge({ at: rdG(lv, 'fetched_at') }) : null;
  const pa = pos ? rdKpiAge({ at: rdG(pos, 'ts') }) : null;
  const accounts = (pos && pos.accounts) || {};
  const order = Object.keys(accounts).length ? Object.keys(accounts) : [];
  const accCells = order.map(k => {
    const a = accounts[k] || {};
    const masked = k === 'hengpan' ? 'account A · 衡盘 · 带单' : (k === 'codex' ? 'account B · Codex · AI' : k);
    const legs = Array.isArray(a.positions) ? a.positions.length : null;
    return '<div class="tcell"><span class="tk">' + esc(masked) + '</span><span class="tv">' +
      (rdNum(a.equity) == null ? '<span class="miss">未取到 equity</span>' : fmtNum(rdNum(a.equity), 8) + ' USDT') +
      ' · 腿 ' + (legs == null ? '<span class="miss">未取到</span>' : legs) + '</span></div>';
  }).join('');
  const inst = (tr && tr.instance) || null;
  const scriptF = (tr && tr.scriptFile) || null;
  const pidTxt = (inst && inst.pid && inst.pid !== 'UNKNOWN') ? String(inst.pid) : '<span class="miss">未取到（live_truth.json 未提供）</span>';
  const cwdTxt = (inst && inst.cwd && inst.cwd !== 'UNKNOWN') ? String(inst.cwd) : '<span class="miss">未取到</span>';
  const cmdTxt = (inst && inst.cmdline && inst.cmdline !== 'UNKNOWN') ? String(inst.cmdline) : '<span class="miss">未取到</span>';
  const scriptTxt = (scriptF && scriptF.size) ? (esc('/home/ubuntu/quantbot/jevscalp.py') + ' · ' + esc(String(scriptF.size)) + 'B · ' + esc(String(scriptF.mtime))) : '<span class="miss">未取到</span>';
  const legs = Array.isArray(lv && lv.positions) ? lv.positions : null;
  const legsRows = legs && legs.length ? legs.map(p =>
    '<tr><td>' + esc(String(p.symbol || '--')) + '</td><td>' + esc(String(p.side || '--')) + '</td>' +
    '<td class="mono">' + (rdNum(p.size) == null ? '--' : fmtNum(rdNum(p.size), 4)) + '</td>' +
    '<td class="mono">' + (rdNum(p.avg) == null ? '--' : fmtPrice(rdNum(p.avg))) + '</td>' +
    '<td class="mono ' + cls(p.upnl) + '">' + (rdNum(p.upnl) == null ? '--' : fmtNum(rdNum(p.upnl), 4)) + '</td></tr>').join('')
    : '<tr><td colspan="5">' + (legs === null ? '未取到（不当作 0 仓位）' : '该快照时点实测无腿') + '</td></tr>';
  const span = (lv && Array.isArray(lv.entries) && lv.entries[0] && lv.entries[0].window_span) ? lv.entries[0].window_span : null;
  let h = '<div class="tblock truth"><div class="ttitle">🔴 当前真值（数据源=live.json / pos.json，由 60s 只读采集刷新；非 live_detail 历史快照）</div>';
  h += '<div class="tgrid">' +
    '<div class="tcell"><span class="tk">数据源=live.json · 截至（北京）</span><span class="tv">' +
      (lv ? esc(rdBJ(rdG(lv, 'fetched_at'), 'full')) : '<span class="miss">未取到 live.json</span>') + ' ' + rdTruthFreshBadge(la) + '</span></div>' +
    '<div class="tcell"><span class="tk">数据源=pos.json · 截至（北京）</span><span class="tv">' +
      (pos ? esc(rdBJ(rdNum(pos.ts), 'full')) : '<span class="miss">未取到 pos.json</span>') + ' ' + rdTruthFreshBadge(pa) + '</span></div>' +
    '<div class="tcell"><span class="tk">最后成功采集</span><span class="tv">' + esc(String((tr && tr.lastSuccessAt) || '未取到')) + '</span></div>' +
    '<div class="tcell"><span class="tk">开放腿（account A 快照）</span><span class="tv">' +
      (legs === null ? '<span class="miss">未取到（不当作 0 仓位）</span>' : legs.length + ' 腿') + '</span></div>' +
    '<div class="tcell"><span class="tk">实例 · VPS 真实进程 PID</span><span class="tv">' + pidTxt + '</span></div>' +
    '<div class="tcell"><span class="tk">实例 · 脚本 / cwd</span><span class="tv">' + scriptTxt + ' · cwd ' + cwdTxt + ' · cmd ' + cmdTxt + '</span></div>' +
    '</div>';
  if (accCells) h += '<div class="tgrid">' + accCells + '</div>';
  h += '<div class="tgrid"><div class="tcell"><span class="tk">持仓腿明细（来源 live.json.positions）</span><span class="tv"><table class="tatable"><thead><tr><th>标的</th><th>方向</th><th>张数</th><th>均价</th><th>未实现</th></tr></thead><tbody>' + legsRows + '</tbody></table></span></div></div>';
  h += '<div class="tnote">· “当前”判据：live.json/pos.json age ≤ ' + RD_STALE_SEC + 's；超过即显示 <b>过期</b>，时间戳在未来则显示 <b>时钟偏差</b>（绝不当“当前正常”）。' +
    (span ? '<br>· 数据覆盖窗口（live.json 逐腿口径）：<b>' + esc(String(span.from || '--')) + ' ~ ' + esc(String(span.to || '--')) + '</b>（' + esc(String(span.days || '--')) + ' 天）。' : '') +
    '<br>· 账户级权益（account A/B 各一本账）与单实例/单腿 realized 是<b>不同口径</b>，不可互相替代；account B 的腿不计入 A。' +
    '<br>· “启动实盘”按钮的「控制入口离线 · 启动器不可达」只代表启动器服务(127.0.0.1:18095)可达性，<b>与 VPS 机器人状态/账户数据新鲜度无关</b>。' +
    ((tr && tr.vpsProbeOk === false) ? '<br>· ⚠ 本轮 VPS 只读实例探测失败：' + esc(String((tr && String(tr.vpsProbeOk)) || 'UNKNOWN')) : '') +
    '</div></div>';
  return h;
}
function rdRenderLiveDetail() {
  const box = $('liveDetailBody'); if (!box) return;
  const chip = $('liveDetailAge');
  const d = RD.ld;
  /* 2026-10-18 hengpan-sync：live_detail.json 是否还新鲜，决定它能不能当"当前"，否则只作历史折叠。 */
  const detMs = d ? rdTsMs(rdG(d, 'updated_at')) : null;
  const detAge = detMs == null ? null : Math.max(0, Math.round((Date.now() - detMs) / 1000));
  const detStale = detAge == null || detAge > RD_DETAIL_STALE_SEC;
  const detAgeTxt = detAge == null ? '时间未取到' : (detAge < 60 ? detAge + ' 秒前' : Math.round(detAge / 60) + ' 分钟前');
  const truthHtml = rdTruthHtml();
  if (!d) {                                       /* ← 优雅降级：文件缺失 / 读不到 */
    if (chip) { chip.className = 'chip warn'; chip.textContent = truthHtml ? '当前数据源 live.json/pos.json · 历史详情未就绪' : '详情数据未就绪'; }
    box.innerHTML = truthHtml + '<div class="emptybox">' +
      '<div class="eb1">历史详情（live_detail.json）未就绪</div>' +
      '<div class="eb2">读不到 <code>dashboard/live_detail.json</code>' +
        (RD.ldErr ? '（' + esc(RD.ldErr) + '）' : '') + ' —— 上方「当前真值」不受影响（来源 live.json/pos.json）。</div>' +
      '<div class="eb3">不猜数、不报错、不空白崩；文件出现后本页每 20 秒自动显示。</div>' +
      '</div>';
    return;
  }
  const bots = Array.isArray(rdG(d, 'bots')) ? d.bots : [];
  const acct = rdG(d, 'account') || {};
  const upd = rdG(d, 'updated_at');
  if (chip) {
    if (detStale) { chip.className = 'chip warn'; chip.textContent = '历史快照 ' + rdStampHM(upd) + ' 北京（' + detAgeTxt + '）· 当前数据源 live.json/pos.json'; }
    else { chip.className = 'chip on'; chip.textContent = '对打 · 更新 ' + rdStampHM(upd) + ' 北京 · ' + esc(rdShort(rdG(d, 'source'), 10)); }
  }
  let h = '';
  if (rdG(d, 'schema') && String(d.schema) !== 'live_detail.v1') {
    h += '<div class="gline"><i class="gw"></i><b>schema 不是 live_detail.v1</b><span class="gd">当前收到 ' +
      esc(String(d.schema)) + ' —— 按已知字段尽力渲染，未知字段忽略。</span></div>';
  }
  /* 对打主舞台：衡盘 vs Codex（替换原先单卡「HYPE 主实例」观感） */
  h += rdCompeteHtml(d);
  h += '<div class="acct">' +
    '<div><div class="kl">账户权益</div><div class="kv">' + rdU(acct.equity, 2) + '</div></div>' +
    '<div><div class="kl">可用</div><div class="kv kvs">' + rdU(acct.available, 2) + '</div></div>' +
    '<div><div class="kl">初始保证金</div><div class="kv kvs">' + rdU(acct.im, 2) + '</div></div>' +
    '<div><div class="kl">维持保证金</div><div class="kv kvs">' + rdU(acct.mm, 2) + '</div></div>' +
    (acct.note ? '<div class="acctnote">' + esc(String(acct.note)) + '</div>' : '') +
    (function () {   /* account_extra：数据侧另给的账户级补充数字，有就显示，没有不显示 */
      const ax = rdPick(d, ['account_extra']);
      if (!ax || typeof ax !== 'object') return '';
      const items = [
        ['钱包余额', rdNumIn(ax, ['wallet_balance']), 2], ['保证金余额', rdNumIn(ax, ['margin_balance']), 2],
        ['各腿未实现合计', rdNumIn(ax, ['perp_upnl_total', 'legs_upnl_sum']), 4],
        ['挂单总数', rdNumIn(ax, ['open_orders_total']), 0], ['仓位腿数', rdNumIn(ax, ['positions_total']), 0],
        ['窗口内划转', rdNumIn(ax, ['transfers_in_window_cashflow']), 2],
      ].filter(x => x[1] != null);
      if (!items.length) return '';
      return '<div class="acctnote">' + items.map(x => esc(x[0]) + ' <b class="mono">' + fmtNum(x[1], x[2]) + '</b>').join(' · ') +
        ' · 口径：账户级（两实例共用）</div>';
    })() +
    '</div>';
  h += bots.length
    ? bots.map((b, i) => rdBotCard(b, i)).join('')
    : '<div class="emptybox small"><div class="eb1">详情数据未就绪</div><div class="eb2">live_detail.json 读到了，但 <code>bots</code> 为空。</div></div>';
  h += '<div class="srcnote">数据来源：' + esc(String(rdG(d, 'source') || '--')) +
    '<br>采集时间 <b>' + rdStamp(upd) + '（北京）</b> · schema ' + esc(String(rdG(d, 'schema') || '--')) +
    ' · 只读：页面不写、不改、不下单。账户级指标由两个实例共用，归因按标的级。' +
    '<br>样本口径：采集侧实测 <code>closed-pnl</code> 单次查询跨度上限 7 天（超出报 retCode=10001）⇒ 数据侧那套 <code>*_90d</code> 键' +
    '实际是<b>全部查询区间</b>（<b>不是</b>固定天数的样本，也<b>不等于</b>有成交天数；为什么只到起点那天原因未知、不做归因）。两台各算各的：' +
    (bots.length ? bots.map(b => esc(String(rdG(b, 'name') || '未命名')) + '＝' + esc(rdSpanText(rdSpan(b)))).join('；') : '--') + '。</div>';
  /* 2026-10-18 hengpan-sync：新鲜时照旧（同源详情）；过期时 —— 顶部当前真值 + 旧内容折进「历史快照」，
     不再让 10-15 的 18.97/pid 819746/1 仓 1 挂单冒充当前。 */
  if (detStale) {
    box.innerHTML = truthHtml +
      '<div class="gline"><i class="gw"></i><b>以下为 live_detail.json 历史快照（' + esc(rdStamp(upd)) + ' 北京 · ' + esc(detAgeTxt) + '），已过期，仅作历史</b>' +
      '<span class="gd">该文件自 2026-10-15 13:45 起停更（写它的那一路不再运行）；其中的账户权益 ≈18.97、pid 819746、1 仓 1 挂单都是那时的快照，' +
      '不是当前事实。当前账户/持仓/实例以本页顶部「当前真值」为准（来源 live.json/pos.json）。</span></div>' +
      '<details class="fold"><summary>展开历史快照 live_detail.json（' + esc(rdStamp(upd)) + ' 北京 · 已过期 ' + esc(detAgeTxt) + '）</summary>' + h + '</details>';
  } else {
    box.innerHTML = truthHtml + h;
  }
}
async function rdFetchLiveDetail(force) {
  /* 总览 KPI 与实盘详情共用这一份 live_detail.json（单一数据源）。
     自带 15 秒节流，避免总览与实盘页在同一轮各拉一次（文件已 400KB+）。 */
  if (!force && Date.now() - (RD.lastLD || 0) < 15000) return;
  RD.lastLD = Date.now();
  try {
    const d = await getJSON('live_detail.json?t=' + Date.now());
    RD.ld = d; RD.ldErr = null;
  } catch (e) {
    RD.ldErr = e.message || '读取失败';
    if (!RD.ld) RD.ld = null;                     /* 从没拿到过 ⇒ 走空态；拿到过就保留旧数据 */
  }
  /* 2026-10-18 hengpan-sync：#live 页当前真值三件套（只读 fetch，失败各自降级，不影响 live_detail）。
     live.json / pos.json 由 60s 只读采集刷新；live_truth.json 是同一采集器发布的展示派生文件
     （VPS 真实 pid / cwd / 脚本 size+mtime / state.json mtime / 分账户 / 时效）。 */
  try { RD.live = await getJSON('live.json?t=' + Date.now()); } catch (e) { RD.live = null; }
  try { RD.pos = await getJSON('pos.json?t=' + Date.now()); } catch (e) { RD.pos = null; }
  try { RD.truth = await getJSON('live_truth.json?t=' + Date.now()); } catch (e) { RD.truth = null; }
}
async function loadLiveDetail(force) {
  await rdFetchLiveDetail(force);
  rdRenderLiveDetail();
}

/* ═══════════════ 6d. 实盘详情 · 扩展块（数据侧只加键；缺哪个键就那一块降级）═══════════════
   原则：① 只读渲染；② 每块优先用数据侧给的键，没有就**从已有键派生**并标明口径；
        ③ 既没给、又派生不出来的，那一块显示「本次未取到」，不空白、不报错。 */
function rdPick(o, keys) {
  /* keys 允许传数组，也允许传单个字符串 —— 传字符串时 for...of 会逐字符遍历（踩过：
     sv('base') 变成 rdPick(st,'base')，于是 base/skimmed/file/mtime 全被判为「本次未取到」）。 */
  const list = Array.isArray(keys) ? keys : [keys];
  for (const k of list) { const v = rdG(o, k); if (v !== undefined && v !== null) return v; }
  return undefined;
}
function rdNumIn(o, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const k of list) { const n = rdNum(rdG(o, k)); if (n != null) return n; }
  return null;
}
function rdDayKey(ts) {
  if (ts == null || ts === '') return '?';
  const s = String(ts);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  return rdYmd(s);
}
/* epoch / ISO → 北京日期 YYYY-MM-DD。
   ⚠️ 不能拿 rdStamp() 当日期用：它默认只返回「MM-DD HH:MM」，缺年份 ⇒ 用 /^\d{4}-/ 去匹配会全部落到 '?'，
   于是「缺失天数」会被算成整个区间（2026-10-08 实际踩到：HYPE 显示「缺 42 天」而其实只有 19 天有成交）。 */
function rdYmd(ts) {
  const ms = rdTsMs(ts);
  if (ms == null) return '?';
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + rdPad(d.getUTCMonth() + 1) + '-' + rdPad(d.getUTCDate());
}
function rdDayLbl(k) { const m = /^\d{4}-(\d{2}-\d{2})$/.exec(k); return m ? m[1] : k; }
function rdTodayKey() { const d = new Date(Date.now() + 8 * 3600 * 1000); return d.getUTCFullYear() + '-' + rdPad(d.getUTCMonth() + 1) + '-' + rdPad(d.getUTCDate()); }
function rdDayMinus(n) { const d = new Date(Date.now() + 8 * 3600 * 1000 - n * 86400000); return d.getUTCFullYear() + '-' + rdPad(d.getUTCMonth() + 1) + '-' + rdPad(d.getUTCDate()); }
function rdTrSgn(v, d, unit) { const n = rdNum(v); if (n == null) return '--'; return (n >= 0 ? '+' : '') + n.toFixed(d == null ? 2 : d) + (unit || ''); }

/* ── 日粒度：优先 pnl_by_day，没有就从 trades 的 closed_pnl 按北京日期归集 ── */
function rdDays(b) {
  const given = rdPick(b, ['pnl_by_day', 'daily', 'pnl_daily']);
  if (Array.isArray(given) && given.length) {
    const rows = given.map(x => ({
      k: rdDayKey(rdPick(x, ['date', 'day', 'd', 't']) || ''),
      realized: rdNumIn(x, ['realized', 'closed_pnl', 'realized_u']),
      funding: rdNumIn(x, ['funding', 'funding_u']),
      net: rdNumIn(x, ['net', 'net_u', 'pnl', 'pnl_u']),
      n: rdNumIn(x, ['trades', 'n', 'count']),
    })).filter(x => x.k && x.k !== '?');
    if (rows.length) return { src: 'given', rows: rows };
  }
  const trades = Array.isArray(rdG(b, 'trades')) ? b.trades : [];
  if (!trades.length) return { src: 'none', rows: [] };
  const map = {};
  for (const t of trades) {
    const k = rdDayKey(t.t); if (!k || k === '?') continue;
    if (!map[k]) map[k] = { k: k, realized: 0, funding: null, net: 0, n: 0 };
    const v = rdNum(t.closed_pnl) || 0;
    map[k].realized += v; map[k].net += v; map[k].n += 1;
  }
  return { src: 'derived', rows: Object.keys(map).sort().map(k => map[k]) };
}
/* ── 盈亏三档：优先 pnl_window（数据侧实测就是这个键名）→ pnl_periods → 用日粒度归集 ── */
function rdPeriods(b, days) {
  const pw = rdPick(b, ['pnl_window']);
  if (pw && typeof pw === 'object') {
    const one = v => (v == null ? null : {
      net: rdNumIn(v, ['net', 'net_u']), n: rdNumIn(v, ['trades', 'n', 'count']),
      win: rdNumIn(v, ['win']), loss: rdNumIn(v, ['loss']), hours: rdNumIn(v, ['hours']),
      clipped: v.clipped_to_run_window === true, from: rdPick(v, ['from']), to: rdPick(v, ['to']),
    });
    const d1 = one(rdPick(pw, ['today', 'd1'])), d7 = one(rdPick(pw, ['last_7d', 'd7', '7d'])), da = one(rdPick(pw, ['all', 'total']));
    if (d1 || d7 || da) return { src: 'window', d1: d1 || {}, d7: d7 || {}, da: da || {} };
  }
  const exp = rdPick(b, ['pnl_periods', 'periods', 'pnl_by_period']);
  const one2 = v => (v == null ? null : (typeof v === 'number' ? { net: v, n: null } : {
    net: rdNumIn(v, ['net', 'net_u', 'realized_net', 'pnl', 'pnl_u']), n: rdNumIn(v, ['trades', 'n', 'count']),
  }));
  if (exp && typeof exp === 'object') {
    const d1 = one2(rdPick(exp, ['today', 'd1', '1d'])), d7 = one2(rdPick(exp, ['d7', '7d', 'week'])), da = one2(rdPick(exp, ['all', 'total', 'lifetime']));
    if (d1 || d7 || da) return { src: 'given', d1: d1 || {}, d7: d7 || {}, da: da || {} };
  }
  if (!days.rows.length) return null;
  const today = rdTodayKey(), cut7 = rdDayMinus(6);
  let a1 = 0, n1 = 0, a7 = 0, n7 = 0, aa = 0, na = 0;
  for (const r of days.rows) {
    const v = rdNum(r.net) || 0, c = rdNum(r.n) || 0;
    aa += v; na += c;
    if (r.k === today) { a1 += v; n1 += c; }
    if (r.k >= cut7) { a7 += v; n7 += c; }
  }
  return { src: days.src === 'given' ? 'given-days' : 'derived', d1: { net: a1, n: n1 }, d7: { net: a7, n: n7 }, da: { net: aa, n: na } };
}
function rdPeriodsHtml(b, days) {
  const p = rdPeriods(b, days);
  if (!p) return '<div class="dcp"><div class="dcphead">盈亏三档 · <span class="miss">本次未取到（也没有 trades 可归集）</span></div></div>';
  const cell = (label, o) => {
    const n = rdNum(o && o.net), cnt = rdNum(o && o.n);
    const wl = (rdNum(o && o.win) == null && rdNum(o && o.loss) == null) ? ''
      : ' · ' + (rdNum(o.win) == null ? '--' : rdNum(o.win)) + ' 胜 / ' + (rdNum(o.loss) == null ? '--' : rdNum(o.loss)) + ' 负';
    const clip = (o && o.clipped) ? ' <i class="miss">（实际只覆盖 ' + fmtNum(rdNum(o.hours), 1) + ' 小时 · 实例刚重启）</i>' : '';
    return '<div class="dcpcell"><div class="kl">' + label + '</div>' +
      '<div class="kv ' + cls(n) + '">' + (n == null ? '--' : (n >= 0 ? '+' : '') + n.toFixed(4) + '<span class="u">U</span>') + '</div>' +
      '<div class="ks">' + (cnt == null ? '笔数 --' : cnt + ' 笔') + wl + clip + '</div></div>';
  };
  const note = p.src === 'window' ? '口径：数据侧 pnl_window 的 net（含资金费；窗口＝该实例本轮启动至今）'
    : p.src === 'given' ? '口径：数据侧 pnl_periods（net）'
    : p.src === 'given-days' ? '口径：pnl_by_day 的 net（含资金费）'
    : '口径：交易所 closed-pnl 逐笔按北京日期归集（<b>不含</b>资金费；含资金费的总额见下面「累计净额」）';
  return '<div class="dcp"><div class="dcphead">盈亏三档 · <span class="miss">' + note + '</span>' +
    '<div class="miss" style="margin-top:4px;">样本 ' + esc(rdSpanText(rdSpan(b))) +
    ' · 别与别的实例混着比（两台样本长度不一样）</div></div>' +
    '<div class="dcpgrid">' + cell('今日', p.d1) + cell('近 7 天', p.d7) + cell('全部', p.da) + '</div></div>';
}

/* ── 日柱（极简柱状；涨绿跌红；悬停/点击看当日明细） ── */
function rdDayChartHtml(days) {
  const rows = days.rows;
  if (!rows.length) return '<div class="blkhead">按日盈亏</div><div class="miss">本次未取到：pnl_by_day（也没有 trades 可归集）</div>';
  const vals = rows.map(r => rdNum(r.net) || 0);
  const maxAbs = Math.max.apply(null, vals.map(Math.abs)) || 1;
  let h = '<div class="blkhead">按日盈亏 · <span class="miss">' +
    (days.src === 'derived' ? '由 closed-pnl 逐笔按北京日期归集（不含资金费）' : '来自 pnl_by_day（net）') +
    ' · 截至 ' + rdStampHM(rdG(RD.ld, 'updated_at')) + ' 北京</span></div><div class="dcwrap"><div class="dcbars">';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], v = vals[i];
    const pct = Math.max(2, Math.round(Math.abs(v) / maxAbs * 100));
    const tip = rdDayLbl(r.k) + '｜已实现 ' + rdTrSgn(r.realized, 4, 'U') +
      (r.funding == null ? '｜资金费 --' : '｜资金费 ' + rdTrSgn(r.funding, 4, 'U')) +
      '｜净 ' + rdTrSgn(r.net, 4, 'U') + '｜' + (r.n == null ? '笔数 --' : r.n + ' 笔');
    h += '<div class="dcb" title="' + esc(tip) + '"><div class="dcba"><div class="dcbar' + (v < 0 ? ' dn' : '') +
      '" style="height:' + pct + '%"></div></div><div class="dcd">' + esc(rdDayLbl(r.k)) + '</div></div>';
  }
  h += '</div></div><div class="sparkmeta">' + rows.length + ' 天 · 最高 ' + rdTrSgn(Math.max.apply(null, vals), 4, 'U') +
    ' · 最低 ' + rdTrSgn(Math.min.apply(null, vals), 4, 'U') + ' · 悬停看当日明细</div>';
  return h;
}

/* ── 统计条：优先 stats 键，否则从 trades 派生（算不出的字段明说取不到） ── */
function rdStats(b) {
  const s = rdPick(b, ['stats', 'statistics']);
  const g = keys => rdNumIn(s || {}, keys);
  const hold = (mKeys, sKeys) => {                 /* 数据侧实测给的是**分钟**（avg_hold_min），统一折成秒 */
    const mn = rdNumIn(s || {}, mKeys); if (mn != null) return mn * 60;
    return rdNumIn(s || {}, sKeys);
  };
  const out = {
    win: g(['win', 'wins', 'win_n']), loss: g(['loss', 'losses', 'loss_n']),
    winrate: g(['win_rate', 'winrate', 'win_pct']),
    avg: g(['avg_pnl', 'avg', 'avg_u', 'avg_win']), pf: g(['profit_factor', 'pf', 'pnl_ratio']),
    holdAvg: hold(['avg_hold_min', 'hold_avg_min'], ['hold_avg_sec', 'avg_hold_sec']),
    holdMed: hold(['median_hold_min', 'hold_median_min'], ['hold_median_sec', 'median_hold_sec']),
    ddU: g(['max_dd_u', 'max_drawdown_u', 'mdd_u']), ddPct: g(['max_dd_pct', 'max_drawdown_pct', 'mdd_pct']),
    basis: [rdPick(s || {}, ['dd_basis']), rdPick(s || {}, ['hold_basis']), rdPick(s || {}, ['window'])].filter(Boolean),
    derived: false,
  };
  const trades = Array.isArray(rdG(b, 'trades')) ? b.trades : [];
  const pnls = trades.map(t => rdNum(t.closed_pnl)).filter(v => v != null);
  if (pnls.length) {
    const w = pnls.filter(v => v > 0), l = pnls.filter(v => v < 0);
    if (out.win == null) { out.win = w.length; out.derived = true; }
    if (out.loss == null) { out.loss = l.length; out.derived = true; }
    if (out.winrate == null && (w.length + l.length)) { out.winrate = w.length / (w.length + l.length) * 100; out.derived = true; }
    if (out.avg == null) { out.avg = pnls.reduce((a, x) => a + x, 0) / pnls.length; out.derived = true; }
    const sw = w.reduce((a, x) => a + x, 0), sl = Math.abs(l.reduce((a, x) => a + x, 0));
    /* 无亏损笔 ⇒ 盈亏比数学上无穷，写「无亏损」而不是 0 或 -- */
    if (out.pf == null) {
      if (!l.length && w.length) out.pf = Infinity;
      else if (sl > 0) { out.pf = sw / sl; out.derived = true; }
    }
    if (out.ddU == null) {
      const seq = trades.slice().sort((x, y) => (rdStamp(x.t) < rdStamp(y.t) ? -1 : 1)).map(t => rdNum(t.closed_pnl)).filter(v => v != null);
      let cum = 0, peak = 0, dd = 0;
      for (const v of seq) { cum += v; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
      out.ddU = -dd; out.derived = true;
      const base = rdNum(rdG(b, 'start_equity'));
      if (base && out.ddPct == null) out.ddPct = -dd / base * 100;
    }
  }
  return out;
}
function rdStatsHtml(b, i) {
  const s = rdStats(b);
  const uTxt = (v, d) => (v == null ? '--' : rdTrSgn(v, d == null ? 4 : d, 'U'));
  const holdTxt = v => (v == null ? '<span class="miss">本次未取到</span>' : (v >= 3600 ? (v / 3600).toFixed(1) + ' 小时' : (v / 60).toFixed(0) + ' 分钟'));
  const pfTxt = v => (v == null ? '--' : (v === Infinity ? '<span class="miss">无亏损笔</span>' : fmtNum(v, 2)));
  const ddTxt = (v) => {
    if (v == null) return '--';
    if (Math.abs(v) < 0.00005) return '0（窗口内无回撤）';
    return fmtNum(v, 4) + 'U';
  };
  return '<div class="blkhead">统计 · <span class="miss">口径：closed-pnl 逐笔（含手续费）；回撤按「起始权益＋累计已实现」近似算 · 样本 ' +
    esc(rdSpanText(rdSpan(b))) + '</span></div><div class="statline">' +
    '<span><b>胜率</b>' + (s.winrate == null ? '--' : fmtNum(s.winrate, 1) + '%') +
      (s.win == null && s.loss == null ? '' : '（' + (s.win == null ? '--' : s.win) + ' 胜 / ' + (s.loss == null ? '--' : s.loss) + ' 负）') + '</span>' +
    '<span><b>平均盈亏</b>' + uTxt(s.avg, 4) + '</span>' +
    '<span><b>盈亏比</b>' + pfTxt(s.pf) + '</span>' +
    '<span><b>平均持仓</b>' + holdTxt(s.holdAvg) + '</span>' +
    '<span><b>中位持仓</b>' + holdTxt(s.holdMed) + '</span>' +
    '<span><b>最大回撤</b>' + ddTxt(s.ddU) + (s.ddPct == null ? '' : '（' + fmtNum(s.ddPct, 2) + '%）') + '</span>' +
    (s.derived ? '<span class="miss">（部分字段由 trades 逐笔派生）</span>' : '') +
    (s.basis.length ? '<button class="more" data-more="stb' + i + '">口径</button>' : '') +
    '</div>' +
    (s.basis.length ? '<div class="morebody hidden" id="stb' + i + '">' +
      s.basis.map(x => '<div>· ' + esc(String(x)) + '</div>').join('') + '</div>' : '');
}

/* ── 费用块：手续费（taker/maker 拆不出就写"未拆分"）＋ 资金费 ＋ funding_by_day 迷你趋势 ── */
function rdFeeHtml(b, i) {
  const f = rdPick(b, ['fees', 'fee_summary']);
  let taker = rdNumIn(f || {}, ['taker', 'taker_u', 'taker_fee']);
  let maker = rdNumIn(f || {}, ['maker', 'maker_u', 'maker_fee']);
  let total = rdNumIn(f || {}, ['total', 'total_u', 'sum', 'fee']);
  const fnote = rdPick(f || {}, ['note']);
  const trades = Array.isArray(rdG(b, 'trades')) ? b.trades : [];
  if (total == null && trades.length) total = trades.reduce((a, t) => a + (rdNum(t.fee) || 0), 0);
  const execs = rdPick(b, ['executions']);
  if (taker == null && Array.isArray(execs) && execs.length) {
    let tk = 0, mk = 0, seen = false;
    for (const x of execs) {
      const kind = String(rdPick(x, ['fee_kind', 'liquidity', 'maker_taker']) || '').toLowerCase();
      const v = rdNumIn(x, ['fee', 'fee_u']) || 0;
      if (kind.indexOf('maker') >= 0) { mk += v; seen = true; } else if (kind.indexOf('taker') >= 0) { tk += v; seen = true; }
    }
    if (seen) { taker = tk; maker = mk; }
  }
  const fund = rdNumIn(b, ['funding']);
  const fbd = rdPick(b, ['funding_by_day']);
  let mini = '<span class="miss">funding_by_day 本次未取到</span>';
  if (Array.isArray(fbd) && fbd.length) {
    const vals = fbd.map(x => rdNumIn(x, ['funding', 'usd', 'v', 'net', 'amount'])).filter(v => v != null);
    if (vals.length >= 2) mini = rdSpark(vals.map(v => ({ cum_realized: v })));
    else if (vals.length === 1) mini = '<b class="mono">' + rdTrSgn(vals[0], 4, 'U') + '</b> <span class="miss">（只有 1 天）</span>';
    else mini = '<span class="miss">funding_by_day 有 ' + fbd.length + ' 条但取不到数值</span>';
  }
  /* 拆分与总额不同源是**数据侧自己写明的**（fees.note）：差多少就写多少，不假装相等 */
  const gap = (total != null && taker != null && maker != null) ? total - taker - maker : null;
  return '<div class="blkhead">费用 · <span class="miss">口径：交易所逐笔 fee（正数＝成本）＋ 资金费单列 · 样本 ' +
    esc(rdSpanText(rdSpan(b))) + '</span></div><div class="feeline">' +
    '<span><b>手续费合计</b>' + (total == null ? '--' : fmtNum(total, 4) + ' U') + '</span>' +
    '<span><b>拆分</b>' + ((taker == null && maker == null) ? '<span class="miss">未拆分</span>'
      : ('taker ' + (taker == null ? '--' : fmtNum(taker, 4)) + ' / maker ' + (maker == null ? '--' : fmtNum(maker, 4)) + ' U')) + '</span>' +
    '<span><b>资金费合计</b>' + (fund == null ? '--' : rdTrSgn(fund, 4, 'U')) + '</span>' +
    '<span class="feemini"><b>资金费按日</b>' + mini + '</span>' +
    (gap != null && Math.abs(gap) > 0.0005 ? '<span><button class="more" data-more="fen' + i + '">拆分口径</button></span>' : '') +
    '</div>' +
    (gap != null && Math.abs(gap) > 0.0005
      ? '<div class="morebody hidden" id="fen' + i + '"><b>拆分与总额不同源</b>：total − taker − maker ＝ <code>' +
        rdTrSgn(gap, 6, 'U') + '</code>。' + (fnote ? '<br>' + esc(String(fnote)) : '（数据侧未给 fees.note）') + '</div>' : '');
}

/* ── 逐笔成交（executions 最近 300 条，滚动表；缺了就说明并用 trades 顶替） ── */
function rdExecRows(b) {
  const ex = rdPick(b, ['executions']);
  const total = rdPick(b, ['executions_total', 'executions_n']);
  if (Array.isArray(ex) && ex.length) {
    return {
      src: 'executions', total: rdNum(total) == null ? ex.length : rdNum(total),
      rows: ex.map(x => ({
        t: rdPick(x, ['t', 'time', 'ts', 'created']), side: rdPick(x, ['side']),
        qty: rdNumIn(x, ['qty', 'size']), price: rdNumIn(x, ['price', 'exec_price', 'avg']),
        fee: rdNumIn(x, ['fee', 'fee_u']), pnl: rdNumIn(x, ['closed_pnl', 'realized', 'pnl']),
      })),
    };
  }
  const tr = Array.isArray(rdG(b, 'trades')) ? b.trades : [];
  return {
    src: 'trades', total: tr.length,
    rows: tr.map(x => ({
      t: rdPick(x, ['t', 'time']), side: rdPick(x, ['side']), qty: rdNumIn(x, ['qty', 'size']),
      price: rdNumIn(x, ['exit', 'price', 'entry']), fee: rdNumIn(x, ['fee']), pnl: rdNumIn(x, ['closed_pnl', 'realized']),
    })),
  };
}
function rdExecHtml(b) {
  const e = rdExecRows(b);
  if (!e.rows.length) return '<div class="blkhead">逐笔成交</div><div class="miss">本次未取到：executions / trades 都没有</div>';
  const shown = e.rows.slice().reverse().slice(0, 300);
  const head = e.src === 'executions'
    ? '<b>executions</b>：共 ' + e.total + ' 条，' + (e.total > 300 ? '<b>仅显示最近 300</b>' : '全部显示') +
      ' · 滚轮可翻 · 快照 ' + rdStampHM(rdG(RD.ld, 'updated_at')) + ' 北京'
    : '<b>executions 本次未取到</b> —— 下表以 <b>trades</b>（交易所 closed-pnl 逐笔，已含手续费）顶替，共 ' + e.total + ' 条' +
      (e.total > 300 ? '（仅显示最近 300）' : '');
  const nullPnl = shown.filter(x => x.pnl == null).length;
  const pnlNote = (e.src === 'executions' && nullPnl === shown.length && shown.length)
    ? '<div class="blknote" style="color:var(--amber);">这张表的「已实现」为空：交易所对这 ' + shown.length +
      ' 条 execution <b>没有返回 closed_pnl</b>（逐笔平仓盈亏见上面的「成交（历史）」＝ trades）——不是 0，是没取到。</div>' : '';
  return '<div class="blkhead">逐笔成交</div><div class="blknote">' + head + '</div>' + pnlNote +
    '<div class="tblwrap tall"><table class="tatable"><thead><tr><th>时间</th><th>方向</th><th>数量</th><th>价格</th><th>手续费</th><th>已实现</th></tr></thead><tbody>' +
    shown.map(x => '<tr><td class="mono" style="font-size:10.5px;color:var(--faint);">' + rdStamp(x.t) + '</td>' +
      '<td class="' + rdSideCls(x.side) + '">' + rdSide(x.side) + '</td>' +
      '<td class="mono">' + (x.qty == null ? '--' : fmtNum(x.qty, 4)) + '</td>' +
      '<td class="mono">' + (x.price == null ? '--' : fmtPrice(x.price)) + '</td>' +
      '<td class="mono" style="color:var(--dim);">' + (x.fee == null ? '--' : fmtNum(x.fee, 5)) + '</td>' +
      '<td class="mono ' + cls(x.pnl) + '">' + (x.pnl == null ? '--' : fmtNum(x.pnl, 5)) + '</td></tr>').join('') +
    '</tbody></table></div>';
}

/* ── 通用容错表（历史委托 / 账户流水等；键名可能变体 ⇒ 多候选，缺列显示 --） ── */
function rdGenericTable(rows, cols, emptyMsg) {
  if (!Array.isArray(rows) || !rows.length) return '<div class="miss">' + esc(emptyMsg || '本次未取到') + '</div>';
  return '<div class="tblwrap"><table class="tatable"><thead><tr>' + cols.map(c => '<th>' + esc(c.label) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + cols.map(c => {
      const v = rdPick(r, c.k);
      if (c.fmt === 'side') return '<td class="' + rdSideCls(v) + '">' + rdSide(v) + '</td>';
      if (c.fmt === 'pnl') return '<td class="mono ' + cls(rdNum(v)) + '">' + (rdNum(v) == null ? '--' : fmtNum(rdNum(v), 4)) + '</td>';
      let txt;
      if (c.fmt === 'time') txt = rdStamp(v);
      else if (c.fmt === 'num') txt = rdNum(v) == null ? '--' : fmtNum(rdNum(v), c.d == null ? 4 : c.d);
      else if (c.fmt === 'px') txt = rdNum(v) == null ? '--' : fmtPrice(rdNum(v));
      else txt = (v == null || v === '') ? '--' : String(v);
      const cls2 = (c.fmt === 'time' || c.fmt === 'num' || c.fmt === 'px') ? ' class="mono"' : '';
      const stl = c.fmt === 'time' ? ' style="font-size:10.5px;color:var(--faint);"' : '';
      return '<td' + cls2 + stl + '>' + esc(txt) + '</td>';
    }).join('') + '</tr>').join('') + '</tbody></table></div>';
}

/* ── bot 自身状态（state）：强调是 **bot 自己记的**，与交易所口径分开 ── */
function rdStateHtml(b) {
  const st = rdPick(b, ['state', 'bot_state', 'own']);
  const lad = rdG(b, 'ladder') || {};
  const rows = [];
  const put = (k, v) => rows.push('<div class="row"><span class="k">' + k + '</span><span class="v">' +
    ((v == null || v === '') ? '<span class="miss">本次未取到</span>' : esc(String(v))) + '</span></div>');
  const sv = k => rdPick(st || {}, k);
  /* base 实测是个对象（每条腿一个基准价）⇒ 摊成「腿 → 价」若干行，不能 String() 成 [object Object] */
  const base = sv('base');
  if (base && typeof base === 'object' && !Array.isArray(base)) {
    for (const k of Object.keys(base)) put('base · ' + k, rdNum(base[k]) == null ? base[k] : fmtPrice(base[k]));
  } else {
    put('base', base != null ? base : (rdNum(rdG(lad, 'base')) != null ? fmtPrice(rdG(lad, 'base')) : null));
  }
  put('rung', sv('rung') != null ? sv('rung') : (rdNum(rdG(lad, 'rung')) != null ? rdG(lad, 'rung') : null));
  put('skimmed', sv('skimmed') != null ? sv('skimmed') : sv('skim'));
  put('来源文件', sv('source_file') != null ? sv('source_file') : sv('file'));
  const ft = sv('file_time') != null ? sv('file_time') : (sv('mtime') != null ? sv('mtime') : sv('file_mtime'));
  put('文件时间', ft != null ? rdStamp(ft) + '（北京）' : null);
  if (st && typeof st === 'object') {
    const skip = ['base', 'rung', 'skimmed', 'skim', 'source_file', 'file', 'state_file', 'file_time', 'mtime', 'file_mtime'];
    for (const k of Object.keys(st)) {
      if (skip.indexOf(k) >= 0) continue;
      const v = st[k];
      if (v == null || v === '') continue;
      if (typeof v === 'object') {
        if (Array.isArray(v)) continue;
        const inner = Object.keys(v).filter(kk => v[kk] == null || typeof v[kk] !== 'object');
        if (!inner.length) continue;
        rows.push('<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' +
          inner.map(kk => esc(kk) + '=' + esc(String(v[kk]))).join(' · ') + '</span></div>');
        continue;
      }
      rows.push('<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(String(v)) + '</span></div>');
    }
  }
  return '<div class="misssrc">这是 <b>bot 自己记的状态</b>（本机 state 文件），与上面交易所口径的持仓/盈亏<b>不是一回事</b>，别混着比。</div>' + rows.join('');
}

/* ── 日志尾巴（等宽、可滚动）＋ 疑似凭据整行打码 ── */
const RD_SECRET = /(sk-[A-Za-z0-9_\-]{8,})|(Bearer\s+[A-Za-z0-9._\-]{10,})|(api[_-]?key["'\s:=]{1,4}[A-Za-z0-9._\-]{12,})|(secret["'\s:=]{1,4}[A-Za-z0-9._\-]{8,})|(token["'\s:=]{1,4}[A-Za-z0-9._\-]{12,})|(passw[a-z]*["'\s:=]{1,4}\S{6,})|(\b[0-9a-fA-F]{32,}\b)|(\b[A-Za-z0-9_\-]{44,}\b)/i;
function rdLogsHtml(b) {
  const logs = rdPick(b, ['logs_tail', 'logs', 'log_tail']);
  if (!Array.isArray(logs) || !logs.length) return '<div class="miss">本次未取到：logs_tail</div>';
  let masked = 0;
  const lines = logs.map(x => {
    const s = String(x == null ? '' : x);
    if (RD_SECRET.test(s)) { masked++; return '[已打码 · 疑似凭据] ' + s.slice(0, 10).replace(RD_SECRET, '***') + '…'; }
    return s;
  });
  return (masked ? '<div class="logwarn">⚠ 检测到 ' + masked + ' 行疑似 token / key，已<b>整行打码</b>（日志原文不入库、不落盘）。</div>' : '') +
    '<div class="logbox">' + lines.map(l => esc(l)).join('\n') + '</div>';
}

/* ═══════════════ 7. 接管 cockpit.js 的四个入口 ═══════════════ */
const _rdOrigSetTab = setTab;
setTab = function (t, noHash) {
  const KNOWN = ['overview', 'bots', 'promote', 'live', 'shop', 'manual'];
  if (KNOWN.indexOf(t) < 0) t = 'overview';
  S.tab = t;   /* 让 cockpit.js 自己的轮询开关跟着走：非手动页就不再每 5 秒拉 K 线 */
  document.querySelectorAll('.seg .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.pane').forEach(p => p.classList.add('hidden'));
  const pane = $('pane-' + t);
  if (pane) pane.classList.remove('hidden');
  if (t === 'manual') { _rdOrigSetTab('manual', true); document.querySelectorAll('.pane').forEach(p => p.classList.add('hidden')); $('pane-manual').classList.remove('hidden'); }
  const tag = $('pageTag');
  if (tag) tag.textContent = { overview: '总览', bots: '影子榜', promote: '晋级', live: '实盘', shop: '策略工坊', manual: '手动交易' }[t] || '';
  if (!noHash) { try { location.replace('#' + t); } catch (e) {} }
  if (t === 'bots') loadShadow(true);
  if (t === 'shop') loadShop(true);
  if (t === 'live') loadLiveDetail(true);
  if (t === 'overview' || t === 'promote') loadShadow(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
};
loadShadow = async function (force) {
  const now = Date.now();
  if (!force && now - (RD.lastCore || 0) < 15000) { rdRenderOverview(); rdRenderPromote(); return; }
  RD.lastCore = now;
  let d = null;
  try {
    d = await getJSON('shadow.json?t=' + Date.now());
    try { if (typeof _mergeMm === 'function') await _mergeMm(d); } catch (e) {}
    try {
      const lv = await getJSON('live.json?t=' + Date.now());
      if (lv && lv.entries && lv.entries.length) d.live = lv;
    } catch (e) {}
    RD.d = d;
    await rdFetchLiveDetail(false);   /* 总览 KPI 与实盘详情同源：同一次刷新里带上 live_detail.json */
  } catch (e) {
    const rb = $('rankBody');
    if (rb) rb.innerHTML = '<span class="bad">shadow.json 读不到：' + esc(e.message) + '（它由 refresh.ps1 循环里的 shadow_sync.py 产出）</span>';
    return;
  }
  /* ⚠️ 渲染错误必须和"取数失败"分开：以前渲染抛错被这里吞掉、还挂在"shadow.json 读不到"上，
     结果是「总览一半是加载中」却查不出真因（2026-10-07 实际踩到：done is not defined）。 */
  try { renderShadow(d); }
  catch (e) {
    const rb = $('rankBody');
    if (rb) rb.insertAdjacentHTML('afterbegin', '<div class="gline"><i class="gw"></i><b>页面渲染异常（不是取数失败）</b>' +
      '<span class="gd">' + esc(e && e.message ? e.message : String(e)) + '</span></div>');
    if (window.console && console.error) console.error('renderShadow failed', e);
  }
};
renderShadow = function (d) {
  RD.d = d;
  const age = Date.now() / 1000 - (d.synced_at || 0);
  const ra = $('rankAge');
  if (ra) { ra.className = 'chip ' + (d.ok && age < 1200 ? 'on' : 'warn'); ra.textContent = (d.ok ? '' : '同步失败 · ') + rdBJ(d.synced_at, 'full') + ' 北京（' + rdAge(d.synced_at) + '）'; }
  const la = $('liveAge');
  if (la) {
    if (d.live) { la.className = 'chip on'; la.textContent = '实盘截止 ' + rdBJ(d.live.fetched_at, 'full') + ' 北京 · 交易所 closedPnl'; }
    else { la.className = 'chip warn'; la.textContent = '实盘：live.json 未同步'; }
  }
  const ha = $('horseAge');
  if (ha) ha.innerHTML = '<span class="chip gray">数据源：VPS 影子盘 runner（报告 ' + (d.report_ts ? rdBJ(d.report_ts, 'hm') : '--') + ' 北京）</span>';

  rdGateBanner(d);
  rdRenderRank(d);

  /* 在跑的马：逐条实时数据（沿用 cockpit.js 的卡片渲染，一字未删，只是折进 <details>） */
  const hb = $('horseBody');
  if (hb) hb.innerHTML = rdHorsesHtml(d);
  const cb = $('candBody');
  if (cb) {
    const cands = d.candidates || [];
    cb.innerHTML = cands.length
      ? '<table class="tatable"><thead><tr><th>候选</th><th>策略</th><th>版本</th><th>状态</th><th>范围</th><th>最近变更</th></tr></thead><tbody>' +
        cands.map(c => {
          const sc = c.state === 'SHADOW' ? 'y' : (c.state === 'LIVE' || c.state === 'UPGRADE' ? 'g' : (c.state === 'QUARANTINED' || c.state === 'REJECTED' ? 'r' : 'n'));
          return '<tr><td class="mono" style="font-size:10px;">' + esc(c.candidate_id) + '</td><td>' + esc(c.strategy_id || '') + '</td>' +
            '<td class="mono">' + esc(c.version || '') + '</td><td><span class="badge ' + sc + '">' + esc(c.state || '') + '</span></td>' +
            '<td style="font-size:10.5px;color:var(--dim);">' + esc(c.change_scope || '') + '</td>' +
            '<td style="font-size:10px;color:var(--faint);">' + (c.notes || []).map(esc).join('<br>') + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="disc" style="margin-top:10px;">VPS 晋级状态机（ledger/research/candidates.json）。SHADOW = 在影子/试运行，不等于已晋级。</div>'
      : '<span class="loading">没有登记候选</span>';
  }
  const lb = $('legacyBody');
  if (lb) {
    const lg = d.legacy || [];
    const old = lg.slice().sort((a, b2) => (b2.mtime || 0) - (a.mtime || 0));
    lb.innerHTML = '<div class="disc">本机旧台账里有 <b>' + lg.length + '</b> 匹早期马，最后一次更新 <b>' +
      (old[0] ? rdBJ(old[0].mtime, 'full') : '--') + ' 北京</b>；它们的 runner 早已不在，数据不再变化 —— 列在这里是为了「不假装它们不存在」，不是还在跑。' +
      '2026-09-20 另有一批<b>确定死掉</b>的机器人移到 <code>_retired-20260920/</code>（VPS 19 / 本机 14）：bot_trend、box_grid_bot、skr_clone、niulai_watch、scalp_shadow、bot_range。' +
      '判据是「无进程 ＋ 停更 ≥4 天 ＋ 无产线引用」三条同时成立；<b>没有一个是按业绩删的</b>。</div>' +
      '<table class="tatable" style="margin-top:11px;"><thead><tr><th>老马</th><th>本金</th><th>权益</th><th>累计盈亏</th><th>笔数</th><th>最后更新</th></tr></thead><tbody>' +
      old.map(x => '<tr><td>' + esc(x.horse) + '</td><td class="mono">' + fmtNum(x.capital, 1) + '</td><td class="mono">' + fmtNum(x.equity, 4) + '</td>' +
        '<td class="mono ' + cls(x.cum_pnl) + '">' + fmtNum(x.cum_pnl, 4) + '</td><td class="mono">' + (x.trades == null ? '--' : x.trades) + '</td>' +
        '<td class="mono" style="font-size:10px;color:var(--faint);">' + rdBJ(x.mtime, 'full') + '</td></tr>').join('') +
      '</tbody></table>';
  }
  rdRenderOverview();
  rdRenderPromote();
};
/* 在跑的马 / 逐条实时数据 —— 字段与旧版一致（一字未删，只换容器） */
function rdHorsesHtml(d) {
  let b = '<div class="horsegrid">';
  for (const x of (d.books || [])) {
    if (rdIsHidden(x.name)) continue;   /* ← 同一条隐藏名单：在跑的马也不显示 */
    if (x.mode === 6 || x.mode === 7 || x.kind === 'origmm' || x.kind === 'hype_mm') { b += rdMmCard(x); continue; }
    if (x.mode === 4 || x.mode === 5 || x.kind === 'signal' || x.kind === 'jev') { b += rdSigCard(x); continue; }
    const dq2 = rdDoubt(x);
    b += '<div class="horse"><div class="hh"><span class="n">' + esc(x.name) + '</span>' +
      '<span class="badge ' + (x.ret >= 0 ? 'g' : 'r') + '">' + pct(x.ret) + '</span>' +
      '<span class="s">' + esc(x.symbol) + ' @ ' + fmtPrice(x.price) + '</span></div>' +
      (dq2 ? '<div class="disc" style="color:var(--amber);margin-bottom:8px;">⚠️ <b>统计存疑</b>：名义敞口 ' + fmtNum(dq2.notional, 2) +
        'U ＝ 应有 ' + fmtNum(dq2.margin, 2) + 'U 的 <b>' + dq2.ratio.toFixed(1) + ' 倍</b>；累计盈亏里 ' + fmtNum(dq2.unreal, 2) +
        'U 是越界持仓浮盈。名次不可比，仅留档。</div>' : '') +
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
      '</div>';
  }
  b += '</div>';
  if (!(d.books || []).length && !(d.horses || []).length) b = '<span class="loading">影子盘暂无数据</span>';
  return b;
}
function rdMmCard(x) {
  const m = x.mm || {};
  const isHype = (x.mode === 7 || x.kind === 'hype_mm');
  const upMin = m.started ? Math.round((Date.now() - m.started) / 60000) : (m.minutes || null);
  const nCount = (isHype ? m.ticks : m.blocks) || 0;
  const ratio = (isHype && m.gross_no_fee_usd) ? (x.fees / m.gross_no_fee_usd) : null;
  return '<div class="horse"><div class="hh"><span class="n">' + esc(x.name) +
    '</span><span class="badge ' + ((x.ret_pct || 0) >= 0 ? 'g' : 'r') + '">' + pct(x.ret_pct) + '</span>' +
    '<span class="s">' + (isHype ? '原版做市循环 → Bybit ' : '原版 jev-trader · ') + esc(x.symbol) + ' @ ' + fmtPrice(x.price) +
    (m.dry_run ? ' · <span style="color:var(--amber);">干跑</span>' : '') + '</span></div>' +
    row('决策频率', '每 ~300ms 一次（不等信号）', 'flat') +
    row(isHype ? 'tick / 决策 / 挂单' : '区块 / 决策 / 挂单', nCount + ' / ' + (m.decisions || 0) + ' / ' + (m.quotes || 0), 'flat') +
    row('成交', (m.fills || 0) + ' 笔' + (m.decisions ? '（成交率 ' + fmtNum((m.fills || 0) / m.decisions * 100, 1) + '%）' : ''), 'flat') +
    row('超时阻塞 late', (m.late || 0) + '（' + (m.late_pct == null ? '--' : m.late_pct + '%') + '）', (m.late_pct || 0) > 20 ? 'loss' : 'flat') +
    row('模型', esc(m.model || '--') + (upMin != null ? ' · 已跑 ' + upMin + ' 分钟' : ''), 'flat') +
    row('累计盈亏', fmtNum(x.pnl_u, 4) + ' U（本金 ' + fmtNum(x.invest_u, 0) + 'U）', cls(x.pnl_u)) +
    (isHype ? row('maker 手续费', fmtNum(x.fees, 5) + ' USD', 'flat') + row('Jev 模型费', fmtNum(m.model_cost_usd, 5) + ' USD', 'flat')
            : row('模型费', fmtNum(x.fees, 5) + ' USD', 'flat')) +
    (ratio != null ? row('毛赚 vs 手续费', fmtNum(m.gross_no_fee_usd, 4) + ' vs ' + fmtNum(x.fees, 4) + ' USD（' + fmtNum(ratio, 2) + ' 倍）', ratio > 1 ? 'loss' : 'gain') : '') +
    row('盘口价差', (m.spread_bps == null ? '--' : fmtNum(m.spread_bps, 2) + ' bps') + ' · 仓位 ' + esc(x.position || '空仓'), 'flat') +
    (x.note ? '<div class="disc">' + esc(x.note) + '</div>' : '') +
    (isHype ? '<div class="disc" style="color:var(--amber);">本模拟<b>忽略排队位置</b>：挂单价在 touch 上、队列里排着 200+ HYPE，实际成交率会远低于这里。</div>' : '') +
    '</div>';
}
function rdSigCard(x) {
  const isJev = (x.kind === 'jev' || x.mode === 5);
  const stale = (x.age_sec != null && x.age_sec > 300);
  const vs = x.verify_state;
  const badge = { verified: ['g', '✓ 与驾驶舱逐条一致'], drift: ['r', '✗ 与驾驶舱不一致 —— 已停止开新仓'],
                  unverified: ['', '? 还没能核对'], none: ['', '? 无信号腿'] }[vs] || ['', '? 未上报'];
  let h = '<div class="horse"><div class="hh"><span class="n">' + esc(x.name) +
    '</span><span class="badge ' + ((x.ret_pct || 0) >= 0 ? 'g' : 'r') + '">' + pct(x.ret_pct) + '</span>' +
    '<span class="s">' + (isJev ? '⚖ Jev 闸门 · ' : '') + esc(x.symbol) + ' ' + esc(x.tf || '') + '分 @ ' + fmtPrice(x.price) +
    (stale ? ' <span class="loss">· 报告 ' + x.age_sec + 's 未更新</span>' : '') + '</span></div>' +
    row('权益 / 存款', fmtNum(x.equity, 4) + ' / ' + fmtNum(x.bank, 4) + ' U', 'flat') +
    row('阶梯进度', '第 ' + (x.rung != null ? x.rung : '--') + ' 档 → 目标 ' + fmtNum(x.rung_top, 0) + 'U · 第 ' + (x.cycle || 1) + ' 轮', 'flat') +
    row('当前仓位', esc(x.position || '--') + (x.pos_avg ? ' @ ' + fmtPrice(x.pos_avg) : '') + ' · ' + x.lev + 'x', 'flat') +
    row('累计盈亏', fmtNum(x.pnl_u, 4) + ' U（本金 ' + fmtNum(x.invest_u, 2) + 'U）', cls(x.pnl_u)) +
    row('成交 / 胜 / 负', (x.trades || 0) + ' / ' + (x.wins || 0) + ' / ' + (x.losses || 0), 'flat') +
    row('止盈 / 信号平 / 爆仓', (x.tp_hits || 0) + ' / ' + (x.signal_exits || 0) + ' / ' + (x.liquidations || 0), (x.liquidations ? 'loss' : 'flat')) +
    row('手续费', fmtNum(x.fees, 4), 'flat') +
    row('爆仓距离', (x.liq_distance_pct == null ? '--' : x.liq_distance_pct + '%'), 'flat') +
    row('信号来源', '<span class="badge ' + badge[0] + '">' + badge[1] + '</span>' +
      (x.verify_age_h == null ? '' : '（' + fmtNum(x.verify_age_h, 1) + ' 小时前）'), vs === 'drift' ? 'loss' : 'flat') +
    (x.verify_detail ? '<div class="disc">' + esc(x.verify_detail) + '</div>' : '');
  if (isJev && x.jev_stats) {
    const js = x.jev_stats, s = js._summary || {};
    h += row('Jev 判断', (s.total_decisions || 0) + ' 次 · 已验 ' + (s.resolved || 0) + ' 次 · 平均信心 ' +
      (s.avg_conviction == null ? '--' : s.avg_conviction + '/5'), 'flat');
  }
  h += (x.note ? '<div class="disc">' + esc(x.note) + '</div>' : '') + '</div>';
  return h;
}

/* 策略工坊列表（接管 loadShop：只改呈现 + 角标，提交逻辑仍在 cockpit.js，一字未动） */
loadShop = async function (force) {
  if (!force && Date.now() - (RD.lastShop || 0) < 15000) return;
  RD.lastShop = Date.now();
  try {
    const d = await getJSON(API + '/strategy/list');
    RD.shop = d;
    const sa = $('shopAge'); if (sa) sa.textContent = rdBJ(Date.now() / 1000, 'hm') + ' 北京刷新';
    const items = d.items || [];
    const stc = { '待处理': 'y', '已收到': 'y', '开发中': 'n', '已上影子盘': 'g', '已否决': 'r' };
    const pend = items.filter(it => ['待处理', '已收到', '开发中'].indexOf(it.status) >= 0).length;
    const ts = $('shopTabTs'); if (ts) ts.textContent = pend > 0 ? ('⚠ ' + pend) : '';
    const sb = $('shopBody');
    if (sb) sb.innerHTML = items.length
      ? items.map(it => '<div class="shoprow" onclick="openStrategy(\'' + esc(it.id) + '\')">' +
          '<span class="id">' + esc(it.created_at || '') + '<br>' + esc(it.id) + '</span>' +
          '<span class="nm">' + esc(it.name) + '<small>' + esc((it.note || '') || '点击看全文') + '</small></span>' +
          '<span class="mono" style="color:var(--dim);font-size:10.5px;">' + esc(it.symbol || '—') + '<br>' + esc(it.tf || '') + '</span>' +
          '<span class="st"><span class="badge ' + (stc[it.status] || 'n') + '">' + esc(it.status) + '</span></span></div>').join('')
      : '<span class="loading">还没有提交过策略。在上面写完点「生成机器人 →」。</span>';
    rdRenderOverview();
  } catch (e) {
    const sb = $('shopBody');
    if (sb) sb.innerHTML = '<span class="bad">读不到策略列表：' + esc(e.message) + ' —— 确认信号服务(8091)在跑</span>';
  }
};

/* ═══════════════ 8. 交互委托 + 启动 ═══════════════ */
document.addEventListener('click', ev => {
  const go = ev.target.closest('[data-go]');
  if (go) { setTab(go.getAttribute('data-go')); return; }
  const mo = ev.target.closest('[data-more]');
  if (mo) {
    const el = document.getElementById(mo.getAttribute('data-more'));
    if (el) el.classList.toggle('hidden');
    return;
  }
});
rdLoadStored();
/* 「刷新」角标：统一北京时间，并区分「页面刷新」（浏览器）与「快照采集」（数据）；
   不再出现本机（墨尔本）时间 —— Codex P1.4 截图里同时出现「北京 02:49」和「刷新 05:50（本机）」是错的。 */
const _rdOrigTick = tick;
function rdSyncTopClock() {
  const el = $('refresh'); if (!el) return;
  /* 页头与手动行情条共用 pos.json 的真实采集时刻；历史详情的时间留在详情区。 */
  const status = typeof cockpitTopStatus === 'function' ? cockpitTopStatus() : null;
  el.textContent = status ? status.text : '持仓/报价快照(pos)采集时间未取到';
  el.className = 'mono ' + (status && status.fresh ? 'faint' : 'bad');
  el.title = '来源 pos.json：持仓/报价快照，不是行情源 live.json；自动读取 15 秒，源每分钟采集；超过 180 秒标记过期。' +
    (status && status.error ? ' ' + status.error : '');
}
tick = async function () {
  await _rdOrigTick();
  rdSyncTopClock();
};
(function rdBoot() {
  const h0 = (location.hash || '').replace('#', '');
  const KNOWN = ['overview', 'bots', 'promote', 'live', 'shop', 'manual'];
  const start = KNOWN.indexOf(h0) >= 0 ? h0 : 'overview';
  setTab(start, true);      // 内部已按页签拉对应数据（overview/promote/bots → loadShadow；live → loadLiveDetail）
  loadShop(true);           // 总览第 1 步要显示「已提交 N 条」，开机先取一次
  tick();                   // 立刻把「刷新」角标改成「（本机）」，别和旁边的北京并排混着看
  setInterval(() => {
    const cur = (location.hash || '').replace('#', '') || 'overview';
    if (['overview', 'promote', 'bots'].indexOf(cur) >= 0) { loadShadow(false); tick(); }
    if (cur === 'live') loadLiveDetail(false);
  }, 15000);
})();
