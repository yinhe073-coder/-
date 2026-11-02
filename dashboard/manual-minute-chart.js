/* Same-source minute chart annotations. No network, order or account operations. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ManualMinuteChart = api; api.mount(root, root.document); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var latest = null, win = null, summaryNode = null, toggle = null, fingerprint = '';
  var LABEL = { confirmed: '已确认', expired: '历史·到期', invalidated: '历史·失效', watching: '观察·未确认' };
  function escape(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function price(n) { return Number(n).toLocaleString('en-US', {maximumFractionDigits:Number(n)<1?8:Number(n)<100?5:2}); }
  function bj(t) { return new Date(t + 8*3600000).toISOString().slice(11,19); }
  function buildModel(view, chart, context) {
    context=context||{};
    var now=Number(context.nowMs==null?Date.now():context.nowMs), symbol=context.symbol, tf=String(context.tf);
    function empty(message) { return {markers:[],message:message}; }
    if(tf!=='1') return empty('分钟买卖点仅标在1分图；其他周期保留原结构标记');
    if(!chart||!chart.ok||chart.sym!==symbol||String(chart.tf)!=='1') return empty('等待当前币种的1分行情');
    if(!['bybit','bybit-vps','bybit-local-proxy'].includes(chart.src)) return empty('当前图表数据源不支持分钟点');
    if(!Number.isFinite(chart.fetched_at)||now-chart.fetched_at>90000||chart.fetched_at-now>10000) return empty('图表行情过期，暂停标点');
    if(!view||view.symbol!==symbol||view.status!=='ready'||view.phase==='paused'||view.phase==='error'||view.phase==='loading') return empty('分钟判断未就绪，暂停标点');
    if(!view.data||!Number.isFinite(view.data.fetchedAt)||!Number.isFinite(view.data.latestClosedBarAt)||now-view.data.fetchedAt>90000||view.data.fetchedAt-now>10000||now-view.data.latestClosedBarAt>75000||view.data.latestClosedBarAt>now) return empty('分钟判断过期，暂停标点');
    var candles=chart.candles||[], markers=[], absent=[];
    if(!candles.length) return empty('图表没有可用K线');
    ['buy','sell'].forEach(function(side) {
      var s=view[side], name=side==='buy'?'买':'卖';
      if(!s||s.symbol!==symbol||s.status==='blocked') { absent.push(name+'：暂停'); return; }
      if(s.status==='watching'&&!s.eventId) {
        if(Number.isFinite(s.observationPrice)&&s.observationPrice>0) markers.push({side:side,status:'watching',price:s.observationPrice,index:candles.length-1,kind:'observation',label:name+'观察·未确认',reasons:s.blockedReasons||[]});
        else absent.push(name+'：等待确认');
        return;
      }
      if(!s.eventId||!['confirmed','expired','invalidated'].includes(s.status)) { absent.push(name+'：等待确认'); return; }
      var i=candles.findIndex(function(c){return c[0]===s.barOpenTime;});
      if(i<0) { absent.push(name+'：上次确认在图窗外'); return; }
      if(s.confirmedAt!==s.barOpenTime+60000||!Number.isFinite(s.availableAfter)||s.availableAfter>Math.min(now,chart.fetched_at)||!Number.isFinite(s.referencePrice)||s.referencePrice<=0||Math.abs(Number(candles[i][4])-s.referencePrice)>Math.max(1e-8,s.referencePrice*1e-10)) { absent.push(name+'：等待图表与确认数据对齐'); return; }
      var status=s.status==='confirmed'&&now>=s.expiresAt?'expired':s.status;
      markers.push({side:side,status:status,price:s.referencePrice,index:i,kind:'event',label:name+'·'+LABEL[status],eventId:s.eventId,confirmedAt:s.confirmedAt,expiresAt:s.expiresAt,invalidationPrice:s.invalidationPrice,reasons:s.reasons||[]});
    });
    return {markers:markers,message:markers.map(function(m){return m.label+' '+price(m.price);}).concat(absent).join('　｜　')||'尚无确认点'};
  }
  function tipHtml(m) {
    var name=m.side==='buy'?'买点':'卖点（减仓参考）';
    return '<b style="color:'+(m.side==='buy'?'#4ade80':'#ff766d')+'">'+name+' · '+escape(LABEL[m.status])+'</b><br>'+
      (m.kind==='event'?'确认收盘价 ':'结构观察价 ')+price(m.price)+
      (m.kind==='event'?'<br>确认 '+bj(m.confirmedAt)+' / 到期 '+bj(m.expiresAt)+' 北京<br>失效界限 '+price(m.invalidationPrice):'<br>尚未形成买卖信号')+
      '<br>'+m.reasons.map(escape).join('<br>')+'<br><span style="color:#9ca3af">费用待核 · 历史点不是当前指令</span>';
  }
  function overlap(a,b){return a.x<b.x+b.w+8&&a.x+a.w+8>b.x&&a.y<b.y+b.h+8&&a.y+a.h+8>b.y;}
  function draw(options) {
    var model=buildModel(latest,options.chart,{symbol:options.symbol,tf:options.tf,nowMs:Date.now()});
    var enabled=!toggle||toggle.checked;
    if(summaryNode) summaryNode.textContent=enabled?model.message:'图内买卖点已隐藏';
    if(options.canvas) options.canvas.setAttribute('aria-label','K线图。'+(enabled?model.message:'买卖点已隐藏'));
    if(!enabled) return [];
    var ctx=options.ctx, area=options.area, hit=[], boxes=[];
    ctx.save();
    model.markers.forEach(function(m) {
      var x=options.X(m.index), y=options.Y(m.price), col=m.side==='buy'?'#43e18b':'#ff776f';
      if(!Number.isFinite(x)||!Number.isFinite(y)||x<area.left||x>area.right||y<area.top||y>area.bottom) return;
      var historical=m.status==='expired'||m.status==='invalidated';
      ctx.font='bold 11px "Microsoft YaHei",sans-serif';
      var w=Math.min(area.right-area.left,Math.max(110,ctx.measureText(m.label).width+20)), h=43;
      var box={x:Math.max(area.left,Math.min(area.right-w,x-w/2)),y:Math.max(area.top+29,Math.min(area.bottom-h,m.side==='buy'?y+23:y-h-23)),w:w,h:h};
      if(boxes.some(function(b){return overlap(box,b);})){box.y=Math.max(area.top+29,Math.min(area.bottom-h,m.side==='buy'?y-h-27:y+27));}
      boxes.push(box);
      ctx.globalAlpha=1;
      ctx.strokeStyle=historical?(m.side==='buy'?'#498e6b':'#a06664'):col;
      ctx.lineWidth=1.2;ctx.setLineDash(historical||m.kind==='observation'?[4,3]:[]);
      ctx.beginPath();
      if(m.kind==='observation'){ctx.moveTo(area.left,y);ctx.lineTo(area.right,y);}else{ctx.moveTo(x,y);ctx.lineTo(Math.max(box.x+8,Math.min(box.x+w-8,x)),box.y>y?box.y:box.y+h);}
      ctx.stroke();ctx.setLineDash([]);
      if(m.kind==='event'){
        ctx.beginPath();ctx.arc(x,y,3.2,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();
        var d=m.side==='buy'?1:-1;
        ctx.beginPath();ctx.moveTo(x,y+d*6);ctx.lineTo(x-5,y+d*15);ctx.lineTo(x+5,y+d*15);ctx.closePath();
        ctx.fillStyle=historical?'#161a20':col;ctx.fill();ctx.strokeStyle=col;ctx.stroke();
      }
      ctx.fillStyle=historical?'rgba(19,24,30,.96)':m.side==='buy'?'rgba(12,55,37,.96)':'rgba(66,28,32,.96)';
      ctx.beginPath();if(ctx.roundRect)ctx.roundRect(box.x,box.y,w,h,7);else ctx.rect(box.x,box.y,w,h);ctx.fill();ctx.stroke();
      ctx.textAlign='left';ctx.textBaseline='middle';ctx.font='bold 11px "Microsoft YaHei",sans-serif';ctx.fillStyle=historical?'#b9c1cb':col;ctx.fillText(m.label,box.x+9,box.y+13);
      ctx.font='11px ui-monospace,monospace';ctx.fillStyle=historical?'#a4adb8':'#f4f7fb';ctx.fillText(price(m.price),box.x+9,box.y+30);
      hit.push({x:x,y:y,box:box,kind:'minute',sg:m});
    });
    ctx.restore();return hit;
  }
  function redraw(){if(win&&typeof win.renderKline==='function')win.renderKline();}
  function setView(view){
    latest=view;
    var signature=JSON.stringify([view.symbol,view.status,view.phase,view.data,view.buy,view.sell]);
    if(signature!==fingerprint){fingerprint=signature;redraw();}
  }
  function clear(message){if(summaryNode)summaryNode.textContent=message||'等待当前图表行情';if(win){var canvas=win.document.getElementById('kline');if(canvas)canvas.setAttribute('aria-label','K线图。等待当前图表行情，未显示买卖点');}}
  function mount(windowObject,doc){
    win=windowObject;var canvas=doc.getElementById('kline');if(!canvas||doc.getElementById('minuteChartControls'))return;
    var line=doc.createElement('div');line.id='minuteChartControls';line.className='mm-chart-controls';
    line.innerHTML='<label><input id="minuteChartToggle" type="checkbox" checked> 买卖点</label><span id="minuteChartSummary" role="status" aria-live="polite">读取分钟判断…</span>';
    canvas.parentElement.parentElement.insertBefore(line,canvas.parentElement);
    summaryNode=doc.getElementById('minuteChartSummary');toggle=doc.getElementById('minuteChartToggle');toggle.addEventListener('change',redraw);canvas.setAttribute('role','img');
  }
  return {buildModel:buildModel,tipHtml:tipHtml,draw:draw,setView:setView,clear:clear,mount:mount};
});
