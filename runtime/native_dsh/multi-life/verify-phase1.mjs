import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {LifeRegistry} from './registry.mjs';
import {createFixture} from './fixture.mjs';
import {bootScoped} from './boot-scoped.mjs';
import {inspectLegacy} from './legacy.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('fixture barrier timeout')),15000);t.unref();})]);
const fixture=await createFixture(['A','B','C','D']);
let registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),host;
const steps=[],checks={};
const receipts=[];
class Stub extends LlmAdapter {
  controls=new Map();host;
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}
  async *stream(options) {
    const agent=this.host.ctx.agents.get(options.sessionId),bound=this.host.contexts.forAgent(agent),label=bound.manifest.displayName.slice('TEST ONLY '.length);
    const body=JSON.stringify(options.messages),control=this.controls.get(options.sessionId);
    const system=options.messages.filter(m=>m.role==='system').map(m=>JSON.stringify(m.content)).join('');
    assert(system.includes('TEST ONLY CORE '+label));
    for(const other of ['A','B','C','D'].filter(x=>x!==label))assert(!system.includes('TEST ONLY CORE '+other));
    receipts.push({sessionId:options.sessionId,lifeId:bound.lifeId,label,model:options.model,requestHash:createHash('sha256').update(JSON.stringify(options)).digest('hex')});
    if(control&&!control.entered){control.entered=true;steps.push('entered-'+label);control.arrived.resolve();
      await Promise.race([control.release.promise,new Promise((_,reject)=>options.signal.addEventListener('abort',()=>{control.cancelled=true;steps.push('cancelled-'+label);reject(options.signal.reason);},{once:true}))]);}
    const has=name=>options.messages.some(m=>m.content?.some(b=>b.type==='tool-call'&&b.name===name));
    let block;
    if(body.includes('RUN FILE TOOLS')&&!has('read'))block={type:'tool_use',id:randomUUID(),name:'read',input:{file_path:'same-name.txt'}};
    else if(body.includes('RUN FILE TOOLS')&&!has('write'))block={type:'tool_use',id:randomUUID(),name:'write',input:{file_path:'result.txt',content:'TEST ONLY RESULT '+label}};
    else if(body.includes('RUN FILE TOOLS')&&!has('skill'))block={type:'tool_use',id:randomUUID(),name:'skill',input:{name:'fixture-skill'}};
    else if(body.includes('RUN FILE TOOLS')&&!has('fixture_identity'))block={type:'tool_use',id:randomUUID(),name:'fixture_identity',input:{}};
    else block={type:'text',text:'TEST ONLY FINISHED '+label};
    if(block.type==='text') {
      yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:block.text};
    }else {
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:JSON.stringify(block.input)};
    }
    yield {type:'block-end',index:0,block:block.type==='text'?block:{type:'tool-call',id:block.id,name:block.name,arguments:JSON.stringify(block.input)}};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};
    yield {type:'finish',reason:{kind:block.type==='text'?'stop':'tool-calls'}};
  }
}
const adapter=new Stub();
async function launch(){host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter,providerRoutes:['TEST-shared-provider']});adapter.host=host;
  host.ctx.tools.register(defineTool({name:'fixture_identity',description:'Test only trusted life identity',parameters:{},output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    execute:(_args,exec)=>{const c=host.contexts.execution(exec.agent,{callId:exec.callId});return {lifeId:c.lifeId,sessionId:c.sessionId,core:c.manifest.deployment.core};}}));
}
try {
  for(const m of fixture.manifests)registry.register(m);
  const [A,B,C,D]=fixture.manifests;
  assert.equal(registry.list().length,4);checks.nWayRegistry=true;
  assert.throws(()=>registry.register({...A,lifeId:'life-'+randomUUID(),authoritySessionId:randomUUID(),deployment:{...A.deployment,presetId:'different'}}),/PRIVATE_RESOURCE_OWNER_COLLISION/);
  assert.throws(()=>registry.owner(randomUUID()),/UNKNOWN_SESSION_OWNER/);
  assert.throws(()=>new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),/REGISTRY_WRITER_ALREADY_ACTIVE/);checks.singleRegistryWriter=true;
  assert.throws(()=>registry.register({...A,kind:'independent',lifeId:'life-'+randomUUID()}),/REGISTRY_ENVIRONMENT_MISMATCH/);
  const reserved=registry.reserve({lifeId:A.lifeId,sessionId:A.authoritySessionId,role:'authority'});
  assert.throws(()=>registry.reserve({lifeId:B.lifeId,sessionId:A.authoritySessionId,role:'authority'}),/AUTHORITY_SESSION_RESERVED_BY_OTHER_LIFE/);
  registry.close();registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  assert.deepEqual(registry.owner(A.authoritySessionId),reserved);checks.reservationColdReopen=true;
  await launch();
  const agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
  assert.equal(agents.length,4);assert(host.ctx.get('fs')===undefined,'fs leaked to root');checks.nativeFourScopes=true;
  const A2=await host.runtime.create({lifeId:A.lifeId,sessionId:randomUUID()});
  const a2fs=host.ctx.agentPresets.serviceFor(A2,'fs'),a1fs=host.ctx.agentPresets.serviceFor(agents[0],'fs');
  assert.equal(a2fs.processPath(await a2fs.resolve('same-name.txt')),a1fs.processPath(await a1fs.resolve('same-name.txt')));checks.sameLifeActivitiesShareState=true;
  assert.throws(()=>host.contexts.require({...host.contexts.execution(agents[0]),lifeId:B.lifeId}),/TRUSTED_EXECUTION_CONTEXT_REQUIRED/);
  assert.throws(()=>host.contexts.requireAuthority(host.contexts.execution(A2)),/AUTHORITY_REQUIRED/);
  await assert.rejects(host.runtime.resolve({lifeId:B.lifeId,sessionId:A.authoritySessionId}),/SESSION_OWNER_MISMATCH/);
  await assert.rejects(host.runtime.resolve({sessionId:A.authoritySessionId}),/EXPLICIT_LIFE_REQUIRED/);checks.failClosedIngress=true;
  await assert.rejects(host.runtime.events({lifeId:B.lifeId,sessionId:A.authoritySessionId}),/SESSION_OWNER_MISMATCH/);
  assert(Array.isArray(await host.runtime.events({lifeId:A.lifeId,sessionId:A.authoritySessionId})));checks.ownerBoundHistory=true;
  const blank=await host.runtime.create({lifeId:A.lifeId,sessionId:randomUUID()});
  await host.ctx.agentPresets.recompose(blank.ctx,B.deployment.presetId);
  blank.session.append('agent-preset/selected',{agentPreset:B.deployment.presetId});await host.ctx.sessions.flush(blank.session);
  assert.throws(()=>host.contexts.forAgent(blank),/ACTIVE_PRESET_OWNER_MISMATCH/);checks.activePresetTamperDenied=true;
  for(const m of [A,B])adapter.controls.set(m.authoritySessionId,{arrived:deferred(),release:deferred(),entered:false});
  await Promise.all([A,B].map(m=>host.runtime.prompt({lifeId:m.lifeId,sessionId:m.authoritySessionId,requestId:randomUUID(),content:[{type:'text',text:'BARRIER'}]})));
  await bounded(Promise.all([A,B].map(m=>adapter.controls.get(m.authoritySessionId).arrived.promise)));
  assert(!adapter.controls.get(B.authoritySessionId).cancelled);
  host.runtime.cancel({lifeId:A.lifeId,sessionId:A.authoritySessionId});await bounded(agents[0].whenIdle());
  assert.equal(adapter.controls.get(A.authoritySessionId).cancelled,true);assert(!adapter.controls.get(B.authoritySessionId).cancelled);
  adapter.controls.get(B.authoritySessionId).release.resolve();await bounded(agents[1].whenIdle());
  checks.modelBarriersConcurrent=true;checks.cancelAOnly=true;adapter.controls.clear();
  const duplicateId=randomUUID();
  const duplicates=await Promise.all([1,2].map(()=>host.runtime.prompt({lifeId:A.lifeId,sessionId:A.authoritySessionId,requestId:duplicateId,content:[{type:'text',text:'DUPLICATE CHECK'}]})));
  await bounded(agents[0].whenIdle());assert.equal(duplicates.filter(x=>x.duplicate).length,1);
  assert.equal([...agents[0].session.ownEvents()].filter(e=>e.type==='user/message'&&e.data.source?.rpcId===duplicateId).length,1);checks.requestDeduplication=true;
  await Promise.all([A,B,C,D].map(m=>host.runtime.prompt({lifeId:m.lifeId,sessionId:m.authoritySessionId,requestId:randomUUID(),content:[{type:'text',text:'RUN FILE TOOLS'}]})));
  await bounded(Promise.all(agents.map(a=>a.whenIdle())));
  for(const [i,m] of fixture.manifests.entries()){
    const label=m.displayName.slice('TEST ONLY '.length);
    assert.equal(await readFile(resolve(m.deployment.workspace,'result.txt'),'utf8'),'TEST ONLY RESULT '+label);
    const events=[...agents[i].session.ownEvents()];
    for(const name of ['read','write','skill','fixture_identity']) {
      const call=events.find(e=>e.type==='tool/call'&&e.data.name===name);
      assert(call&&events.some(e=>e.type==='tool/result'&&e.sourceEventSeqs?.includes(call.seq)&&e.data.message.isError===false),'Missing successful native receipt for '+name);
    }
    const results=JSON.stringify(events.filter(e=>e.type==='tool/result'));
    assert(results.includes('TEST ONLY FILE '+label));assert(results.includes('TEST ONLY SKILL '+label));assert(results.includes(m.lifeId));
  }
  checks.nativeFilesToolsSkillsCore=true;
  const afs=host.ctx.agentPresets.serviceFor(agents[0],'fs');
  await assert.rejects(afs.resolve(resolve(B.deployment.workspace,'same-name.txt')),/OTHER_LIFE_PRIVATE_RESOURCE/);checks.privatePathDenial=true;
  await assert.rejects(afs.resolve(resolve(fixture.nativeRoot,'sessions')),/TRUSTED_CONTROL_RESOURCE/);
  await assert.rejects(afs.resolve(resolve(fixture.registryRoot,'registry.json')),/TRUSTED_CONTROL_RESOURCE/);checks.controlAndNativeLogPathDenial=true;
  await assert.rejects(afs.resolve(resolve(fixture.root,'..','fixture-escape.txt')),/TEST_FIXTURE_OUTSIDE_BOUNDARY/);checks.fixtureCannotTouchProduction=true;
  for(const agent of agents)await host.ctx.sessions.flush(agent.session);
  const oldContexts=host.contexts,oldExecution=host.contexts.execution(agents[0]);
  await host.ctx.fiber.dispose();host=null;assert.throws(()=>oldContexts.require(oldExecution),/LIFE_AGENT_NOT_LIVE/);checks.disposedContextDenied=true;
  registry.close();registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  await launch();const [resumed,resumedAgain]=await Promise.all([1,2].map(()=>host.runtime.resolve({lifeId:B.lifeId,sessionId:B.authoritySessionId})));
  assert(resumed===resumedAgain,'Cold concurrent resolve must reuse exact native Agent');checks.concurrentColdResolve=true;
  await assert.rejects(host.runtime.resolve({lifeId:A.lifeId,sessionId:blank.session.id}),/NATIVE_OWNER_BINDING_MISMATCH/);checks.persistedPresetTamperDenied=true;
  assert.equal(resumed.session.id,B.authoritySessionId);assert.equal(host.contexts.forAgent(resumed).lifeId,B.lifeId);
  assert([...resumed.session.ownEvents()].some(e=>e.type==='assistant/message'));checks.nativeColdResume=true;
  // Native durable seed written but control mapping not completed: recover same reservation, never infer owner.
  const crashId=randomUUID();registry.reserve({lifeId:C.lifeId,sessionId:crashId});
  const m=C,ctx=host.ctx;
  const h=await ctx.agents.create({sessionId:crashId,meta:{cwd:m.deployment.workspace,agentPreset:m.deployment.presetId},agentOptions:{provider:m.deployment.provider,model:m.deployment.model},setup:async(ac,a)=>{host.contexts.bind(a);await ctx.agentPresets.mount(ac,m.deployment.presetId);}});
  await ctx.sessions.flush(h.agent.session);await host.ctx.fiber.dispose();host=null;registry.close();
  registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});assert.equal(registry.owner(crashId).status,'reserved');
  await launch();await host.runtime.create({lifeId:C.lifeId,sessionId:crashId});assert.equal(registry.owner(crashId).status,'ready');checks.seedBeforeOwnerCommitRecovery=true;
  const legacy=await inspectLegacy();
  assert.equal(legacy.kind,'legacy');assert(legacy.authoritySessionId);checks.legacyReadOnlyMapping=true;
  const result={schemaVersion:1,passed:true,observedAt:new Date().toISOString(),topologyDecision:'single-native-host-isolated-presets',checks,steps,receipts,paidModelCalls:0,productionWrites:0,fixtureCleaned:false};
  await host.ctx.fiber.dispose();host=null;registry.close();await fixture.cleanup();result.fixtureCleaned=true;
  const output=fileURLToPath(new URL('../../../reports/multi-life-implementation-20261006/phase1-validation.json',import.meta.url));
  await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:true,checks,steps,output,fixtureCleaned:true}));
} finally {if(host)await host.ctx.fiber.dispose();registry.close();}
