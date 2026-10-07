import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {createLifeServices} from './index.mjs';
import {mountLifeServiceTools} from './tools.mjs';
import {mountLifeNativeSchedule} from './native-schedule.mjs';

let fixture,registry,host,services,schedule,agents,activityA,activityB,clock=Date.now();
const plans=new Map();
class Stub extends LlmAdapter {
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000}};}
  async *stream(options) {
    const plan=plans.get(options.sessionId),used=options.messages.some(m=>m.content?.some(b=>b.type==='tool-call'&&b.name===plan?.name));
    const block=plan&&!used?{type:'tool-call',id:randomUUID(),name:plan.name,arguments:JSON.stringify(plan.arguments)}:{type:'text',text:'TEST ONLY QUIET COMPLETION'};
    yield {type:'block-start',index:0,blockType:block.type};
    if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};
    else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};
    yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};
    yield {type:'finish',reason:{kind:block.type==='text'?'stop':'tool-calls'}};
  }
}
const execution=(agent,callId=randomUUID())=>host.contexts.execution(agent,{callId});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){const value=await check();if(value)return value;await wait(25);}
  throw Error('TEST ONLY timeout: '+label);
}
async function launch(){
  host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter:new Stub(),providerRoutes:['TEST-shared-provider']});
  schedule=await mountLifeNativeSchedule(host.ctx,{contexts:host.contexts,runtime:host.runtime,root:resolve(fixture.root,'shared-schedule'),admit:async()=>({allowed:true})});
  services=createLifeServices({contexts:host.contexts,schedule,locks:host.locks,now:()=>clock,
    tasks:{running:()=>[activityA?.session.id,activityB?.session.id].filter(Boolean),list:async()=>[activityA,activityB].filter(Boolean).map(a=>({sessionId:a.session.id,title:a===activityA?'TEST ONLY A activity':'TEST ONLY B activity'}))}});
  mountLifeServiceTools(host.ctx,{services,execution:exec=>execution(exec.agent,exec.callId)});
}
before(async()=>{
  fixture=await createFixture(['A','B','C','D']);registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  for(const manifest of fixture.manifests)registry.register(manifest);
  await launch();agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
  [activityA,activityB]=await Promise.all(fixture.manifests.slice(0,2).map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:randomUUID()})));
});
after(async()=>{services?.dispose();if(host)await host.ctx.fiber.dispose();registry?.close();await fixture?.cleanup();});

