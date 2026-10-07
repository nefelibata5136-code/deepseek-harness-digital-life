import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LlmAdapter,ToolCallId} from '@deepseek-ai/dsh-llm';
import {runRecovery,sourcePath} from './kernel.mjs';
import {clean,classify,recordIncident,incidents,errorChain,sha} from './diagnostics.mjs';
import {shouldRecover,defaults} from './standby.mjs';
import {normalizeToolProtocol,assertToolProtocol} from './tool-protocol.mjs';
const root=resolve(import.meta.dirname,'../../../reports/self-recovery/fixture-'+randomUUID());
await mkdir(root,{recursive:true});
const checks=[];function check(name,condition){assert(condition,name);checks.push(name);}
check('HTTP401/402 do not pretend to be generic network errors',classify({httpStatus:401})==='authentication'&&classify({httpStatus:402})==='provider_balance');
check('Context overflow is distinguishable',classify({httpStatus:400,providerError:{message:'context length exceeded'}})==='context_size');
check('Actual socket reason survives',classify({causes:[{code:'ECONNRESET'}]})==='network');
check('Known key never appears in safe messages',!clean('xxx-secret-123 abc',['xxx-secret-123']).includes('xxx-secret-123'));
const inner=Object.assign(new Error('socket closed'),{code:'ECONNRESET'});const outer=new Error('wrapped',{cause:inner});
check('Cause chain retains code',errorChain(outer)[1].code==='ECONNRESET');
const fixtureIncident=await recordIncident({stage:'fixture',sessionId:'fixture-session',requestId:'fixture-request',httpStatus:413},root);
check('Durable incident reads back', (await incidents({root}))[0].category==='context_size');
const now=Date.now(),episode={key:'failed-1'};
check('New failure starts recovery',shouldRecover({episode,state:{},now}));
check('Handled failure never replays',!shouldRecover({episode,state:{handled:['failed-1']},now}));
check('Cooldown bounds retries',!shouldRecover({episode,state:{lastAttemptAt:now-1000},now}));
check('Hourly budget bounds retries',!shouldRecover({episode,state:{attempts:[now-100000,now-200000]},now}));
check('Explicit pause stays paused',!shouldRecover({episode,state:{paused:true},now}));
assert.throws(()=>sourcePath('runtime/native_dsh/recovery/kernel.stable-v3.mjs',true),/immutable/);
assert.throws(()=>sourcePath('runtime/native_dsh/recovery/stable-manifest.json',true),/immutable/);
check('Self patches cannot modify known-good snapshots or manifest',true);
const original=[{role:'assistant',content:[{type:'thinking',thinking:'fixture reasoning'},{type:'tool_use',id:'call-1',name:'edit',input:{}},{type:'text',text:'already wrote a file'}]},
  {role:'system',content:[{type:'text',text:'a deferred system update'}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:'call-1',content:[{type:'text',text:'actual successful result'}]},{type:'text',text:'new user message'}]}];
const before=JSON.stringify(original),normalized=normalizeToolProtocol(original);
check('Original tool/action evidence is never rewritten',JSON.stringify(original)===before);
check('Actual result immediately follows its call',normalized.messages[1].content[0].content[0].text==='actual successful result');
check('System and user text preserved',JSON.stringify(normalized.messages).includes('a deferred system update')&&JSON.stringify(normalized.messages).includes('new user message'));
check('Assistant text tail moved before calls',normalized.messages[0].content.at(-1).type==='tool_use');
check('Normalization is idempotent',normalizeToolProtocol(normalized.messages).repairs.length===0);
const missing=normalizeToolProtocol([{role:'assistant',content:[{type:'tool_use',id:'missing',name:'edit',input:{}}]}]);
check('Missing result is explicitly unknown, never success',missing.messages[1].content[0].is_error===true&&missing.messages[1].content[0].content[0].text.includes('OUTCOME_UNKNOWN'));
if(process.argv.includes('--quick')){console.log(JSON.stringify({passed:true,checks,modelCalls:0}));process.exit(0);}
const CORE='我是人格。独立恢复测试核心 CORE_FIXTURE_73。只能依据真实工具结果判断，不编造记忆。';
class Fixture extends LlmAdapter {
  calls=[];
  async resolveModel(provider,model){return {provider,id:model,name:model,context:{contextWindow:1000000},defaultMaxTokens:2048};}
  async *stream(options){
    this.calls.push(options);
    const index=this.calls.length;
    const action=[['repair_status',{}],['repair_read_diagnostic',{kind:'incident',id:fixtureIncident.id}],['repair_light_mode',{enabled:true,reason:'fixture context failure'}],['repair_probe',{light:true}]][index-1];
    const block=action?{type:'tool-call',id:ToolCallId(randomUUID()),name:action[0],arguments:JSON.stringify(action[1])}:{type:'text',text:'隔离恢复闭环完成；实际工具验证通过。'};
    yield{type:'block-start',index:0,blockType:block.type};yield{type:'block-end',index:0,block};
    yield{type:'finish',reason:{kind:action?'tool-calls':'stop'}};
  }
}
const fixture=new Fixture(),effects=[];
const r=await runRecovery({root,fixtureCore:CORE,fixtureAdapter:fixture,episode:{kind:'fixture-main-broken'},toolOverrides:{
  repair_status:async()=>({main:{ready:false},reason:'fixture old context failed'}),
  repair_light_mode:async args=>{effects.push(args);return{mode:'light'};},
  repair_probe:async()=>({state:'completed',primaryUnchanged:true})}});
check('Standalone native Agent completes with broken main fixture',r.state==='completed');
check('Real native tool calls read diagnosis, change then verify',r.checks.map(c=>c.tool).join(',')==='repair_status,repair_read_diagnostic,repair_light_mode,repair_probe');
check('Recovery Agent reads the persisted incident through its own tool',JSON.stringify(fixture.calls[2].messages).includes('context_size')&&JSON.stringify(fixture.calls[2].messages).includes(fixtureIncident.id));
check('Core identity preserved on every model request',fixture.calls.every(o=>JSON.stringify(o.messages).includes('CORE_FIXTURE_73')));
check('Recovery policy is assembled alongside the literal core',fixture.calls.every(o=>JSON.stringify(o.messages).includes('先 repair_status')));
check('Worker self state and suspended budget are explicitly understood',fixture.calls.every(o=>JSON.stringify(o.messages).includes('workerPid 指向你自己')&&JSON.stringify(o.messages).includes('daily_limit_enforced=false')));
check('No main profile or long-term memory loaded',!r.mainProfileLoaded&&!r.longTermMemoryLoaded);
check('Self repair uses observed tool outcomes',effects.length===1&&effects[0].enabled);
const report={passed:true,observedAt:new Date().toISOString(),checks,paidCalls:0,coreHash:sha(CORE),standbySessionId:r.sessionId};
report.sourceSha256=Object.fromEntries(await Promise.all(['diagnostics.mjs','tool-protocol.mjs','kernel.mjs','standby.mjs','main.mjs','service-control.mjs','bootstrap.mjs','verify.mjs'].map(async name=>[name,sha(await readFile(resolve(import.meta.dirname,name)))])));
await writeFile(resolve(import.meta.dirname,'../../../reports/self-recovery/offline-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
