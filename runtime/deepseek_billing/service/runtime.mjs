import {native} from '../../workspace_foundation/native.mjs';
import {readAgentBilling,readBillingDetails} from './cache.mjs?official-summary=4';
import {startProducer} from './producer.mjs?diagnostics=1';
import {recoverBilling} from './recovery.mjs';
import {mountBillingBoundary} from './boundary.mjs';
import {mountCacheHealth} from './cache-usage.mjs';
export async function mountBillingRuntime(ctx,{producer=false}={}) {
  mountBillingBoundary(ctx);
  await mountCacheHealth(ctx);
  function owner(agent){
    const contexts=ctx.get('multiLifeContexts')??ctx.get('multiLifeOwnership')?.contexts;
    if(!contexts)throw Error('BILLING_TRUSTED_OWNER_UNAVAILABLE');
    return contexts.forAgent(agent).lifeId;
  }
  const service=ctx.get('deepseekBillingStatus')??{};
  service.forAgent=agent=>({billing:readAgentBilling(owner(agent))});
  const {defineTool}=await native('dsh-tools');
  if(!service.recoveryMounted){
    ctx.get('tools').register(defineTool({name:'billing_recover',description:'本人官方账单故障诊断、恢复步骤与受节流后台重试。不访问凭据、不改变预算；登录失效由用户本人重新登录。',parameters:{action:{type:'string',enum:['status','retry'],required:true}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:(args,exec)=>recoverBilling(owner(exec.agent),args.action)}));
    service.recoveryMounted=true;
  }
  if(service.summaryMounted===4){if(producer)await startProducer(ctx);return service;}
  if(!ctx.get('deepseekBillingStatus'))ctx.provide('deepseekBillingStatus',service);
  const installed=new WeakSet();
  function install(agent){
    if(installed.has(agent))return;
    try{owner(agent);}catch{return;}
    agent.ctx.systemPrompt.section({name:'billing:official-cost',order:3,interpolate:false,
      text:'billing_status 读取本人 Key 官方今日、一小时、十分钟消费与更新时间；billing_details 查相同摘要、实际采样区间与快照。窗口是截至最新成功官方快照的已入账差值，预计延迟5–10分钟；缺基线则返回null及window_status。动态摘要在历史末端，明细不默认注入。'});
    const register=definition=>agent.ctx.tools.register(defineTool({isConcurrencySafe:()=>true,...definition}));
    const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
    register({name:'billing_status',description:'只读本人 Key 官方三档消费 today_cost、last_1h_cost、last_10m_delta 及 updated_at。窗口截至最新官方快照，缺基线返回null及window_status；预计延迟5–10分钟。',parameters:{},output,execute:(_args,exec)=>service.forAgent(exec.agent)});
    register({name:'billing_details',description:'按需读取本人 Key 官方 snapshot 明细。today、last_1h、snapshots；limit 1–500，before 用 next_before 分页。失败记录是 missing，非零消费证明；读取不访问官网。',
      parameters:{period:{type:'string',enum:['today','last_1h','snapshots']},limit:{type:'number'},before:{type:'string'}},output,
      execute:(args,exec)=>readBillingDetails(owner(exec.agent),args)});
    // Preserve the old discoverable name, but no local money or budget state is exposed.
    register({name:'budget_status',description:'兼容旧入口：读取本人官方账单摘要与实际 token/cache 用量。消费数据只有 DeepSeek 官方来源。',parameters:{},output,
      execute:async(_args,exec)=>({billing:service.forAgent(exec.agent).billing,usage:(await ctx.get('cacheUsageStatus').forAgent(exec.agent)).today??null})});
    const observer=ctx.get('tools').get('observe_life',agent);
    if(observer)agent.ctx.tools.register({...observer,execute:async(args,exec)=>{
      const {billing,...activity}=await observer.execute(args,exec);return activity;
    }});
    installed.add(agent);
  }
  ctx.on('agent/created',({agent})=>install(agent));
  for(const agent of ctx.get('agents').list())install(agent);
  // Global discovery remains available; scoped tools shadow legacy registrations.
  if(!service.mounted)
  ctx.get('tools').register(defineTool({name:'billing_status',description:'只读本人今日 DeepSeek 官方账单缓存、更新时间及过期状态。Host 每5分钟后台刷新；读取不会重新查询或限制模型调用。',parameters:{},
    isConcurrencySafe:()=>true,
    output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:(_args,exec)=>service.forAgent(exec.agent)}));
  if(producer)await startProducer(ctx);
  service.mounted=true;
  service.summaryMounted=4;
  return service;
}