test('four owner stores share implementation while identity, mental, preferences and clock remain independent',async()=>{
  await Promise.all(agents.map((a,i)=>services.writeMental(execution(a),{text:'TEST ONLY MENTAL '+i})));
  await Promise.all(agents.map((a,i)=>services.configure(execution(a),{intervalMs:60000+i*1000,directive:'TEST ONLY DIRECTIVE '+i})));
  for(const [i,agent] of agents.entries()){
    const c=execution(agent),snapshot=await services.snapshotFor(c,{admitWake:true});
    assert.equal(snapshot.identity,fixture.manifests[i].lifeId);assert.equal(snapshot.mental.text,'TEST ONLY MENTAL '+i);
    assert.equal(snapshot.settings.directive,'TEST ONLY DIRECTIVE '+i);assert(snapshot.core.text.includes('TEST ONLY CORE '+['A','B','C','D'][i]));
    assert.equal((await services.status(c)).identity,c.lifeId);assert.equal((await services.status(c)).clock.lastWakeAt,new Date(clock).toISOString());
  }
});
test('opaque contexts, secondary authority and same-root cached initialization fail closed',async()=>{
  const c=execution(agents[0]);await assert.rejects(services.status({...c}),/TRUSTED_EXECUTION_CONTEXT_REQUIRED/);
  await assert.rejects(services.writeMental(execution(activityA),{text:'FORBIDDEN'}),/AUTHORITY_REQUIRED/);
  const before=(await services.status(c)).settings.version;
  await Promise.all(Array.from({length:12},(_,i)=>services.configure(execution(agents[0]),{directive:'TEST ONLY CONCURRENT '+i})));
  assert.equal((await services.status(c)).settings.version,before+12);
  assert.equal((await services.readMental(execution(activityA))).mental.text,'TEST ONLY MENTAL 0');
});
test('own Core and continuity preserve dirty bytes, CAS, recovery, expiry and other lives',async()=>{
  const c=execution(agents[0]),bBefore=await readFile(fixture.manifests[1].deployment.core,'utf8');
  await writeFile(fixture.manifests[0].deployment.core,'TEST ONLY DIRTY CORE BASE\n');
  const before=await services.documents.read(c,'core');
  const changed=await services.documents.write(c,{kind:'core',text:'TEST ONLY SELF REVISED CORE\n',expectedHash:before.hash});
  assert.equal((await services.documents.restore(c,{versionId:changed.versionId,expectedHash:changed.hash})).canApply,true);
  await writeFile(fixture.manifests[0].deployment.core,'TEST ONLY THIRD PARTY CHANGE\n');
  await assert.rejects(services.documents.restore(c,{versionId:changed.versionId,expectedHash:changed.hash,apply:true}),/STALE_SELF_DOCUMENT/);
  assert.equal(await readFile(fixture.manifests[0].deployment.core,'utf8'),'TEST ONLY THIRD PARTY CHANGE\n');
  // Restore the fixture's own sealed bytes to simulate explicit writer coordination.
  await writeFile(fixture.manifests[0].deployment.core,'TEST ONLY SELF REVISED CORE\n');
  await services.documents.restore(c,{versionId:changed.versionId,expectedHash:changed.hash,apply:true});
  assert.equal(await readFile(fixture.manifests[0].deployment.core,'utf8'),'TEST ONLY DIRTY CORE BASE\n');
  assert.equal(await readFile(fixture.manifests[1].deployment.core,'utf8'),bBefore);
  const working=await services.documents.read(c,'continuity');assert.equal(working.hash,null);
  const newWorking=await services.documents.write(c,{kind:'continuity',text:'TEST ONLY OWN CONTINUITY\n',expectedHash:null});
  assert.equal(newWorking.originSessionId,c.sessionId);assert.equal(newWorking.originCallId,c.callId);
  await assert.rejects(services.documents.restore(execution(agents[1]),{versionId:newWorking.versionId,expectedHash:newWorking.hash,apply:true}),/ENOENT/);
  await services.documents.restore(c,{versionId:newWorking.versionId,expectedHash:newWorking.hash,apply:true});
  assert.equal((await services.documents.read(c,'continuity')).exists,false);
  await services.writeMental(c,{text:'TEST ONLY EXPIRING',expiresAt:new Date(clock+1).toISOString()});clock+=2;
  assert.equal((await services.readMental(c)).mental,null);
});
test('attention and pending use only owner activities and correctly bound native schedules',async()=>{
  const a=execution(agents[0]),b=execution(agents[1]);
  await services.appendPending(execution(activityA),{id:'TEST_ONLY_PENDING_A',kind:'activity',sourceSessionId:activityA.session.id,text:'TEST ONLY OWN ADVICE'});
  await assert.rejects(services.appendPending(a,{kind:'activity',sourceSessionId:activityB.session.id,text:'FORBIDDEN'}),/PENDING_SOURCE_OWNER_MISMATCH/);
  const aa=await services.schedule.create(a,{title:'TEST ONLY same title',prompt:'TEST ONLY A future',after_seconds:600});
  const bb=await services.schedule.create(b,{title:'TEST ONLY same title',prompt:'TEST ONLY B future',after_seconds:600});
  const updated=await services.schedule.update(a,{id:aa.id,expected:aa,title:'TEST ONLY own changed title'});assert.equal(updated.updated,true);
  assert.equal((await services.schedule.update(a,{id:aa.id,expected:aa,title:'TEST ONLY stale title'})).code,'schedule_conflict');
  assert.equal((await services.schedule.list(a)).length,1);assert.equal((await services.schedule.list(b)).length,1);
  await assert.rejects(services.schedule.list(a,{sessionId:b.sessionId}),/SESSION_OWNER_MISMATCH/);
  assert.equal((await services.schedule.delete(a,{id:bb.id})).deleted,false);
  const attention=await services.attention(a,agents[0]);
  assert(attention.candidates.some(r=>r.source==='session:'+activityA.session.id));
  assert(!JSON.stringify(attention).includes(activityB.session.id));
  assert(!JSON.stringify(attention).includes('TEST ONLY B future'));
  await services.schedule.delete(a,{id:aa.id});await services.schedule.delete(b,{id:bb.id});
});
test('real native tool execution has owner provenance and authority activity rest stays isolated',async()=>{
  const m=fixture.manifests[2],agent=agents[2];plans.set(agent.session.id,{name:'life_mental_write',arguments:{text:'TEST ONLY NATIVE TOOL MENTAL'}});
  await host.runtime.prompt({lifeId:m.lifeId,sessionId:m.authoritySessionId,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY NATIVE TOOL CASE'}]});
  await agent.whenIdle();plans.delete(agent.session.id);
  const mental=(await services.readMental(execution(agent))).mental;
  assert.equal(mental.text,'TEST ONLY NATIVE TOOL MENTAL');assert.equal(mental.sessionId,agent.session.id);
  const events=[...agent.session.ownEvents()];const call=events.find(e=>e.type==='tool/call'&&e.data.name==='life_mental_write');
  assert(call);assert.equal(mental.callId,call.data.callId);
  assert(events.some(e=>e.type==='tool/result'&&!e.data.message.isError&&e.sourceEventSeqs?.includes(call.seq)));
  const writer=agents[3],doc=await services.documents.read(execution(writer),'continuity');
  plans.set(writer.session.id,{name:'life_working_write',arguments:{text:'TEST ONLY NATIVE CONTINUITY',expectedHash:doc.hash}});
  await host.runtime.prompt({lifeId:fixture.manifests[3].lifeId,sessionId:writer.session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY DOCUMENT RECEIPT'}]});
  await writer.whenIdle();plans.delete(writer.session.id);
  const journal=[...writer.session.ownEvents()],writeCall=journal.find(e=>e.type==='tool/call'&&e.data.name==='life_working_write');assert(writeCall);
  const writeResult=journal.find(e=>e.type==='tool/result'&&e.sourceEventSeqs?.includes(writeCall.seq));assert.equal(writeResult.data.message.isError,false);
  const receipt=JSON.parse(writeResult.data.message.content.find(part=>part.type==='text').text);
  assert.equal(receipt.originSessionId,writer.session.id);assert.equal(receipt.originCallId,writeCall.data.callId);
  const version=JSON.parse(await readFile(resolve(fixture.manifests[3].deployment.recovery,'self-documents',receipt.versionId+'.json'),'utf8'));
  assert.equal(version.provenance.sessionId,receipt.originSessionId);assert.equal(version.provenance.callId,receipt.originCallId);
  const beforeB=await services.status(execution(agents[1]));
  await services.rest(execution(agents[0]));assert.deepEqual(await services.status(execution(agents[1])),beforeB);
});
test('per-life resident tick uses real native inbox, one missed wake, no backlog and isolated admission',async()=>{
  clock+=4*60*60*1000;
  await Promise.all(agents.slice(0,2).map(a=>services.configure(execution(a),{residentEnabled:true})));
  let aCalls=0;
  const a=fixture.manifests[0],b=fixture.manifests[1];
  const resultA=await services.tick({lifeId:a.lifeId,runtime:host.runtime,admit:async()=>{aCalls++;return {allowed:false};}});
  assert.equal(resultA.reason,'admission-denied');assert.equal(aCalls,1);
  const results=await Promise.all([1,2].map(()=>services.tick({lifeId:b.lifeId,runtime:host.runtime,admit:async()=>({allowed:true})})));
  await agents[1].whenIdle();assert.equal(results[0].requestId,results[1].requestId);
  const delivered=[...agents[1].session.ownEvents()].flatMap(e=>e.type==='user/message'?[e.data]:e.type==='agent/inbox/spliced'?e.data.inserted??[]:[]).filter(m=>m.source?.rpcId===results[0].requestId);
  assert.equal(new Set(delivered.map(m=>m.id)).size,1);
  assert.equal((await services.tick({lifeId:b.lifeId,runtime:host.runtime,admit:async()=>({allowed:true})})).delivered,false);
  assert((await services.status(execution(agents[0]))).clock.nextWakeAt!==(await services.status(execution(agents[1]))).clock.nextWakeAt);
});
test('official durable Schedule targets the exact owner after quiet rest and cold reopen without duplicate',async()=>{
  const [a,b]=fixture.manifests;
  clock=Date.now();await services.rest(execution(agents[0]));
  const wakeA=await services.schedule.create(execution(agents[0]),{title:'TEST ONLY same wake',prompt:'TEST ONLY A schedule receipt',after_seconds:1});
  const wakeB=await services.schedule.create(execution(agents[1]),{title:'TEST ONLY same wake',prompt:'TEST ONLY B schedule receipt',after_seconds:1});
  await until(async()=>{const rows=await schedule.catalog();return rows.filter(r=>r.id===wakeA.id||r.id===wakeB.id).every(r=>r.status==='inactive');},'both owner deliveries');
  await Promise.all(agents.slice(0,2).map(a=>a.whenIdle()));
  const ownMessages=agent=>[...new Map([...agent.session.ownEvents()].flatMap(e=>e.type==='user/message'?[e.data]:e.type==='agent/inbox/spliced'?e.data.inserted??[]:[])
    .filter(m=>m.source?.kind==='schedule').map(m=>[m.id,m])).values()];
  assert.equal(ownMessages(agents[0]).length,1);assert.equal(ownMessages(agents[1]).length,1);
  assert(!JSON.stringify(ownMessages(agents[0])).includes('TEST ONLY B schedule receipt'));
  assert(!JSON.stringify(ownMessages(agents[1])).includes('TEST ONLY A schedule receipt'));
  const overdue=await services.schedule.create(execution(agents[1]),{title:'TEST ONLY offline',prompt:'TEST ONLY B offline overdue receipt',after_seconds:1});
  services.dispose();await host.ctx.fiber.dispose();host=null;registry.close();await wait(1100);
  registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});await launch();
  const resumed=await host.runtime.resolve({lifeId:b.lifeId,sessionId:b.authoritySessionId});
  await until(async()=>(await schedule.catalog()).find(row=>row.id===overdue.id)?.status==='inactive','cold due delivery');await resumed.whenIdle();
  assert.equal(ownMessages(resumed).length,2);
  assert.equal((await services.readMental(execution(resumed))).mental.text,'TEST ONLY MENTAL 1');
  services.dispose();await host.ctx.fiber.dispose();host=null;registry.close();
  registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});await launch();
  const resumedAgain=await host.runtime.resolve({lifeId:b.lifeId,sessionId:b.authoritySessionId});await wait(100);
  assert.equal(ownMessages(resumedAgain).length,2);
});

