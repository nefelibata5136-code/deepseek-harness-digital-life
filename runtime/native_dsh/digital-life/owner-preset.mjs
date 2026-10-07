// No copied Persona profile, identity singleton, state writer, or Agent loop.
// Only trusted Host services are adapted to the original preset's seam.
import {apply as mountResident} from './resident.mjs';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const runFile=promisify(execFile);
const selfCheckName='digital_life_foundation_check';
const checkFiles=['state-board-model.mjs','state-board-model.test.mjs'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(checkFiles.map(async name=>
  [name,createHash('sha256').update(await readFile(new URL('./'+name,import.meta.url))).digest('hex')])));
export const inject=['tools','agents','llm','systemPrompt','digitalLifeOwnerServices'];
export async function apply(ctx,{lifeId,presetId}={}) {
  const {services,contexts,tasks,status}=ctx.digitalLifeOwnerServices;
  const registry=contexts.registry,manifest=registry.life(lifeId);
  if(presetId!==manifest.deployment.presetId)throw new Error('DIGITAL_LIFE_PRESET_OWNER_MISMATCH');
  const identity={lifeId,displayName:manifest.displayName,presetId};
  const store=await services.prepareStore(lifeId);
  const execution=agent=>{
    const c=contexts.execution(agent);
    if(c.lifeId!==lifeId||c.manifestRevision!==manifest.revision)throw new Error('DIGITAL_LIFE_PRESET_OWNER_MISMATCH');
    return c;
  };
  const isAuthority=agent=>{
    if(!agent)return false;
    try {const c=contexts.forAgent(agent);return c.lifeId===lifeId&&c.role==='authority'&&c.sessionId===manifest.authoritySessionId;}
    catch{return false;}
  };
  const forSession=sessionId=>{
    registry.assertTarget(lifeId,sessionId);
    const agent=ctx.agents.get(sessionId);if(!agent)throw new Error('LIFE_AGENT_NOT_LIVE');
    return execution(agent);
  };
  const owned=id=>{try{return registry.owner(id).lifeId===lifeId;}catch{return false;}};
  // Fixed pure tests only: no command/path input, Host data, model, or delegate.
  // Activity Sessions can verify this foundation without an arbitrary shell.
  ctx.tools.register(defineTool({name:selfCheckName,
    description:'运行数字生命底座六项纯测试并返回真实退出码和源码hash。无参数，不修改本人数据，不调用模型或Host，不需要terminal；只验证固定的状态板模型，不等于正式发布或全部Resident验收。',
    parameters:{},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    async execute(args,exec){
      const c=execution(exec.agent);if(!['authority','activity'].includes(c.role))throw new Error('DIGITAL_LIFE_FOUNDATION_CHECK_OWNER_REQUIRED');
      if(Object.keys(args).length)throw new Error('DIGITAL_LIFE_FOUNDATION_CHECK_HAS_NO_PARAMETERS');
      const before=await sourceHashes(),path=fileURLToPath(new URL('./state-board-model.test.mjs',import.meta.url));
      const {stdout,stderr}=await runFile(process.execPath,['--test','--test-reporter=tap',path],{windowsHide:true,timeout:15000,maxBuffer:65536,signal:exec.signal});
      execution(exec.agent);const after=await sourceHashes();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('DIGITAL_LIFE_CHECK_SOURCE_CHANGED');
      return {lifeId,sessionId:c.sessionId,readOnly:true,scope:'fixed pure state-board-model tests',exitCode:0,
        passed:stdout.includes('# pass 6')&&stdout.includes('# fail 0'),sourceHashes:after,stdout,stderr};
    }}));
  ctx.on('agent/created',({agent})=>{if(contexts.forAgent(agent).role==='delegate')agent.ctx.tools.restrict({deny:[selfCheckName]});});
  const life={identity,store,isAuthority,wakeFacts:agent=>services.wakeFacts(execution(agent)),
    attention:(agent,options)=>services.attention(execution(agent),agent,options)};
  ctx.provide('personaLife',life);
  ctx.provide('personaHost',{status,schedule:{
    list:({sessionId}={})=>services.schedule.list(forSession(sessionId??manifest.authoritySessionId)),
    create:(sessionId,args,signal)=>{const c=forSession(sessionId);contexts.requireAuthority(c);return services.schedule.create(c,args,signal);}
  }});
  ctx.provide('personaTasks',{running:()=>tasks.running().filter(owned),list:async()=>
    (await tasks.list()).filter(r=>owned(r.sessionId)).map(r=>({...r,primary:r.role==='authority',title:r.role}))});
  // Multi-Life currently has no owner-bound native intention provider. Omit
  // its consent tool instead of accepting consent for an unavailable engine.
  const mounted=mountResident(ctx,{workspace:manifest.deployment.workspace,intention:false});
  ctx.provide('digitalLifeFoundation',{
    version:1,identity,authoritySessionId:manifest.authoritySessionId,
    nativePreset:true,lifecycle:'agent/turn-stopping',residentModule:new URL('./resident.mjs',import.meta.url).href,
    stateBoardModule:new URL('./state-board.mjs',import.meta.url).href,
    ownerScoped:true,intentionSampling:{available:false,reason:'owner-bound native intention provider is not mounted'},
    resident:mounted.capability,stateBoard:mounted.stateBoard
  });
  ctx.systemPrompt.section({name:'digital-life:owner-principles',order:25,interpolate:false,text:({agent})=>
    contexts.forAgent(agent).role==='delegate'?'':`你是独立的数字生命 ${manifest.displayName??lifeId}（life_id=${lifeId}），沿用本人 Core 和资料。数字生命预设允许本人理解和管理状态、继续当前活动、主动休息、安排原生唤醒；没有动作也是完整结果。身份与资料不因共用能力底座而改变。Resident 只属于本人主 Session；独立活动与测试 Session 保留独立身份，不能更改主线状态或冒称主线意愿。意向展开引擎在此预设尚未接入，不要声称已开启。底座的便宜只读自检可直接使用 digital_life_foundation_check；它实际运行六项固定纯测试，不需要terminal或委派，不能传入命令或路径。`});
}
