import {native} from '../../../workspace_foundation/native.mjs';

const name='capability_snapshot';
const toolsFor=(ctx,agent)=>ctx.get('tools').schemas(agent).map(t=>t.name);
const ownerFor=(ctx,agent)=>{
  const contexts=ctx.get('multiLifeContexts')??ctx.get('multiLifeOwnership')?.contexts;
  if(!contexts)throw Error('CAPABILITY_TRUSTED_OWNER_REQUIRED');
  return contexts.execution(agent);
};
// A target page refusing web_fetch does not establish that the independent
// search provider failed; nor may a successful fetch clear a search failure.
const groupFor=tool=>tool==='terminal'?'shell':tool==='web_search'?'web_search':/dots/.test(tool)?'slack_dot':/^(billing_|budget_status)/.test(tool)?'billing':/^(read|write|edit)$/.test(tool)?'files':null;
const failureCode=value=>{
  if(value?.isError===true||value?.error){const code=value?.error?.info?.code??value?.code??value?.error?.code??value?.error;return /^[A-Z0-9_:-]{1,80}$/.test(String(code))?String(code):'TOOL_RETURNED_ERROR';}
  const body=value?.value??value;
  if(body?.ok===false||body?.poll_error){const code=body.code??body.poll_error;return /^[A-Z0-9_:-]{1,80}$/.test(String(code))?String(code):'TOOL_OPERATION_FAILED';}
  if(Number(body?.statusCode??body?.status)>=400)return 'HTTP_'+(body.statusCode??body.status);
  if(body?.timeout===true)return 'TERMINAL_TIMEOUT';
  if(body?.available===false||body?.returncode===-1)return 'TERMINAL_BACKEND_UNAVAILABLE';
  return null;
};

// This projection only uses loaded native services/tool registries. It is not
// a second capability registry and never starts a worker or makes a request.
export function projectCapabilities({names,local={},dots={},external=[],failures={},lifeId,sessionId,observedAt}) {
  const has=n=>names.includes(n),all=list=>list.every(has);
  const entries={
    files:{status:all(['read','write','edit'])?'available':'unavailable',tools:['read','write','edit'].filter(has)},
    shell:{status:has('terminal')&&local.terminal_backend_available!==false?'direct':'unavailable',tool:has('terminal')?'terminal':null},
    web_search:{status:has('web_search')&&local.search_provider_loaded===true?'available':'unavailable',tool:has('web_search')?'web_search':null},
    slack_dot:{status:'unavailable'},
    wake:{status:has('schedule_create')?'available':'unavailable',tool:has('schedule_create')?'schedule_create':null},
    billing:{status:all(['billing_status','billing_details'])?'available':'unavailable',tool:has('billing_status')?'billing_status':null},
  };
  const direct=names.filter(n=>/^(delegate_to_dots|check_dots_task|read_dots_result|continue_dots_task)$/.test(n));
  const discovered=names.filter(n=>/^cap__dots__/.test(n));
  const registered=external.find(e=>e.id==='dots');
  if(direct.length&&dots.registered===true)entries.slack_dot={status:dots.state==='error'||dots.health==='unavailable'||dots.health==='available'&&dots.available===false?'degraded':'available',tools:direct,
    health:dots.health??'unknown',check_tool:'dots_status',...dots.last_error?{last_failure:dots.last_error}:{}};
  else if(registered?.state==='ready'&&registered.enabled===true)entries.slack_dot={status:'available',discovery:'capability_search',capability:'dots',tools:discovered};
  else if(registered)entries.slack_dot={status:'unavailable',capability:'dots',registration_state:registered.state,enabled:registered.enabled};
  else if(discovered.length)entries.slack_dot={status:'available',tools:discovered};
  if(local.search_last_failure&&entries.web_search.status==='available')entries.web_search={...entries.web_search,status:'degraded',last_failure:local.search_last_failure};
  if(local.terminal_last_failure&&entries.shell.status==='direct')entries.shell={...entries.shell,status:'degraded',last_failure:local.terminal_last_failure};
  for(const [group,code] of Object.entries(failures))if(entries[group]?.status!=='unavailable')entries[group]={...entries[group],status:'degraded',last_failure:code};
  return {source:'loaded_native_runtime',life_id:lifeId,session_id:sessionId,observed_at:observedAt,capabilities:entries,
    meaning:'available describes current registration; tool results establish whether this operation succeeds. Latest appended snapshot is current.'};
}

