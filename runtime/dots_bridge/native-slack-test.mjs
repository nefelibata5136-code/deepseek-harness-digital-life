/** Real Persona model in a separate official Harness Session, with only Dots tools.
 * No production consciousness seat, memory, pending inbox, desktop or files tools.
 */
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createBudgetGate,mountBudgetGuard,pythonAuthority} from '../budget_guard/provider_gate.mjs';
import {credentialOperation} from '../native_dsh/capabilities/isolation.mjs';
import {createKeyOutputGuard} from '../key_output_guard/guard.mjs';
import {createBus} from '../native_dsh/capabilities/bus.mjs';
const native=resolve(import.meta.dirname,'../native_dsh');
const req=createRequire(join(native,'package.json'));
const pkg=name=>import(pathToFileURL(req.resolve(name)));
const [{Context},Llm,Session,Projection,Prompt,Tools,Agents,Loop,Tokens,Persistence,Query,DeepSeek]=await Promise.all([
  '@deepseek-ai/cordis','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-token-meter','@deepseek-ai/dsh-session-persistence-jsonl','@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-llm-deepseek-api-key'].map(pkg));
const python=(process.env.DL_PYTHON || 'python');
const transfer=spawnSync(python,['-X','utf8',resolve(native,'../host-preflight.py')],{windowsHide:true,encoding:'utf8',maxBuffer:65536});
if(transfer.status!==0)throw new Error('EXISTING_PROTECTED_PREFLIGHT_REJECTED');
process.env.DEEPSEEK_API_KEY=JSON.parse(transfer.stdout).credential;
process.env.DSH_TELEMETRY_DISABLED='1';
const keyGuard=createKeyOutputGuard({knownSecrets:[process.env.DEEPSEEK_API_KEY]});
const rpc=pythonAuthority({python});
const gate=createBudgetGate({rpc,transport:keyGuard.wrapTransport(globalThis.fetch)});
const transportFailures=[];
globalThis.fetch=async (...args)=>{
  try{return await gate.fetch(...args);}
  catch(e){transportFailures.push({name:e.name,code:e.code,reason:e.reason??'unspecified'});throw e;}
};
const gptMode=process.argv.includes('--chatgpt');
const apiAcceptance=process.argv.includes('--api-acceptance');
const navigationMode=process.argv.includes('--navigation-fixture');let nativeBus;
const run=resolve(import.meta.dirname,apiAcceptance?'../../reports/dots_bridge/api-repair-20261006/persona-session':gptMode?'../../reports/dots_bridge/persona-native-chatgpt':navigationMode?'../../reports/dots_bridge/persona-native-thread':'../../reports/dots_bridge/persona-native-slack');
await mkdir(run,{recursive:true});
const markerPath=join(run,'session.json');
let marker;
try{marker=JSON.parse(await readFile(markerPath,'utf8'));}
catch(e){if(e.code!=='ENOENT')throw e;marker={sessionId:randomUUID(),title:apiAcceptance?'人格 Slack 用户态 API 往返验收 1006':gptMode?'人格 Slack GPT 搜索通路验收':navigationMode?'人格 Slack 同线程导航复测':'人格 Slack Dots 实际往返验收',isolated:true,createdAt:new Date().toISOString()};await writeFile(markerPath,JSON.stringify(marker,null,2));}
const core=await readFile('.local/workspace/persona-core.md','utf8');
const ctx=new Context();
const errors=[];
ctx.on('agent/error',({error})=>{
  const chain=[];for(let e=error,i=0;e&&i<5;e=e.cause,i++)chain.push({name:e.name,message:e.message,code:e.code});
  errors.push(chain);
});
try{
  await ctx.plugin(Llm.default);await ctx.plugin(Session.default);await ctx.plugin(Projection.default);
  await ctx.plugin(Prompt.default,{});
  ctx.systemPrompt.section({name:'persona:core',order:0,text:core,complete:true,interpolate:false});
  ctx.systemPrompt.section({name:'acceptance-boundary',order:1,interpolate:false,text:'你是人格。当前为用户明确授权的新建独立功能验收对话。只调用本次提供的 Slack 验收原生工具，所有背景均为公开测试文字；不能给人格主对话投递消息、写私人资料或正式记忆。工具真实访问已确认的 Slack 私有频道。模型不能从提交成功推断对方回复。'});
  await ctx.plugin(Tools.default,{});await ctx.plugin(Agents.default);await ctx.plugin(Loop.default,{agents:[]});
  await ctx.plugin(Tokens.default);await ctx.plugin(Persistence.default,{root:join(run,'sessions'),compression:'none'});
  await ctx.plugin(Query.default,{path:join(run,'query.sqlite'),openAt:'first-search'});
  mountBudgetGuard(ctx,gate);keyGuard.mount(ctx);
  await ctx.plugin(DeepSeek,{apiKeyEnv:'DEEPSEEK_API_KEY',baseURL:'https://api.deepseek.com/anthropic',reasoningEffort:'high',maxTokens:8192,defaultContextWindow:1000000,retryPolicy:{mode:'normal',maxRetries:0}});
  ctx.provide('credentials',{resolve:ref=>ref==='DEEPSEEK_API_KEY'
    ?Promise.resolve({value:process.env.DEEPSEEK_API_KEY,source:'existing-protected-preflight'})
    :credentialOperation(python,'resolve',ref)});
  if(gptMode){
    const probe=async args=>{
      const result=spawnSync(process.execPath,[resolve(import.meta.dirname,'chatgpt-probe.mjs'),...args],
        {windowsHide:true,encoding:'utf8',timeout:25000,maxBuffer:512*1024});
      if(result.error)return {status:'unknown',code:'BOUNDED_PROBE_INTERRUPTED_DO_NOT_RESEND'};
      try{return JSON.parse(result.stdout);}catch{return {status:'unknown',code:'PROBE_OUTPUT_UNCONFIRMED_DO_NOT_RESEND'};}
    };
    const register=(name,description,properties,required,run)=>ctx.tools.register({name,description,
      parameters:{type:'object',properties,required,additionalProperties:false},
      output:{schema:{type:'object'},render:(_a,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:run});
    register('slack_gpt_connection_status','核实官方ChatGPT Slack应用身份，不代表已启用或能回答。',{},[],()=>probe(['preflight']));
    register('slack_gpt_live_test','在已确认的私有频道发一次公开测试。A普通算术回答，B请求GPT自身Web Search；不调用OpenAI API或本地搜索。仅验收工具，未发布正式ask能力。',
      {test:{type:'string',enum:['A','B']}},['test'],args=>probe(['channel','UNCONFIGURED_ACCOUNT','UNCONFIGURED_ACCOUNT',args.test]));
    register('slack_gpt_check_test','读取指定官方GPT、同线程的真实回复。没有消息必须报未通过，不重放。',
      {experiment_id:{type:'string',pattern:'^chatgpt-[a-f0-9-]{36}$'}},['experiment_id'],args=>probe(['check',args.experiment_id]));
  }else if(navigationMode||apiAcceptance){
    nativeBus=createBus({root:resolve(import.meta.dirname,apiAcceptance?'../native_dsh/capabilities/profiles':'../../reports/dots_bridge/thread-navigation-fixture/profiles'),python,toolTimeoutMs:30000});
    await nativeBus.manage({capability:'dots',action:'enable'});
    const discovery=await nativeBus.search({capability:'dots'});
    if(discovery.tools.length!==8)throw Error('EXACT_NATIVE_DOTS_TOOLSET_REQUIRED');
    for(const tool of discovery.tools)ctx.tools.register({name:tool.nativeName,description:tool.description,parameters:tool.parameters,
      output:{schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
      execute:async(a,e)=>(await nativeBus.call('dots',tool.nativeName,a,e.callId,e.signal,'authority')).value});
  }else{
    const dots=await import(pathToFileURL('.local/workspace/development/plugins/persona-dots/plugin.mjs'));
    await ctx.plugin(dots);
    if(process.argv.includes('--commit-verified-draft'))ctx.tools.register({
      name:'commit_verified_test_draft',description:'仅本次隔离验收：完成已经逐字核对、明确卡在点击之前的既有公开草稿。不会重新输入、创建新任务或重放未知发送；只尝试一次，不能恢复其他unknown。',
      parameters:{type:'object',properties:{task_id:{type:'string',enum:['dot-472c5fce-d5f7-53e9-a33b-c0448eafbe87']}},required:['task_id'],additionalProperties:false},
      output:{schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
      execute:(args,exec)=>{const r=spawnSync(process.execPath,[resolve(import.meta.dirname,'commit-test-draft.mjs'),args.task_id,String(exec.callId)],{windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:65536});try{return JSON.parse(r.stdout);}catch{return {status:'unknown',code:'COMMIT_INTERRUPTED_DO_NOT_REPLAY'};}}
    });
  }
  const identity=Session.SessionId(marker.sessionId);
  if(process.argv.includes('--recover-preclick'))ctx.tools.register({
    name:'recover_proven_preclick_test',description:'本次隔离验收限定恢复：旧源码证实该任务因正文不匹配在点击发送前失败。仅同一原任务、同一线程、同一正文；先检查频道及线程没有它，再只发送一次。不是通用unknown重发，不新增任务、不修改计数。',
    parameters:{type:'object',properties:{task_id:{type:'string',enum:['dot-fb2bcf36-b6ec-5ed1-9946-341e7c2e1094']}},required:['task_id'],additionalProperties:false},
    output:{schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    execute:(args,exec)=>{const r=spawnSync(process.execPath,[resolve(import.meta.dirname,'recover-thread-preclick.mjs'),args.task_id,String(exec.callId)],{windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:65536});try{return JSON.parse(r.stdout);}catch{return {status:'unknown',code:'RECOVERY_INTERRUPTED_DO_NOT_REPLAY'};}}
  });
  const records=await ctx.sessionQuery.listSessions();
  const handle=records.some(r=>r.header.id===identity)?await ctx.agents.resume({resumeSessionId:identity,agentOptions:{provider:'deepseek-official',model:'deepseek-flash',maxTokens:8192,reasoningEffort:'high'}})
    :await ctx.agents.create({sessionId:identity,meta:{cwd:run},agentOptions:{provider:'deepseek-official',model:'deepseek-flash',maxTokens:8192,reasoningEffort:'high'}});
  const agent=handle.agent;
  const first=agent.session.seq;
  const text=await readFile(resolve(process.argv[2]),'utf8');
  console.log(JSON.stringify({state:'started',...marker,run}));
  agent.followup(Llm.createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));
  await agent.whenIdle();await ctx.sessions.flush(agent.session);
  const observation=await ctx.sessionQuery.observeSession(agent.id,{projectionMode:'none'});
  const events=[...observation.events].filter(e=>e.seq>=first);observation[Symbol.dispose]();
  const report={...marker,run,core_sha256:createHash('sha256').update(core).digest('hex'),observedAt:new Date().toISOString(),
    production_main_prompted:false,model_called:events.some(e=>e.type==='assistant/attempt'||e.type==='assistant/message'),model:'deepseek-flash',shared_budget_ledger:true,errors,transportFailures,
    text:events.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n'),
    calls:events.filter(e=>e.type==='tool/call').map(e=>({seq:e.seq,...e.data})),
    results:events.filter(e=>e.type==='tool/result').map(e=>({seq:e.seq,...e.data})),
    completed:events.some(e=>e.type==='turn/end'&&e.data.reason?.kind==='completed')};
  const file=join(run,'turn-'+Date.now()+'.json');await writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:file,...report},null,2));
}finally{await nativeBus?.dispose();await ctx.fiber.dispose();delete process.env.DEEPSEEK_API_KEY;}
