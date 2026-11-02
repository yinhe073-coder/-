/* readiness-strip.js v7 — 设计式精简；无长度隐藏；错误必显示 */
(function(){
  'use strict';
  function bj(v){ try{ if(v==null||v==='')return '未取到'; var n; if(typeof v==='number'){n=v;if(n<1e12)n*=1000;}else{n=Date.parse(String(v));if(isNaN(n))return '时间未取到';} var d=new Date(n); if(isNaN(d.getTime())||d.getTime()>Date.now()+300000)return '时间未取到'; return new Date(n+8*3600000).toISOString().slice(0,16).replace('T',' ')+' 北京'; }catch(e){ return '时间未取到'; } }
  function ageOf(v){ try{ if(v==null||v==='')return '源时间缺失'; var n=typeof v==='number'?(v<1e12?v*1000:v):Date.parse(String(v)); if(isNaN(n))return '源时间不可读'; var s=Math.round((Date.now()-n)/1000); if(s<0)return '时钟异常(未来'+Math.abs(s)+'秒)'; if(s<60)return s+'秒前'; if(s<3600)return Math.round(s/60)+'分钟前'; return (s/3600).toFixed(1)+'小时前'; }catch(e){ return '源时间不可读'; } }
  function exchTime(ob){ try{ var t=ob&&ob.source_time; if(!t)return null; return t.wallet_server_time_ms||t.positions_server_time_ms||t.position_updated_ms||null; }catch(e){ return null; } }
  function exchAge(ob, limitSec){ try{ var t=exchTime(ob); if(t==null)return '未知（交易所原始时间缺失）'; var n=Number(t); var s=Math.round((Date.now()-n)/1000); if(s<0)return '无效（未来'+Math.abs(s)+'秒）'; if(s>limitSec)return ageOf(n)+' ⚠过期'; return ageOf(n)+' ✓新鲜'; }catch(e){ return '源时间不可读'; } }
  var css=document.createElement('style');
  css.textContent='.rdyCard{background:#11161f;border:1px solid #2a3547;border-radius:10px;padding:10px 12px;margin:8px 0;color:#dbe4f3;font-size:13px;line-height:1.6}.rdyCard b{color:#fff}.rdySmall{color:#8fa3c0;font-size:12px}.rdyBtn{margin:6px 8px 0 0;padding:6px 12px;border-radius:8px;border:1px solid #3b4a63;background:#1b2536;color:#e6eeff;cursor:pointer;font-size:13px}.warn{color:#ffcf7a}.ok{color:#8ee6a3}.miss{color:#ff9b9b}#rdyLive table{border-collapse:collapse;width:100%;font-size:12px}#rdyLive td,#rdyLive th{border-bottom:1px solid #223047;padding:2px 6px;text-align:left}';
  document.head.appendChild(css);
  var lv=null,ps=null,dt=null;
  var hpScan=null,shSync=null; async function load(){ try{lv=await (await fetch('live.json?t='+Date.now(),{cache:'no-store'})).json()}catch(e){lv=null} try{ps=await (await fetch('pos.json?t='+Date.now(),{cache:'no-store'})).json()}catch(e){ps=null} try{dt=await (await fetch('live_detail.json?t='+Date.now(),{cache:'no-store'})).json()}catch(e){dt=null} try{hpScan=await (await fetch('hengpan-scan.json?t='+Date.now(),{cache:'no-store'})).json()}catch(e){hpScan=null} try{shSync=await (await fetch('shadow.json?t='+Date.now(),{cache:'no-store'})).json()}catch(e){shSync=null} }
  function account(){ return (dt&&dt.account)||{}; }
  function extra(){ return (dt&&dt.account_extra)||{}; }
  function bot(){ return (dt&&dt.bots&&dt.bots[0])||null; }
  function ov(){
    var host=document.getElementById('rdyData'); if(!host)return;
    try{
      var arr=(ps&&ps.positions)||[]; var b=bot();
      host.innerHTML='<div class="rdyCard"><b>实盘 HYPE</b> '+(b&&b.process?'<span class="ok">采集到进程 pid '+b.process.pid+'</span>':'<span class="warn">进程状态未取到</span>')+'<div class="rdySmall">账户源(交易所) '+(exchTime(lv)?bj(exchTime(lv)):'缺失')+'（'+exchAge(lv,180)+'；阈值180s）· 本机采集/接收 '+(lv?bj(lv.fetched_at):'未取到')+' · 权益 '+(lv&&lv.equity_now!=null?Number(lv.equity_now).toFixed(4)+'U':'未取到')+' · 持仓 '+arr.length+' 腿 · 页面读取 '+bj(new Date().toISOString())+'</div><div>'+arr.map(function(p){return p.sym+' '+p.side+' '+p.size+'@'+p.avg}).join(' · ')+'</div></div>'
        +'<div class="rdyCard"><b>网格 skr / 克隆塔</b> <span class="warn">当前状态未核实</span><div class="rdySmall">不以旧日志下结论；资金动作归操作者。</div></div>'
        +'<div class="rdyCard"><b>DOGE / MM</b> <span class="warn">状态未核实</span><div class="rdySmall">诊断与隔离修复在对话侧进行。</div></div>'
        +'<div class="rdyCard"><button class="rdyBtn" id="rdyRefresh">刷新</button><button class="rdyBtn" id="rdyArchive">历史档案</button><button class="rdyBtn" id="rdyLiveBtn">实盘入口（放行）</button></div>';
      try{var hpAge=hpScan?ageOf(hpScan.updated_at):'扫描未取到';var shAge=shSync&&shSync.synced_at?ageOf(shSync.synced_at*1000):'shadow未取到';var hpOk=!!(hpScan&&hpScan.updated_at);var shFresh=false;try{if(shSync&&shSync.synced_at){var ss=Math.round(Date.now()/1000-shSync.synced_at);shFresh=ss>=-60&&ss<=1200;}}catch(e){} var bar=document.createElement('div');bar.className='rdyCard';bar.innerHTML='<b>衡盘扫描 / 影子同步</b> <span class="'+(hpOk?'ok':'miss')+'">'+(hpOk?'扫描已更新 · '+hpAge:'扫描未更新')+'</span> · <span class="'+(shFresh?'ok':'warn')+'">shadow '+(shFresh?'同步龄 '+shAge:'同步 '+shAge)+'</span><div class="rdySmall">源 hengpan-scan.json / shadow.json · 研究口径不代下单 · 页面另有「衡盘扫描」卡每10秒轮询</div>'; host.appendChild(bar);}catch(e){}
document.getElementById('rdyRefresh').onclick=async function(){await load();ov();live();};
      document.getElementById('rdyArchive').onclick=function(){location.href='archive/index.html';};
      document.getElementById('rdyLiveBtn').onclick=function(){try{setTab('live')}catch(e){};setTimeout(live,800);};
    }catch(e){ host.innerHTML='<div class="rdyCard miss">总览渲染失败：'+e.message+'</div>'; }
  }
  function live(){
    var pane=document.getElementById('pane-live'); if(!pane)return;
    try{
      var arr=(ps&&ps.positions)||[],a=account(),ex=extra(),b=bot();
      var btn=document.getElementById('liveStartBtn'),keep=null;
      if(btn){var n=btn;while(n&&n.parentElement!==pane){n=n.parentElement}if(n)keep=n;}
      var ph='<table><tr><th>腿</th><th>数量</th><th>均价</th><th>标记</th><th>杠杆</th><th>强平价</th><th>浮盈</th></tr>';
      arr.forEach(function(p){ph+='<tr><td>'+p.sym+' '+p.side+'</td><td>'+p.size+'</td><td>'+p.avg+'</td><td>'+p.mark+'</td><td>'+p.lev+'x</td><td>'+((p.liq===''||p.liq==null)?'<span class="warn">未给出</span>':p.liq)+'</td><td>'+p.upnl+'</td></tr>'});
      ph+='</table>';
      var exRows=(b&&b.executions)||[];
      var box=document.createElement('div'); box.id='rdyLive';
      box.innerHTML='<div class="rdyCard"><b>实盘当前状态</b><div class="rdySmall">账户源(交易所) '+(exchTime(dt)?bj(exchTime(dt)):'未知（交易所原始时间缺失，不用本机时间冒充）')+'（'+exchAge(dt,600)+'；阈值600s） · 本机生成/接收 '+(dt&&dt.updated_at?bj(dt.updated_at):'未取到')+' · 行情源(交易所) '+(exchTime(lv)?bj(exchTime(lv)):'未知（交易所原始时间缺失）')+'（'+exchAge(lv,180)+'；阈值180s） · 本机采集 '+(lv?bj(lv.fetched_at):'未取到')+' · 页面读取 '+bj(new Date().toISOString())+'</div>'
        +'<div>权益 '+(a.equity==null?'未取到':Number(a.equity).toFixed(4))+'U · 可用 '+(a.available==null?'未取到':Number(a.available).toFixed(4))+'U · 初始保证金 '+(a.im==null?'未取到':Number(a.im).toFixed(4))+'U · 维持保证金 '+(a.mm==null?'未取到':Number(a.mm).toFixed(4))+'U</div>'
        +'<div>进程：'+(b&&b.process?('pid '+b.process.pid+' · '+b.process.script):'<span class="warn">未取到</span>')+'</div></div>'
        +'<div class="rdyCard"><b>持仓</b>'+ph+'</div>'
        +'<div class="rdyCard"><b>挂单 / 成交</b><div>挂单：'+(ex.open_orders_total==null?'未取到':ex.open_orders_total+' 笔')+'（全部见档案）</div><div>成交：共 '+((b&&b.executions_total)||exRows.length)+' 笔；最近 3 笔：</div>'
        +exRows.slice(0,3).map(function(t){return '<div class="rdySmall">'+((t.t||'').slice(5,16))+' '+t.side+' '+t.qty+' PnL '+(t.closed_pnl==null?'':Number(t.closed_pnl).toFixed(4))+'</div>'}).join('')+'</div>';
      pane.innerHTML=''; if(keep)pane.appendChild(keep); pane.appendChild(box);
    }catch(e){ pane.innerHTML='<div class="rdyCard miss">实盘页渲染失败：'+e.message+'</div>'; }
  }
  async function boot(){ await load(); var p=document.getElementById('pane-overview'); if(p&&!document.getElementById('rdyData')){var d=document.createElement('div');d.id='rdyData';p.insertBefore(d,p.firstChild);} ov(); live(); setTimeout(live,2500); }
  document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-tab]');if(t){setTimeout(live,900);setTimeout(live,2600);}},true);
  boot();
})();