export async function mountV1Capabilities(ctx) {
  if(ctx.get('v1CapabilitySnapshot'))return ctx.get('v1CapabilitySnapshot');
  const {defineTool}=await native('dsh-tools'),{createMessage}=await native('dsh-llm');
  const installed=new WeakSet(),external=new WeakMap(),failures=new Map();
  function snapshot(agent) {
    const c=ownerFor(ctx,agent),loadedLocal=ctx.get('digitalLifeLocalNetwork')?.status?.(agent),local=loadedLocal?{
      search_provider_loaded:loadedLocal.search?.available===true,search_last_failure:loadedLocal.search?.last_call?.error_code,
      terminal_backend_available:loadedLocal.terminal?.backend_available,terminal_last_failure:loadedLocal.terminal?.last_call?.error_code,
    }:ctx.get('v1LocalNetwork')?.status?.(agent)??{},dots=ctx.get('lifeDots')?.peek?.(c)??ctx.get('v1Dots')?.status?.(agent)??{};
    return projectCapabilities({names:toolsFor(ctx,agent),local,dots,external:external.get(agent)??[],failures:failures.get(c.lifeId)??{},
      lifeId:c.lifeId,sessionId:c.sessionId,observedAt:new Date().toISOString()});
  }
  function install(agent) {
    if(installed.has(agent))return;
    let c;try{c=ownerFor(ctx,agent);}catch{return;}
    if(c.role==='delegate')return;
    agent.ctx.tools.register(defineTool({name,description:'只读当前本人加载的文件、shell、搜索、Slack/Dot、唤醒和官方账单能力、调用入口及最近工具失败。由真实 tool/provider registration生成，不读旧能力记忆，不发起网络或模型请求。',parameters:{},isConcurrencySafe:()=>true,
      output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:(_args,exec)=>snapshot(exec.agent)}));
    agent.ctx.systemPrompt.section({name:'life:capability-snapshot',order:5,interpolate:false,
      text:'当前能力与入口以末端 Host 能力快照和 capability_snapshot 为准；它们由本 Session 实际加载的工具/provider生成。旧文档或长期记忆不能证明可用。available 表示已加载，真实结果与失败另外核实；失败后下轮快照显示 degraded，可改用另一入口或向维护者求助。'});
    const original=agent.buildRequest;if(typeof original!=='function')throw Error('CAPABILITY_NATIVE_REQUEST_SEAM_REQUIRED');
    const wrapped=function(config,preparedCall,tools,position,...rest) {
      const value=snapshot(agent);
      this.session.append('system/message',{...position,message:createMessage({role:'system',content:[{type:'text',text:'[CAPABILITIES]\n'+JSON.stringify(value)+'\n[/CAPABILITIES]'}],source:{kind:'system-prompt',producer:'runtime-capabilities'}})},{surfaceOp:'append'});
      return original.call(this,config,preparedCall,tools,position,...rest);
    };
    agent.buildRequest=wrapped;installed.add(agent);
    agent.ctx.effect(()=>()=>{if(agent.buildRequest===wrapped)agent.buildRequest=original;},'loaded capability request snapshot');
  }
  ctx.on('agent/created',({agent})=>install(agent));
  for(const agent of ctx.get('agents').list())install(agent);
  ctx.on('agent/request',async(request,next)=>{
    const result=await next();install(request.agent);
    // The existing Persona bus is already initialized by its native plugin.
    // list is a read of that loaded worker state, never capability discovery.
    const bus=ctx.get('personaCapabilities');
    if(bus)try{const rows=await bus.list();external.set(request.agent,rows.entries.map(({id,enabled,state})=>({id,enabled,state})));}catch{external.set(request.agent,[]);}
    return result;
  });
  // Final native outcome also covers pre-dispatch permission refusal and
  // post-execute/output validation. A command test exiting 1 is still a
  // working shell; transport failure/timeout are separate capability facts.
  ctx.on('tools/result',(exec,result)=>{
    let c;try{c=ownerFor(ctx,exec.agent);}catch{return;}
    const group=groupFor(exec.name);if(!group)return;
    const code=failureCode(result),row=failures.get(c.lifeId)??{};
    if(code)row[group]=code;else delete row[group];failures.set(c.lifeId,row);
  });
  const service={forAgent:snapshot};ctx.provide('v1CapabilitySnapshot',service);return service;
}
