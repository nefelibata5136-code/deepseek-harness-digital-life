// Real installed DSH preset/Agent loop, two isolated owners, no paid calls.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createFixture} from '../multi-life/fixture.mjs';
import {LifeRegistry} from '../multi-life/registry.mjs';
import {bootLifeHost} from '../multi-life/host.mjs';
const fixture=await createFixture(['A','B']),memoryBindings=new Map(),ownerBindings=new Map(),queues=new Map(),wires=[],checks={};
let registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),host;
class Stub extends LlmAdapter {
  async resolveModel(provider,id){return {provider,id,name:id,contextWindow:1000000,
    reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}};}
  async *stream(options) {
    const agent=host.ctx.agents.get(options.sessionId),c=host.contexts.execution(agent),label=c.manifest.displayName.at(-1);
    const system=JSON.stringify(options.messages.filter(m=>m.role==='system'));
    if(c.role==='delegate')assert(!system.includes('TEST ONLY CORE'));
    else {assert(system.includes('TEST ONLY CORE '+label));assert(!system.includes('TEST ONLY CORE '+(label==='A'?'B':'A')));}
    if(c.role==='authority'){assert(system.includes('[本人自定｜可修改]'));assert(!system.includes('[人格自定｜可修改]'));}
    wires.push({sessionId:c.sessionId,effort:options.reasoningEffort,system});
    const queue=queues.get(c.sessionId),step=queue?.shift();assert(step,'Unexpected native request');
    const block=step.name?{type:'tool-call',id:randomUUID(),name:step.name,arguments:JSON.stringify(step.args??{})}:{type:'text',text:step.text??'TEST ONLY quiet stop'};
    yield {type:'block-start',index:0,blockType:block.type};
    if(step.name)yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};
    else yield {type:'text-delta',index:0,text:block.text};
    yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:12,outputTokens:2}};
    yield {type:'finish',reason:{kind:step.name?'tool-calls':'stop'}};
  }
}
async function launch(){host=await bootLifeHost({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,
  adapter:new Stub(),providerRoutes:['TEST-shared-provider'],memoryBindings,ownerBindings,digitalLifePreset:true,admit:async()=>({allowed:true})});}
