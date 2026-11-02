/* Needle Master: local, frozen research display. No submit, broker or runtime hooks. */
(function () {
  'use strict';
  const CONTRACT = 'f5e500a422fc80b76058037fb9350425f4e44b07826fa17431f88c1f04eccd70';
  const SCHEMA = 'needle-master-research-summary/v1';
  const MAX_BYTES = 524288;
  const VARIANTS = [['N1', 'N1 · 接针＋首分钟确认'], ['N0', 'N0 · 不等确认（对照）'], ['C0', 'C0 · 不限针形（对照）']];
  const COSTS = [['RESEARCH_BASE', '基础费用假设'], ['STRESS', '成本压力情境'], ['GROSS_REFERENCE', '无摩擦参考']];
  const LATENCIES = [['0', '下一分钟开盘（理想零延迟）'], ['1', '再延迟 1 分钟']];
  const PARTITIONS = [
    ['train', '训练段', '2026-03-12T00:00:00Z', '2026-07-01T00:00:00Z'],
    ['validation', '验证段', '2026-07-01T00:00:00Z', '2026-08-16T00:00:00Z'],
    ['test', '测试段', '2026-08-16T00:00:00Z', '2026-10-06T00:00:00Z'],
    ['recentDiagnostic', '近期诊断', '2026-10-12T00:00:00Z', '2026-10-16T00:00:00Z']
  ];
  const refs = {};
  let data = null;
  let loading = false;
  let mounted = false;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  const short = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;
  const ensure = (ok, why) => { if (!ok) throw new Error(why); };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function append(parent, ...children) { children.forEach(child => parent.appendChild(child)); return parent; }
  function detail(title, content) {
    const box = el('details', 'nr-details');
    append(box, el('summary', '', title), el('p', 'nr-detail-text', content));
    return box;
  }
  function select(label, options, key) {
    const wrap = el('label', 'nr-select-label');
    const control = el('select', 'nr-select');
    control.id = 'needle-' + key;
    options.forEach(([value, text]) => { const opt = el('option', '', text); opt.value = value; control.appendChild(opt); });
    control.value = options[0][0];
    control.addEventListener('change', renderRows);
    refs[key] = control;
    return append(wrap, el('span', '', label), control);
  }
  function mount() {
    if (mounted || document.getElementById('needleResearchRoot')) return false;
    const pane = document.getElementById('pane-shop');
    if (!pane) return false;
    const root = el('section', 'card nr-card');
    root.id = 'needleResearchRoot';
    root.setAttribute('aria-labelledby', 'needleResearchTitle');
    const title = el('h2', '', '接针大师'); title.id = 'needleResearchTitle';
    const header = append(el('div', 'nr-header'), title, el('span', 'nr-off', 'OFF · 研究'));
    const rules = el('div', 'nr-rule-grid');
    [
      ['找爆量下针', '5分钟量 ≥ 前24小时均量的3倍'],
      ['等首分钟反弹', '第一根1分钟收盘确认后，下一开盘模型入场'],
      ['限制退出', '低点−0.1ATR止损 · 1.5R止盈 · 最长15分钟']
    ].forEach(([head, body]) => rules.appendChild(append(el('div', 'nr-rule'), el('b', '', head), el('span', '', body))));
    const context = el('p', 'nr-context', '离线历史回放，未在运行模拟或实盘。HYPEUSDT仅为研究数据品种；这些参数尚未确认用于实盘。');
    const controls = append(el('div', 'nr-controls'), select('规则', VARIANTS, 'variant'), select('费用', COSTS, 'cost'), select('入场延迟', LATENCIES, 'latency'));
    refs.costNote = el('p', 'nr-cost-note');
    const table = el('table', 'nr-table');
    const head = el('tr');
    ['分区（UTC）', '成交数', '均值（bps）', '胜率', '最大回撤¹', '研究判断'].forEach(t => head.appendChild(el('th', '', t)));
    table.appendChild(append(el('thead'), head));
    refs.tbody = el('tbody'); table.appendChild(refs.tbody);
    refs.status = el('p', 'nr-status', '正在读取本地研究摘要…'); refs.status.setAttribute('aria-live', 'polite');
    refs.errorDetail = el('p', 'nr-error-detail'); refs.errorDetail.hidden = true;
    const retry = el('button', 'mbtn', '刷新研究结果'); retry.type = 'button'; retry.addEventListener('click', refresh); refs.retry = retry;
    const draft = el('button', 'mbtn', '仅填入策略草稿'); draft.type = 'button'; draft.addEventListener('click', fillDraft);
    refs.draftMessage = el('span', 'nr-draft-message'); refs.draftMessage.setAttribute('aria-live', 'polite');
    refs.reportLink = el('a', 'nr-report-link', '查看完整研究报告'); refs.reportLink.hidden = true;
    refs.reportLink.target = '_blank'; refs.reportLink.rel = 'noopener noreferrer';
    refs.provenance = el('p', 'nr-detail-text', '尚无已发布结果，不显示收益占位值。');
    const evidence = el('details', 'nr-details'); append(evidence, el('summary', '', '数据来源与研究边界'), refs.provenance, refs.reportLink);
    append(root, header, context, rules,
      detail('展开固定规则', 'N1为主规则：下扎≥0.8%且≥此前ATR14的1.5倍；下影占振幅≥50%，收盘收回≥65%。只用此前288根完整5分钟计算24小时均量。针线闭盘后仅看第一根1分钟：收阳、收盘高于针线收盘、低点高于针线低点，失败不追认后续反弹。单仓，出场后冷却30分钟。N0、C0是固定对照，切换仅改变表格显示。'),
      controls, refs.costNote, append(el('div', 'nr-table-scroll'), table), refs.status, refs.errorDetail,
      el('p', 'nr-footnote', '¹ 回撤为100个抽象初始研究单位的逐分钟盯市回撤；非账户金额。均值已计所选费用与滑点，未包含资金费。'),
      append(el('div', 'nr-actions'), retry, draft, refs.draftMessage), evidence);
    pane.insertBefore(root, pane.firstChild);
    mounted = true;
    renderRows();
    return true;
  }

  function exactSet(value, expected, label) {
    ensure(Array.isArray(value) && value.length === expected.length && new Set(value).size === value.length && expected.every(v => value.includes(v)), label);
  }
  function validate(input) {
    ensure(object(input) && input.schema === SCHEMA, '摘要格式不匹配');
    ensure(input.contractSha256 === CONTRACT, '研究合同版本不匹配');
    ensure(typeof input.codeSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.codeSha256), '缺少有效的冻结代码摘要');
    ensure(short(input.generatedAtUtc, 64) && Number.isFinite(Date.parse(input.generatedAtUtc)), '缺少有效的摘要时刻');
    ensure(Array.isArray(input.dataSources) && input.dataSources.length > 0 && input.dataSources.length <= 4 && input.dataSources.every(s => object(s) && typeof s.sha256 === 'string' && /^[a-f0-9]{64}$/.test(s.sha256)), '数据来源摘要缺失或无效');
    ensure(input.primary === 'N1' && input.instrument === 'HYPEUSDT', '研究品种或主规则不匹配');
    ensure(short(input.status, 160), '摘要缺少研究状态');
    if (own(input, 'mode')) ensure(input.mode === 'OFFLINE_REPLAY', '摘要不是离线回放');
    if (own(input, 'liveEnabled')) ensure(input.liveEnabled === false, '摘要包含非关闭的实盘状态');
    if (own(input, 'paperRunning')) ensure(input.paperRunning === false, '摘要包含运行中的模拟状态');
    exactSet(input.variants, ['N1', 'N0', 'C0'], '规则集合不匹配');
    exactSet(input.costs, ['GROSS_REFERENCE', 'RESEARCH_BASE', 'STRESS'], '费用集合不匹配');
    exactSet(input.latencies, [0, 1], '延迟集合不匹配');
    ensure(Array.isArray(input.partitions) && input.partitions.length <= 4, '分区格式错误');
    const seen = new Set();
    input.partitions.forEach(p => {
      ensure(object(p), '分区不是对象');
      const fixed = PARTITIONS.find(x => x[0] === p.id);
      ensure(fixed && !seen.has(p.id), '分区重复或未知'); seen.add(p.id);
      ensure(Date.parse(p.startUtc) === Date.parse(fixed[2]) && Date.parse(p.endExclusiveUtc) === Date.parse(fixed[3]), '分区时间不匹配');
      ensure(Array.isArray(p.results) && p.results.length <= 18, '分区情境格式错误');
      const cases = new Set();
      p.results.forEach(r => {
        ensure(object(r) && input.variants.includes(r.variant) && input.costs.includes(r.cost) && input.latencies.includes(r.latencyMinutes), '结果情境未知');
        const key = r.variant + '/' + r.cost + '/' + r.latencyMinutes;
        ensure(!cases.has(key), '结果情境重复'); cases.add(key);
        ensure(integer(r.n) && integer(r.tradeDays) && r.tradeDays <= r.n, '成交分母错误');
        ensure(r.n === 0 ? r.meanNetBps === null && r.medianNetBps === null && r.winRate === null : finite(r.meanNetBps) && finite(r.medianNetBps) && finite(r.winRate) && r.winRate >= 0 && r.winRate <= 1, '均值或胜率缺失/无效');
        ensure(finite(r.maxMTMDrawdownUnits) && r.maxMTMDrawdownUnits >= 0 && short(r.assessment, 160), '回撤或研究判断无效');
      });
    });
    return input;
  }
  function cell(value, cls) { return el('td', cls || '', value); }
  function number(value, digits) { return value === null ? '—' : value.toFixed(digits); }
  function assessment(value) {
    const map = {
      INSUFFICIENT_SAMPLE: '样本不足', REJECTED: '未显示稳健优势', NO_DEMONSTRATED_ROBUST_EDGE: '未显示稳健优势',
      REJECTED_NO_ROBUST_EDGE: '未显示稳健优势', REJECTED_NONPOSITIVE_MEAN: '费用后均值非正',
      UNKNOWN_CENSORED_REPLAY: '回放不完整，结果待核', FRICTIONLESS_REFERENCE_ONLY: '无摩擦参考',
      CANDIDATE_FURTHER_PAPER_ONLY: '仅候选，待后续观察',
      TENTATIVE_PAPER_CANDIDATE_PENDING_REVIEW: '仅研究候选，待复核',
      TENTATIVE_PAPER_CANDIDATE_PENDING_INDEPENDENT_REVIEW: '仅研究候选，待独立复核',
      PENDING: '待研究/审核'
    };
    return map[value] || value;
  }
  function safeReport(href) {
    if (!short(href, 512)) return null;
    try {
      const url = new URL(href, location.href);
      const prefix = new URL('./needle-master/', location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith(prefix.pathname) || url.username || url.password || url.search || url.hash || !/\.(?:md|html|json)$/.test(url.pathname)) return null;
      const relative = url.pathname.slice(prefix.pathname.length);
      if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split('/').some(piece => !piece || piece === '.' || piece === '..')) return null;
      return url.href;
    } catch (_) { return null; }
  }
  function renderRows() {
    if (!mounted) return;
    const cost = refs.cost.value, latency = Number(refs.latency.value), variant = refs.variant.value;
    const descriptions = {
      RESEARCH_BASE: '基础假设：双边各5.5bps手续费，每边2bps不利滑点。',
      STRESS: '压力假设：双边各8bps手续费，每边10bps不利滑点。',
      GROSS_REFERENCE: '无费用、无滑点的理想参考，不代表实际可成交或盈利。'
    };
    refs.costNote.textContent = descriptions[cost] + (latency === 0 ? ' 入场按下一分钟开盘的理想零延迟模型。' : ' 入场再延迟1分钟。') + ' 均未计资金费，非实际账户费率。';
    clear(refs.tbody);
    if (!data) {
      const row = el('tr'); const empty = cell('等待发布冻结研究摘要，不以0代替未知收益。', 'nr-empty'); empty.colSpan = 6; row.appendChild(empty); refs.tbody.appendChild(row); return;
    }
    PARTITIONS.forEach(([id, label, start, end]) => {
      const p = data.partitions.find(x => x.id === id);
      const r = p && p.results.find(x => x.variant === variant && x.cost === cost && x.latencyMinutes === latency);
      const name = cell(''); append(name, el('b', '', label), el('small', '', start.slice(0, 10) + ' 至 ' + end.slice(0, 10) + '（右端不含）'));
      const row = append(el('tr'), name);
      if (!r) { const empty = cell('此情境结果尚未发布', 'nr-empty'); empty.colSpan = 5; row.appendChild(empty); }
      else {
        append(row, cell(r.n), cell(number(r.meanNetBps, 3)), cell(r.winRate === null ? '—' : (r.winRate * 100).toFixed(1) + '%'), cell(number(r.maxMTMDrawdownUnits, 5)), cell(assessment(r.assessment)));
      }
      refs.tbody.appendChild(row);
    });
  }
  async function boundedText(response) {
    const declared = Number(response.headers && response.headers.get('content-length'));
    ensure(!Number.isFinite(declared) || declared <= MAX_BYTES, '摘要文件过大');
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let total = 0, text = '';
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          ensure(total <= MAX_BYTES, '摘要文件过大');
          text += decoder.decode(part.value, { stream: true });
        }
        return text + decoder.decode();
      } catch (e) { try { await reader.cancel(); } catch (_) {} throw e; }
    }
    const text = await response.text();
    ensure(new TextEncoder().encode(text).byteLength <= MAX_BYTES, '摘要文件过大');
    return text;
  }
  async function refresh() {
    if (!mounted || loading) return;
    loading = true; refs.retry.disabled = true;
    refs.status.textContent = '正在读取本地研究摘要…'; refs.errorDetail.hidden = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const url = new URL('./needle-master/research-summary.json', location.href);
      ensure(url.origin === location.origin, '只允许读取本机同源研究摘要');
      const response = await fetch(url.href, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
      if (response.status === 404) {
        data = null; refs.status.textContent = '研究结果尚未发布。规则已固定，等待离线回放及审核。'; refs.provenance.textContent = '尚无已发布结果，不显示收益占位值。'; refs.reportLink.hidden = true; renderRows(); return;
      }
      ensure(response.ok, '读取摘要失败（HTTP ' + response.status + '）');
      const parsed = validate(JSON.parse(await boundedText(response)));
      data = parsed;
      refs.status.textContent = '已读取历史研究摘要。研究状态：' + assessment(parsed.status) + '；不代表实盘选版或已在运行。';
      const time = typeof parsed.generatedAtUtc === 'string' && Number.isFinite(Date.parse(parsed.generatedAtUtc)) ? parsed.generatedAtUtc : '未提供';
      refs.provenance.textContent = '摘要时刻（UTC）：' + time + '。合同：' + CONTRACT.slice(0, 12) + '…；数据与完整验收边界见原报告。近期数据为官方逐笔自聚合，非规范REST K线；旧样本也不保证训练外。';
      const report = safeReport(parsed.reportHref);
      refs.reportLink.hidden = !report;
      if (report) refs.reportLink.href = report;
      renderRows();
    } catch (e) {
      data = null; refs.reportLink.hidden = true;
      refs.status.textContent = '研究摘要读取失败，已停止显示结果。可稍后刷新。';
      refs.errorDetail.textContent = String(e && e.message || e).slice(0, 240); refs.errorDetail.hidden = false;
      refs.provenance.textContent = '未得到有效的冻结研究摘要，不显示历史缓存或收益占位值。'; renderRows();
    } finally { clearTimeout(timer); loading = false; refs.retry.disabled = false; }
  }
  function fillDraft() {
    const fields = ['stName', 'stSym', 'stTf', 'stText'].map(id => document.getElementById(id));
    if (fields.some(x => !x)) { refs.draftMessage.textContent = '原策略草稿区不可用，未填入或提交。'; return; }
    const text = '接针大师（研究草稿，OFF）：HYPEUSDT仅为研究数据品种，非已选实盘。N1：5分钟完整针线，成交量≥此前24小时均量3倍，下扎≥0.8%且≥此前ATR14的1.5倍，下影≥50%、收回≥65%；仅首个1分钟闭盘收阳、突破针线收盘且不破低，下一分钟开盘模型入场。止损针低−0.1ATR，止盈1.5R，最长15分钟，出场冷却30分钟。N0/C0为固定对照。费用、滑点与延迟均为研究假设；不含资金费。要求先按冻结合同离线回放和独立审核，参数未经实盘确认。本次仅填草稿，不提交、不启动模拟/实盘。';
    ['接针大师 · 研究草稿', 'HYPEUSDT', '5分钟事件 / 1分钟确认', text].forEach((value, i) => { fields[i].value = value; });
    fields.forEach(field => field.dispatchEvent(new Event('input', { bubbles: true })));
    refs.draftMessage.textContent = '已填入下方草稿，尚未提交。';
    if (typeof fields[3].focus === 'function') fields[3].focus();
  }
  function init() { if (mount()) refresh(); }
  window.NeedleResearch = Object.freeze({ refresh, schema: SCHEMA, contractSha256: CONTRACT });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
