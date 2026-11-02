/* needle-paper.js — 接针大师纸面运行状态（只读，无下单） */
(function () {
  'use strict';
  var ID = 'needlePaperCard';
  function el(tag, cls, text) { var e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }
  function bj(ms) { if(!ms)return '--'; try{return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ms));}catch(e){return '--';} }
  function render(d) {
    var host=document.getElementById(ID); if(!host) return;
    var s=d.source||{}, l=d.liveGate||{}, g=d.gate||{}, scan=d.scan||{}, rep=d.replay||{}, rs=d.research||{};
    var mode=d.mode||'--';
    var h='<div class="card"><h2>🧪 接针大师 · 纸面运行 <span class="chip gray">PAPER ONLY · 无真实下单</span></h2>'+
      '<div class="mmNote">策略：'+(d.strategyId||'--')+' / '+(d.strategyVersion||'--')+' ｜ 模式：<b>'+mode+'</b> ｜ 订单：0 ｜ 真实成交：0</div>'+
      '<div class="grid kpis" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:8px 0">'+
      '<div class="kpi"><div class="ks">数据时点（本地回放）</div><div class="kv">'+bj(s.sourceTimeMs)+' BJ</div><div class="sub">'+(s.stale?'过期/回放，不是实时':'新鲜')+'</div></div>'+
      '<div class="kpi"><div class="ks">8091 行情源</div><div class="kv">'+(l.src||'--')+'</div><div class="sub">'+(l.live_gate||'--')+'</div></div>'+
      '<div class="kpi"><div class="ks">事件 / 虚拟成交</div><div class="kv">'+(scan.n1Events||0)+' / '+(d.ledgerCount||0)+'</div><div class="sub">'+(rep.complete?'REPLAY 完整':'REPLAY 不完整')+'</div></div>'+
      '<div class="kpi"><div class="ks">闸门</div><div class="kv">'+(g.live_signal_allowed?'允许':'禁止实时信号')+'</div><div class="sub">'+(g.reason||'')+'</div></div></div>'+
      '<div class="mmNote">'+(d.ledgerCount? '虚拟账本 '+d.ledgerCount+' 笔，可追 eventId/sourceHash。' : '本回放无自然信号，虚拟成交 0；不伪造样本、不把回放当实时。')+'</div>'+
      '<div class="mmNote">P04 原研究：<b>'+(rs.status||'--')+'</b>；训练 '+(rs.trainN1Base0?rs.trainN1Base0.n+'笔/'+rs.trainN1Base0.meanBps+'bps':'--')+' · 验证 '+(rs.validationN1Base0?rs.validationN1Base0.n+'笔/'+rs.validationN1Base0.meanBps+'bps':'--')+' · 测试 '+(rs.testN1Base0?rs.testN1Base0.n+'笔/'+rs.testN1Base0.meanBps+'bps':'--')+'。未通过仍保持未通过；不按测试集调参。</div>'+
      '<details class="fold tight"><summary>口径 / 证据</summary><div class="foldin"><div class="mmSub">sourceHash '+String(s.sourceHash||'').slice(0,16)+'… · 1m rows '+(s.rows||0)+' · gaps '+(s.gaps||0)+' · 8091 lastBar '+bj(l.last_bar_ts)+'</div>'+
      '<div class="mmSub">REPLAY_ONLY：本地 1m 历史回放；8091 只有 '+(l.candles||0)+'/288 根5m，不足以做实时扫描 → 不发出实时信号。无账户/密钥/订单接口。</div></div></details></div>';
    host.innerHTML=h;
  }
  function load() { fetch('needle-paper-state.json?t='+Date.now(),{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(render).catch(function(e){var h=document.getElementById(ID);if(h)h.innerHTML='<div class="card"><h2>🧪 接针大师 · 纸面运行</h2><div class="mmErr">状态未取到：'+String(e.message||e)+'（不显示伪造在线）</div></div>';}); }
  function mount(){var pane=document.getElementById('pane-shop');if(!pane)return false;if(!document.getElementById(ID)){var box=el('div');box.id=ID;var b=pane.querySelector('#shopBody');if(b&&b.parentElement===pane)b.insertAdjacentElement('afterend',box);else pane.appendChild(box);load();setInterval(load,60000);}return true;}
  function init(){if(!mount())setTimeout(init,500);} if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
