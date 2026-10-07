import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {native} from '../../workspace_foundation/native.mjs';
const python=(process.env.DL_PYTHON || 'python');
const snapshots=new Map();
export function readCacheUsage(lifeId,sessionId) {
  if(!/^life-[a-f0-9-]{36}$/i.test(lifeId)||!/^[a-f0-9-]{36}$/i.test(sessionId))throw Error('CACHE_USAGE_OWNER_REQUIRED');
  const key=lifeId+':'+sessionId,old=snapshots.get(key);
  if(old&&Date.now()-old.at<5000)return old.promise;
  const promise=new Promise(resolve=>{
    const child=spawn(python,['-B','-X','utf8',fileURLToPath(new URL('./cache-usage.py',import.meta.url)),lifeId,sessionId],
      {windowsHide:true,env:{PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',SystemRoot:process.env.SystemRoot},stdio:['ignore','pipe','ignore']});
    let output='';const fail=()=>resolve({error:'CACHE_USAGE_UNAVAILABLE',cache_hit_rate:null});
    const timer=setTimeout(()=>{child.kill();fail();},5000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{output+=data;if(output.length>100000){child.kill();fail();}});
    child.once('error',()=>{clearTimeout(timer);fail();});
    child.once('close',code=>{clearTimeout(timer);try{const result=JSON.parse(output);if(code||result.error)fail();else resolve(result);}catch{fail();}});
  });
  snapshots.set(key,{at:Date.now(),promise});return promise;
}
export async function mountCacheHealth(ctx) {
  if(ctx.get('cacheUsageStatus'))return ctx.get('cacheUsageStatus');
  const owner=agent=>{
    const contexts=ctx.get('multiLifeContexts')??ctx.get('multiLifeOwnership')?.contexts;
    if(!contexts)throw Error('CACHE_USAGE_TRUSTED_OWNER_REQUIRED');
    return contexts.forAgent(agent).lifeId;
  };
  const service={forAgent:agent=>readCacheUsage(owner(agent),agent.session.id)};
  const {defineTool}=await native('dsh-tools');
  const {createMessage}=await native('dsh-llm');
  ctx.get('tools').register(defineTool({name:'cache_status',description:'只读本人当前 Session 最近一次、最近10次请求的实际缓存命中率，以及本人今日用量。异常标记只是提示，冷启动也可能触发；不设金额上限，不终止运行，不自动发送求助。异常时应找其他 Agent 或维护者帮助，避免付费自行排查循环。',parameters:{},
    isConcurrencySafe:()=>true,
    output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:(_args,exec)=>service.forAgent(exec.agent)}));
  // The head stays static. Current measurements belong after existing history,
  // just like the owner State Board; dynamic sections would churn the prefix.
  ctx.get('systemPrompt').section({name:'billing:cache-health',order:4,interpolate:false,
    text:'cache_status 可只读本人最近一次、最近10次请求的实际缓存命中率与今日用量；billing_status 显示本人 API Key 今日官方费用及更新时间。末端 CACHE_HEALTH 是已结算用量，不含正在执行的请求。异常标记只供本人判断，不设置金额上限或自动停机。'});
  const prepared=new WeakMap(),installed=new WeakSet();
  function install(agent){
    if(installed.has(agent))return;
    try{owner(agent);}catch{return;}
    const original=agent.buildRequest;if(typeof original!=='function')throw Error('CACHE_USAGE_NATIVE_REQUEST_SEAM_REQUIRED');
    const wrapped=function(config,preparedCall,tools,position,...rest){
      const value=prepared.get(agent);
      if(value)this.session.append('system/message',{...position,message:createMessage({role:'system',
        content:[{type:'text',text:'[CACHE_HEALTH]\n'+JSON.stringify({cache_health:value.cache_health,detail_tool:'cache_status'})+'\n[/CACHE_HEALTH]\n[BILLING]\n'+JSON.stringify({billing:readBillingForAgent(agent)})+'\n[/BILLING]'}],source:{kind:'system-prompt',producer:'cache-health'}})},{surfaceOp:'append'});
      return original.call(this,config,preparedCall,tools,position,...rest);
    };
    agent.buildRequest=wrapped;installed.add(agent);
    ctx.effect(()=>()=>{if(agent.buildRequest===wrapped)agent.buildRequest=original;},'cache-health native request seam');
  }
  ctx.on('agent/created',({agent})=>install(agent));
  for(const agent of ctx.get('agents').list())install(agent);
  ctx.on('agent/request',async(request,next)=>{
    const result=await next();install(request.agent);
    try{const value=await service.forAgent(request.agent);prepared.set(request.agent,{cache_health:value.error?value:{latest_request:value.latest_request,recent_10_requests:value.recent_10_requests,advisory:value.advisory}});}catch{prepared.delete(request.agent);}
    return result;
  });
  function readBillingForAgent(agent){return ctx.get('deepseekBillingStatus')?.forAgent(agent).billing??null;}
  ctx.provide('cacheUsageStatus',service);return service;
}