test('shared Schedule storage is protected from ordinary owner file tools',async()=>{
  const fs=host.ctx.agentPresets.serviceFor(await host.runtime.resolve({lifeId:fixture.manifests[0].lifeId,sessionId:fixture.manifests[0].authoritySessionId}),'fs');
  await assert.rejects(fs.resolve(resolve(fixture.root,'shared-schedule','tasks.json')),/TRUSTED_CONTROL_RESOURCE/);
});
test('rest or disabling Resident during admission cancels the stale wake while another life proceeds',async()=>{
  const a=await host.runtime.resolve({lifeId:fixture.manifests[0].lifeId,sessionId:fixture.manifests[0].authoritySessionId});
  const b=await host.runtime.resolve({lifeId:fixture.manifests[1].lifeId,sessionId:fixture.manifests[1].authoritySessionId});
  for(const mode of ['rest','disable']) {
    await services.configure(execution(a),{residentEnabled:true});await services.configure(execution(b),{residentEnabled:true});clock+=24*60*60*1000;
    let arrived,release,returned=0;const entered=new Promise(r=>arrived=r),hold=new Promise(r=>release=r);
    const pending=services.tick({lifeId:fixture.manifests[0].lifeId,runtime:host.runtime,admit:async()=>{arrived();await hold;return {allowed:true,release:async()=>{returned++;}};}});
    await entered;
    const independent=await services.tick({lifeId:fixture.manifests[1].lifeId,runtime:host.runtime,admit:async()=>({allowed:true})});assert.equal(independent.delivered,true);await b.whenIdle();
    if(mode==='rest')await services.rest(execution(a));else await services.configure(execution(a),{residentEnabled:false});
    release();const result=await pending;assert.equal(result.delivered,false);assert.equal(result.reason,'wake-changed-during-admission');assert.equal(returned,1);
  }
});
