window.__ModuleLoader__.load({id:'@local/deepseek-official-billing-ui',factory:()=>{
 function formatAmount(value){
  if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value))return null;
  const [whole,fraction='']=value.split('.');
  // Decimal text truncation affects presentation only; retain original in tooltip.
  const digits=whole==='0'&&fraction.startsWith('00')?6:2;
  return whole+'.'+fraction.padEnd(digits,'0').slice(0,digits);
 }
 function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
 function apply(ctx){ctx.effect(()=>{
  let disposed=false,selected=null,billing=null,failed=false,pending=null,scheduled=false;
  const style=document.createElement('style');style.dataset.plugin='deepseek-official-billing-ui';
  style.textContent='.yb-official-billing{font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:inherit;white-space:nowrap;flex:0 0 auto;padding:3px 8px;border:1px solid #8195ad40;border-radius:7px}.yb-official-billing[data-stale=true]{opacity:.72}.ref-statusbar{flex-wrap:wrap;row-gap:4px}.ref-statusbar>.yb-official-billing{margin-left:auto;max-width:100%;overflow:hidden;text-overflow:ellipsis}@media(max-width:760px){.ref-statusbar>.yb-official-billing{font-size:10px;padding:0 4px}.ref-statusbar{align-content:center;row-gap:0}}';document.head.append(style);
  const current=()=>window.__personaDesktopState?.selectedSessionId??document.querySelector('.yb-task.selected[data-session-id]')?.dataset.sessionId??null;
  function paint(){
   const workspace=document.querySelector('.yb-workspace');if(!workspace)return;
   const mount=workspace.querySelector('.ref-statusbar')??workspace.querySelector('.yb-status-switch');if(!mount)return;
   let node=mount.querySelector(':scope>.yb-official-billing');if(!node){node=document.createElement('span');node.className='yb-official-billing';node.setAttribute('role','status');node.tabIndex=0;mount.append(node);}
   for(const extra of workspace.querySelectorAll('.yb-official-billing'))if(extra!==node)extra.remove();
   const amount=billing?.source==='deepseek_platform'&&billing.date===today()?formatAmount(billing.today_cost_cny):null;
   const stale=amount===null||failed||billing?.stale===true;
   const text=amount===null?'今日花费 -- · 官方账单暂不可用':'今日花费 ¥'+amount+(stale?' · 数据过期':'');
   const validTime=billing?.updated_at&&Number.isFinite(Date.parse(billing.updated_at));
   const time=validTime?new Date(billing.updated_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未取得';
   const title='官方账单 · 更新于 '+time+'（北京时间）'+(amount===null?' · 暂不可用':' · 精确金额 ¥'+billing.today_cost_cny)+(billing?.error?' · '+billing.error.code+'：'+billing.error.message:stale?' · 最近刷新未成功或数据已过期':'')+' · 每 5 分钟后台刷新，官方入账可能延迟';
   if(node.textContent!==text)node.textContent=text;if(node.title!==title)node.title=title;
   if(node.dataset.stale!==String(stale))node.dataset.stale=String(stale);
  }
  async function read(){
   const id=current();if(!id||disposed)return;
   if(pending?.id===id)return;
   const operation={id};pending=operation;
   try{const response=await fetch('/api/persona.billing?sessionId='+encodeURIComponent(id),{cache:'no-store',credentials:'same-origin'});if(!response.ok)throw Error('BILLING_UNAVAILABLE');const result=await response.json();if(disposed||current()!==id)return;billing=result.billing;failed=false;}
   catch{if(!disposed&&current()===id)failed=true;}
   finally{if(pending===operation)pending=null;if(!disposed)paint();}
  }
  function scan(){scheduled=false;if(disposed)return;const id=current();if(id!==selected){selected=id;billing=null;failed=false;paint();void read();}else paint();}
  const observer=new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(scan);}});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','aria-current','data-session-id']});scan();
  const timer=setInterval(()=>{scan();void read();},30000);
  // Selected Session can become ready without any DOM mutation (sidebar collapsed).
  // This checks local UI state only; API reads still occur on switches or 30 s ticks.
  const selectionTimer=setInterval(scan,1000);
  const click=e=>{if(e.target.closest?.('[aria-controls="yb-status-panel"]'))void read();};document.addEventListener('click',click);
  return()=>{disposed=true;observer.disconnect();clearInterval(timer);clearInterval(selectionTimer);document.removeEventListener('click',click);style.remove();document.querySelectorAll('.yb-official-billing').forEach(n=>n.remove());};
 });}
 return {apply};
}});
