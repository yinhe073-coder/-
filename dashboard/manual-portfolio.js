/* manual-portfolio.js — 手动交易页组合规划（研究示例，只读）
 * 目标 1,000,000 USD；价格跳动只更新估值/偏离；配置变更需点击应用并显示版本/原因。
 * 不接下单/账户/仓位；实际成本未知留空。
 */
(function () {
  'use strict';
  var MKT = 'manual_market.json', PLAN = 'manual_portfolio.json';
  var ID = 'manualPortfolioCard';
  var state = { mkt: null, plan: null, profileId: 'balanced', total: 1000000, configVersion: 'portfolio-plan-v1', configReason: '初始研究示例', configCondition: '用户未提供风险偏好/期限/持仓', appliedVersion: 'portfolio-plan-v1', history: [], timer: null };
  function el(tag, cls, text) { var e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }
  function fmtUSD(v) { return v==null || !isFinite(Number(v)) ? '--' : '$'+Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function fmtPct(v) { return v==null || !isFinite(Number(v)) ? '--' : (Number(v)>0?'+':'')+Number(v).toFixed(2)+'%'; }
  function fmtPrice(v,ccy) { return v==null || !isFinite(Number(v)) ? '--' : Number(v).toLocaleString('en-US',{maximumFractionDigits: ccy==='USDT'?2:4}); }
  function bj(iso) { if(!iso)return '--'; try{return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));}catch(e){return '--';} }
  function session(s){return ({pre:'盘前',regular:'正常',post:'盘后',closed:'休市',open_24_7:'24/7',unknown:'未知'})[s]||s||'未知';}
  function delay(d){return ({delayed_or_unknown:'延迟/未知',venue_public_live:'公开盘口·延时未核',unknown:'未知'})[d]||d||'未知';}
  function quoteFor(asset) {
    if (!state.mkt) return null;
    var arr = asset.quote_group==='stocks' ? (state.mkt.stocks||[]) : (state.mkt.usdt_pairs||[]);
    return arr.find(function(r){return r.symbol===asset.quote_symbol;}) || null;
  }
  function usdtUsd() { return state.mkt && state.mkt.fx && state.mkt.fx.usdt_usd && state.mkt.fx.usdt_usd.rate || null; }
  function profile() { return (state.plan.profiles||[]).find(function(p){return p.id===state.profileId;}) || state.plan.profiles[0]; }
  function compute() {
    var p=profile(), total=Number(state.total)||0, rows=[], sumVal=0, sumTarget=0, incomplete=false;
    var usdt=usdtUsd();
    (state.plan.assets||[]).forEach(function(a){
      var w=Number(p.weights[a.id]||0), target=total*w, q=quoteFor(a), ref=Number(a.ref_entry);
      var refUsd = a.quote_currency==='USDT' ? ref*(a.ref_usdt_usd||usdt||0) : ref;
      var qty = refUsd>0 ? target/refUsd : null;
      var cur = q && q.price!=null ? Number(q.price) : null;
      var curUsd = cur==null ? null : (a.quote_currency==='USDT' ? cur*(usdt||0) : cur);
      var val = (curUsd==null || qty==null) ? null : qty*curUsd;
      if (val==null) incomplete=true; else sumVal += val;
      sumTarget += target;
      rows.push({asset:a,weight:w,target:target,qty:qty,ref:ref,refUsd:refUsd,current:cur,currentUsd:curUsd,value:val,deviation:val==null?null:val-target,quote:q});
    });
    var cashW=Number(p.weights.CASH||0), cash=total*cashW; sumTarget+=cash; sumVal+=cash;
    rows.push({cash:true,asset:{id:'CASH',name:'现金 USD',quote_currency:'USD',research:{source:'基准现金',date:'—',note:'美元现金；不与 USDT/CNY 混同'}},weight:cashW,target:cash,qty:cash,ref:1,refUsd:1,current:1,currentUsd:1,value:cash,deviation:0,quote:{source:'USD cash',market_session:'n/a',delay_status:'n/a',source_time:null}});
    return {rows:rows,total:total,sumVal:sumVal,sumTarget:sumTarget,incomplete:incomplete,p:p};
  }
  function table() {
    var c=compute(), h='<div class="mmBlock"><div class="mmTitle">组合规划（研究示例，非个人适合仓位）</div>'+
      '<div class="mmNote">基准：<b>USD ' + Number(c.total).toLocaleString() + '</b>；目标比例合计 100%（含现金）。价格跳动只更新估值/偏离；目标数量按参考建仓价固定。实际成本未提供，留空；加密报价 USDT，按 USDT/USD 折算（USDT≠USD）。</div>'+
      '<div class="mpControls"><label>总目标 USD <input id="mpTotal" type="number" min="0" step="10000" value="'+c.total+'"></label> <label>研究情景 <select id="mpProfile">'+
      (state.plan.profiles||[]).map(function(p){return '<option value="'+p.id+'"'+(p.id===state.profileId?' selected':'')+'>'+p.name+'</option>';}).join('')+
      '</select></label> <button class="mbtn" id="mpApply" type="button">应用配置</button> <span class="mmSub">当前版本 '+String(state.appliedVersion)+' · '+String(state.configReason)+'</span></div>'+
      '<div class="mmWrap"><table class="mmTable"><thead><tr><th>资产</th><th>目标比例</th><th>目标 USD 额</th><th>参考建仓价/区间</th><th>目标数量</th><th>现价（USD）</th><th>估值 USD</th><th>偏离</th><th>实际成本</th><th>报价源/时间/状态</th></tr></thead><tbody>';
    c.rows.forEach(function(r){
      var a=r.asset, q=r.quote||{}, qc=a.quote_currency||'USD', band=a.band?(' ['+Number(a.band[0]).toLocaleString()+'–'+Number(a.band[1]).toLocaleString()+']'):'';
      var priceUsd=r.currentUsd==null?'--':fmtPrice(r.currentUsd,'USD');
      var native=r.cash?'USD现金':(r.current==null?'--':fmtPrice(r.current,qc)+' '+qc);
      var dev=r.deviation==null?'--':(fmtUSD(r.deviation)+' / '+fmtPct(r.target?r.deviation/r.target*100:null));
      h+='<tr><td><b>'+(a.id||'CASH')+'</b><div class="mmSub">'+(a.class||'')+'</div></td>'+
        '<td>'+(r.weight*100).toFixed(0)+'%</td><td class="mono">'+fmtUSD(r.target)+'</td>'+
        '<td class="mono">'+(r.cash?'1 USD':(fmtPrice(r.ref,qc)+' '+qc+band))+'</td>'+
        '<td class="mono">'+(r.qty==null?'--':r.qty.toFixed(r.cash?2:4))+'</td>'+
        '<td class="mono">'+priceUsd+'<div class="mmSub">'+(r.cash?'':native)+'</div></td>'+
        '<td class="mono">'+fmtUSD(r.value)+'</td><td class="mono">'+dev+'</td>'+
        '<td class="mmSub">—（未提供）</td>'+
        '<td><div>'+String(q.source||'—')+'</div><div class="mmSub">'+bj(q.source_time)+' · '+session(q.market_session)+' · '+delay(q.delay_status)+'</div></td></tr>';
    });
    h+='<tr class="mpTotal"><td><b>合计</b></td><td><b>100%</b></td><td class="mono"><b>'+fmtUSD(c.total)+'</b></td><td>—</td><td>—</td><td>—</td><td class="mono"><b>'+fmtUSD(c.incomplete?null:c.sumVal)+'</b></td><td class="mono"><b>'+(c.incomplete?'--':fmtUSD(c.sumVal-c.total)+' / '+fmtPct((c.sumVal-c.total)/c.total*100))+'</b></td><td>—</td><td class="mmSub">'+(c.incomplete?'有报价缺失，估值不完整':'')+'</td></tr>';
    h+='</tbody></table></div>';
    h+='<div class="mmNote">配置变更：选择情景/修改总额后点“应用配置”才生效；会显示版本/原因，不自动下单。价格更新只改现价、估值、偏离。</div>';
    h+='<details class="fold tight"><summary>研究依据/来源（不是研报全文）</summary><div class="foldin">';
    (state.plan.assets||[]).forEach(function(a){var r=a.research||{}; h+='<div class="mmSub">'+a.id+'：'+String(r.source||'—')+' · '+String(r.date||'—')+' · <a href="'+String(r.url||'')+'" target="_blank" rel="noreferrer">'+(r.url?'链接':'—')+'</a> · '+String(r.note||'')+'</div>';});
    h+='<div class="mmSub">数据：'+String(state.mkt&&state.mkt.stocks_source||'')+' / '+String(state.mkt&&state.mkt.pairs_source||'')+'；USDT/USD='+(usdtUsd()||'缺失')+'（USDT 不是 USD）。</div></div></details></div>';
    return h;
  }
  function render() {
    var host=document.getElementById(ID); if(!host) return;
    if(!state.mkt||!state.plan){ host.innerHTML='<div class="card"><h2>组合规划（研究示例）</h2><div class="mmErr">未取到行情/规划数据（不显示 0，不冒充当前）。</div></div>'; return; }
    host.innerHTML='<div class="card"><h2>组合规划（研究示例） <span class="chip gray">USD '+Number(state.total).toLocaleString()+' · 不发订单</span></h2>'+table()+'</div>';
    var ap=document.getElementById('mpApply'); if(ap) ap.onclick=applyConfig;
  }
  function applyConfig() {
    var t=Number((document.getElementById('mpTotal')||{}).value||state.total);
    var pid=(document.getElementById('mpProfile')||{}).value||state.profileId;
    if(!(t>0)) return;
    var p=(state.plan.profiles||[]).find(function(x){return x.id===pid;})||profile();
    state.total=t; state.profileId=pid; state.configVersion=(p.version||'portfolio-plan-v1')+'/config'+(state.history.length+1);
    state.configReason='研究情景切换（非策略信号/非个人建议）：'+p.name+'；'+String(p.condition||'');
    state.configCondition=String(p.condition||'');
    state.appliedVersion=state.configVersion;
    state.history.push({at:new Date().toISOString(),version:state.configVersion,reason:state.configReason,total:t,profile:pid});
    render();
  }
  function load() {
    Promise.all([
      fetch(MKT+'?t='+Date.now(),{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('行情 HTTP '+r.status);return r.json();}),
      fetch(PLAN+'?t='+Date.now(),{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('规划 HTTP '+r.status);return r.json();})
    ]).then(function(a){state.mkt=a[0];state.plan=a[1]; if(!state.plan.profiles.some(function(p){return p.id===state.profileId;})) state.profileId=state.plan.profiles[0].id; if(!state._initLoaded){ if(state.plan.total_target) state.total=state.plan.total_target; state._initLoaded=true;} render();})
      .catch(function(e){state.mkt=null;state.plan=null;render();});
  }
  function mount(){
    var pane=document.getElementById('pane-manual'); if(!pane)return false;
    if(!document.getElementById(ID)){
      var box=el('div');box.id=ID;
      var m=document.getElementById('manualMarketCard')||pane.querySelector('.mktbar');
      if(m&&m.parentElement===pane) m.insertAdjacentElement('afterend',box); else pane.insertBefore(box,pane.firstChild);
      var st=document.createElement('style');
      st.textContent='.mpControls{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:8px 0}.mpControls input,.mpControls select{background:#0f1824;border:1px solid #2a3a50;color:#e8eef7;border-radius:6px;padding:5px 8px}.mpTotal td{border-top:1px solid #4a5f7a;background:#101a27}';
      document.head.appendChild(st);
      load(); if(state.timer)clearInterval(state.timer);state.timer=setInterval(load,60000);
    }
    return true;
  }
  function init(){if(!mount())setTimeout(init,400);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