async function execute(agent,steps) {
  const start=[...agent.session.ownEvents()].at(-1)?.seq??-1,before=wires.length;
  queues.set(agent.session.id,[...steps]);const c=host.contexts.execution(agent);
  await host.runtime.prompt({lifeId:c.lifeId,sessionId:c.sessionId,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY independent preset acceptance'}]});
  await Promise.race([agent.whenIdle(),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Native fixture deadline')),30000);t.unref();})]);
  await host.ctx.sessions.flush(agent.session);await host.drainCheckpoints();
  const events=[...agent.session.ownEvents()].filter(e=>e.seq>start);
  assert.equal(queues.get(c.sessionId).length,0,JSON.stringify(events.map(e=>({type:e.type,data:e.type==='turn/end'||e.type==='tool/result'?e.data:undefined}))));
  for(const step of steps.filter(s=>s.name)) {
    const call=events.find(e=>e.type==='tool/call'&&e.data.name===step.name);assert(call,'Missing native tool call '+step.name);
    const result=events.find(e=>e.type==='tool/result'&&e.sourceEventSeqs?.includes(call.seq));
    assert(result&&!result.data.message?.isError,JSON.stringify(result?.data));
  }
  assert(events.some(e=>e.type==='turn/end'&&e.data.reason?.kind==='completed'),JSON.stringify(events.at(-1)));
  return {events,wires:wires.slice(before)};
}
const foundation=agent=>host.ctx.agentPresets.serviceFor(agent,'digitalLifeFoundation');
try {
  for(const m of fixture.manifests) {
    registry.register(m);memoryBindings.set(m.lifeId,{sources:[],syntheticProvider:true,config:{workspace_id:'TEST-workspace',embedding_model:'TEST-embedding',rerank_model:'TEST-rerank',dimension:3}});
    ownerBindings.set(m.lifeId,{accounts:{},credentials:{},browsers:{}});
  }
  await launch();let agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
  const headers=agents.map(a=>structuredClone(a.session.header));
  for(const [i,a] of agents.entries()) {
    const f=foundation(a),m=fixture.manifests[i];assert(f);assert.equal(f.identity.lifeId,m.lifeId);
    assert.equal(f.resident.preset,m.deployment.presetId);assert.equal(f.stateBoard.owner.activity,m.lifeId);
    assert.equal(a.session.header.agentPreset,m.deployment.presetId);
    assert.equal(f.stateBoardModule,new URL('./state-board.mjs',import.meta.url).href);
    const life=host.ctx.agentPresets.serviceFor(a,'personaLife');assert.equal(life.store,await host.life.prepareStore(m.lifeId));
    assert.equal((await life.store.settings()).residentEnabled,false);assert.equal((await life.store.settings()).intentionSamplingEnabled,false);
    const names=a.ctx.tools.schemas(a).map(t=>t.name);for(const n of ['life_continue','digital_life_state_read','digital_life_state_update'])assert(names.includes(n));
    assert(!names.includes('life_sampling_configure'));
  }
  checks.nativePresetSameModulesAndSingleOwnerStore=true;
  await Promise.all(agents.map((a,i)=>execute(a,[{name:'digital_life_state_update',args:{activity:'TEST OWN '+i,desired_reasoning_effort:'high'}},{text:'TEST ONLY same input answered at high' }])));
  for(const a of agents)assert.equal(wires.filter(w=>w.sessionId===a.session.id).at(-1).effort,'high');
  assert(wires.every(w=>w.system.includes('Digital Life State')||w.system.includes('数字生命状态')||w.system.includes('actualEffort')));
  checks.nativeSelfAuthoredStateAndActualReasoningRequest=true;
  const m=fixture.manifests[0],a=agents[0],c=host.contexts.execution(a),store=await host.life.prepareStore(m.lifeId);
  await store.configure({residentEnabled:true});
  let result=await execute(a,[{text:'TEST ONLY completed task'},{text:'TEST ONLY choose quiet stop'}]);
  assert.equal(result.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='resident-attention').length,1);
  checks.nativeResidentQuietStopNoParallelLoop=true;
  result=await execute(a,[{text:'TEST ONLY completed segment'},{name:'life_continue',args:{intention:'TEST ONLY my own thought'}},
    {text:'TEST ONLY chosen thought finished'},{text:'TEST ONLY quiet now'}]);
  assert.equal(result.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='resident-continuation').length,1);
  assert(result.wires.some(w=>w.system.includes(m.lifeId+'/self_continuation')));
  checks.nativeContinuationKeepsIndependentIdentity=true;
  const wakeAt=new Date(Date.now()+3600000).toISOString();
  result=await execute(a,[{name:'life_rest',args:{nextWakeAt:wakeAt,reason:'TEST ONLY future self wake'}}]);
  assert.equal(result.wires.length,1);const schedules=await host.life.schedule.list(c);assert.equal(schedules.length,1);assert.equal(schedules[0].sessionId,m.authoritySessionId);
  assert.equal((await host.life.schedule.list(host.contexts.execution(agents[1]))).length,0);
  assert.equal((await store.state()).clock.lastOutcome,'rest');checks.nativeRestAndOwnerSchedule=true;
  const activity=await host.runtime.create({lifeId:m.lifeId,sessionId:randomUUID(),role:'activity'});
  const names=activity.ctx.tools.schemas(activity).map(t=>t.name);
  for(const n of ['digital_life_state_read','digital_life_state_update','life_continue','life_rest'])assert(!names.includes(n));
  assert(foundation(activity));await execute(activity,[{text:'TEST ONLY separate activity'}]);checks.activityCannotChangePrimaryState=true;
  const protectedBefore=await store.state();
  result=await execute(activity,[{name:'digital_life_foundation_check'},{text:'TEST ONLY pure check complete'}]);
  const checked=result.events.find(e=>e.type==='tool/result').data.message.content.find(b=>b.type==='text').text;
  const selfCheck=JSON.parse(checked);assert.equal(selfCheck.lifeId,m.lifeId);assert.equal(selfCheck.sessionId,activity.session.id);
  assert.equal(selfCheck.exitCode,0);assert.equal(selfCheck.passed,true);assert(selfCheck.stdout.includes('# pass 6'));
  assert.deepEqual(await store.state(),protectedBefore);checks.activityRunsFixedPureCheckWithoutChangingOwnerState=true;
  const childId=randomUUID();queues.set(childId,[{text:'TEST ONLY engineering suggestion'}]);
  const child=await host.runtime.delegate(c,{sessionId:childId,task:'TEST ONLY read-only engineering suggestion'});
  await child.agent.whenIdle();
  for(const n of ['digital_life_state_read','digital_life_state_update','life_continue','life_rest','digital_life_foundation_check'])assert(!child.agent.ctx.tools.schemas(child.agent).some(t=>t.name===n));
  checks.delegateKeepsEngineeringIdentityAndNoPrimaryControl=true;
  await store.configure({residentEnabled:false});
  await host.ctx.fiber.dispose();host=null;registry.close();registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  await launch();agents=await Promise.all(fixture.manifests.map(m=>host.runtime.resolve({lifeId:m.lifeId,sessionId:m.authoritySessionId})));
  for(const [i,a] of agents.entries()) {
    assert.deepEqual({...a.session.header,delegationDepth:a.session.header.delegationDepth??0},{...headers[i],delegationDepth:headers[i].delegationDepth??0});assert.equal(foundation(a).stateBoard.get(a).activity,'TEST OWN '+i);
    assert.equal(foundation(a).stateBoard.get(a).author.lifeId,fixture.manifests[i].lifeId);
    await execute(a,[{text:'TEST ONLY cold reopened'}]);
  }
  checks.coldResumeKeepsNativeHeaderAndSelfState=true;
  const report={passed:true,observedAt:new Date().toISOString(),checks,paidModelCalls:0,nativeRequests:wires.length,evidence:'real-installed-native-preset-and-loop-with-local-adapter'};
  await writeFile(new URL('../../../reports/newlife-digital-life-foundation-20261006/native-acceptance.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{if(host)await host.ctx.fiber.dispose();registry?.close();await fixture.cleanup();}
