import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {LifeContexts} from '../context.mjs';
import {TaskStore} from './tasks.mjs';
import {Conversations} from './conversations.mjs';
import {WorkerGateway} from './worker-gateway.mjs';
import {listenLifeHost} from './http.mjs';
import {PublicActivityStore} from './public-activity.mjs';
import {mountLegacyWorker,legacyWorkerTools} from './legacy-worker.mjs';

function legacyContext(header,{cold=false,resolveShape='agent'}={}) {
  const tools=new Map(),sections=new Map(),listeners=new Map(),effects=[];let live,resolveCalls=0,forbiddenCalls=0;
  const forbidden=()=>{forbiddenCalls++;throw new Error('TEST ONLY native prompt, wake, Session write or cancellation forbidden');};
  const primaryScope={tools:{register:tool=>{assert(!tools.has(tool.name));tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},
    systemPrompt:{section:section=>{assert(!sections.has(section.name));sections.set(section.name,section);return()=>sections.delete(section.name);}}};
  const primary={session:{id:header.id,header,append:forbidden},ctx:primaryScope,prompt:forbidden,send:forbidden,followup:forbidden,
    steer:forbidden,cancel:forbidden,interrupt:forbidden};
  live=cold?undefined:primary;
  const ctx={agents:{get:id=>id===header.id?live:undefined,create:forbidden,resume:forbidden},
    sessionController:{resolveAgent:async id=>{assert.equal(id,header.id);resolveCalls++;live=primary;return resolveShape==='handle'?{agent:primary}:primary;},prompt:forbidden},
    on(name,fn){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);},
    effect(fn){effects.push(fn());},prompt:forbidden,runtime:{prompt:forbidden,peerPrompt:forbidden},sessions:{append:forbidden}};
  return {ctx,primary,tools,sections,effects,execution:()=>({agent:primary,callId:randomUUID(),signal:new AbortController().signal}),
    setLive:value=>{live=value;},resolveCalls:()=>resolveCalls,forbiddenCalls:()=>forbiddenCalls,
    async emit(name,payload){for(const fn of listeners.get(name)??[])await fn(payload);}};
}

async function setup(options={}) {
  const fixture=await createFixture(['A','B']);let registry,http,worker;
  try {
    fixture.manifests[0].deployment.presetId='persona';
    registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});for(const m of fixture.manifests)registry.register(m);
    const contexts=new LifeContexts(registry),taskRoot=resolve(fixture.root,'TEST-ONLY-legacy-worker-tasks'),roomRoot=resolve(fixture.root,'TEST-ONLY-legacy-worker-rooms');
    const tasks=new TaskStore({contexts,root:taskRoot}),rooms=new Conversations({contexts,root:roomRoot,tasks}),tokens=fixture.manifests.map(()=> 'TEST ONLY PRIVATE HOST TOKEN '+randomUUID());
    const activityRoot=resolve(fixture.root,'TEST-ONLY-legacy-public-activity'),activity=new PublicActivityStore({contexts,root:activityRoot});
    const bindings=new Map(fixture.manifests.map((m,index)=>[m.lifeId,{token:tokens[index],allowedPresetId:m.deployment.presetId,...index===0?{humanPrincipalId:'human:maintainer'}:{}}]));
    const gateway=new WorkerGateway({registry,rooms,tasks,activity,workerBindings:bindings});
    const requests=[];const dispatch=new Proxy(gateway,{get(target,name){const value=target[name];return typeof value==='function'?function(...args){if(name!=='authenticate')requests.push(name);return value.apply(target,args);}:value;}});
    const hostEffects=[];
    http=await listenLifeHost({ctx:{effect:fn=>hostEffects.push(fn())},contexts,rooms,workerGateway:dispatch},
      {principalId:'human:maintainer',displayName:'TEST ONLY AUTHENTICATED HUMAN',token:'TEST ONLY LOCAL HUMAN CHANNEL '+randomUUID()});
    const [A,B]=fixture.manifests;
    const header={version:4,id:A.authoritySessionId,cwd:A.deployment.workspace,createdAt:1,isSeeded:false,TEST_ONLY_privateExtra:'must not be transmitted'};
    const native=legacyContext(header,options),settings={lifeId:A.lifeId,authoritySessionId:A.authoritySessionId,workspace:A.deployment.workspace,presetId:'persona',supervisorUrl:'http://127.0.0.1:'+http.port,token:tokens[0]};
    const b=gateway.authenticate({lifeId:B.lifeId,token:tokens[1]});
    gateway.registerSession(b,{header:{version:4,id:B.authoritySessionId,cwd:B.deployment.workspace,createdAt:2,isSeeded:false,agentPreset:B.deployment.presetId},presetId:B.deployment.presetId,role:'authority'});
    const t={fixture,registry,contexts,tasks,rooms,activity,gateway,requests,http,tokens,native,settings,b,roomRoot,taskRoot,activityRoot,
      async mount(override={}){worker=await mountLegacyWorker(native.ctx,{...settings,...override});t.worker=worker;return worker;},
      async tool(name,args={},exec=native.execution()){return native.tools.get(name).execute(args,exec);},
      async cleanup(){worker?.dispose();for(const fn of hostEffects)await fn();rooms.close();registry.close();await fixture.cleanup();}};
    return t;
  }catch(error){worker?.dispose();if(http)await http.close();registry?.close();await fixture.cleanup();throw error;}
}

test('legacy worker binds the actual primary Agent and a whitelisted native Header; secondary or forged execution cannot send',async()=>{
  const t=await setup({cold:true,resolveShape:'handle'});
  try {
    const worker=await t.mount(),[A,B]=t.fixture.manifests;assert.equal(t.native.resolveCalls(),1);
    assert.equal(t.native.tools.has('postHuman'),false);await assert.rejects(worker.postHuman({args:{sender_id:'human:maintainer',body:'TEST ONLY FORGED HUMAN'}}),/LEGACY_WORKER_ARGUMENT_SCOPE_INVALID/);
    assert.deepEqual(worker.status().tools,[...legacyWorkerTools]);assert.equal(worker.status().ready,true);assert.equal(worker.status().life_id,A.lifeId);
    assert.equal(worker.status().registered_session_id,A.authoritySessionId);assert.equal(t.registry.owner(A.authoritySessionId).role,'authority');
    assert.equal(t.registry.owner(A.authoritySessionId).legacyHeaderPresetAbsentVerified,true);
    const room=t.rooms.defineRoom({participants:[A.lifeId,B.lifeId]});
    const forgery={...t.native.primary,session:{id:A.authoritySessionId,header:{...t.native.primary.session.header}}};
    const secondary={...t.native.primary,session:{id:randomUUID(),header:{...t.native.primary.session.header,id:randomUUID()}}};
    const input={room_id:room.room_id,body:'TEST ONLY FORGED A'};
    for(const agent of [forgery,secondary])await assert.rejects(t.tool('life_send_message',input,{agent,signal:new AbortController().signal}),/LEGACY_WORKER_AUTHORITY_AGENT_REQUIRED/);
    const aborted=new AbortController();aborted.abort();await assert.rejects(t.tool('life_send_message',input,{agent:t.native.primary,signal:aborted.signal}),/LEGACY_WORKER_REQUEST_ABORTED/);
    assert.equal(t.gateway.inbox(t.b).items.length,0);
    await assert.rejects(t.tool('life_send_message',{...input,sender_id:B.lifeId}),/LEGACY_WORKER_ARGUMENT_SCOPE_INVALID|invalid tool args/);
    const original=t.native.primary.session.header.cwd;t.native.primary.session.header.cwd=B.deployment.workspace;
    await assert.rejects(t.tool('life_room_list'),/LEGACY_WORKER_AUTHORITY_HEADER_MISMATCH/);t.native.primary.session.header.cwd=original;
    const message=await t.tool('life_send_message',{room_id:room.room_id,body:'TEST ONLY ACTUAL PRIMARY'});
    assert.equal(message.sender_id,A.lifeId);assert.equal(message.origin_session_id,A.authoritySessionId);assert.equal(message.origin_task_id,t.tasks.forSession(A.authoritySessionId).task_id);
    const bInbox=t.gateway.inbox(t.b);assert.equal(bInbox.items[0].status,'pending');assert.equal(bInbox.items[0].message.sender_id,A.lifeId);
    const inspection=await worker.inspect();assert.equal(inspection.rooms[0].room_id,room.room_id);assert.equal(inspection.inbox.owner_life_id,A.lifeId);
    const json=JSON.stringify(worker.status())+JSON.stringify(inspection)+[...t.native.sections.values()].map(s=>s.text()).join('\n');
    for(const token of t.tokens)assert(!json.includes(token));assert(!json.includes('TEST ONLY ACTUAL PRIMARY'),'availability prompt/status must not inject peer bodies');
    assert(!JSON.stringify(t.registry.owner(A.authoritySessionId)).includes('must not be transmitted'));
    assert.equal(t.native.forbiddenCalls(),0);assert.equal(existsSync(resolve(t.fixture.nativeRoot,'sessions')),false);
    worker.dispose();assert.equal(worker.status().ready,false);assert.equal(t.native.tools.size,0);assert.equal(t.native.sections.size,0);
  }finally{await t.cleanup();}
});

test('shared timeline retains Host source; public observer and self activity cannot disclose or impersonate private owners',async()=>{
  const t=await setup();
  try {
    const worker=await t.mount(),[A,B]=t.fixture.manifests,room=t.rooms.defineRoom({participants:[A.lifeId,B.lifeId,'human:maintainer']});
    const occurredAt=new Date(Date.now()-60000).toISOString();
    const human=await worker.postHuman({args:{room_id:room.room_id,body:'TEST ONLY HUMAN MESSAGE',message_id:randomUUID()},occurredAt});
    assert.equal(human.sender_id,'human:maintainer');assert.equal(human.sender_type,'human');
    assert.equal(human.timestamp,occurredAt);assert.notEqual(human.observed_at,occurredAt);
    const a=await worker.postOwn({args:{room_id:room.room_id,body:'TEST ONLY A TIMELINE'}});assert.equal(t.native.tools.has('postOwn'),false);
    const b=t.gateway.post(t.b,{sessionId:B.authoritySessionId,args:{room_id:room.room_id,body:'TEST ONLY B TIMELINE'}});
    const timeline=await t.tool('life_message_timeline');assert.deepEqual(timeline.messages.map(m=>m.message_id),[human.message_id,a.message_id,b.message_id]);
    assert.deepEqual(timeline.messages.map(m=>m.sender_id),['human:maintainer',A.lifeId,B.lifeId]);
    assert.deepEqual(timeline.messages.map(m=>m.timeline_seq),[1,2,3]);assert.equal(timeline.order,'host-committed-timeline');
    assert.equal((await t.tool('life_message_timeline',{after:human.timeline_seq,limit:1})).messages[0].message_id,a.message_id);
    const aInbox=await t.tool('life_receive_message');assert.equal(aInbox.items.length,2);assert.equal(aInbox.items.find(item=>item.message_id===b.message_id).message.sender_id,B.lifeId);
    assert.equal(aInbox.items.filter(item=>item.message_id===human.message_id).length,1,'human input has one semantic row; native ingress prevents a second automatic admission');
    await worker.recordActivity({phase:'thinking'});assert.equal(t.activity.read(A.lifeId).busy,true);
    await worker.recordActivity({phase:'idle'});assert.equal(t.activity.read(A.lifeId).busy,false);
    t.gateway.activity(t.b,{sessionId:B.authoritySessionId,args:{text:'TEST ONLY VOLUNTARY B PUBLIC ACTIVITY',visibility:'public'}});
    t.activity.recordHost({lifeId:B.lifeId,sessionId:B.authoritySessionId,phase:'tool',toolName:'life_room_read'});
    const observed=await t.tool('observe_life',{life_id:B.lifeId});assert.equal(observed.life_id,B.lifeId);assert.equal(observed.activity_text,'TEST ONLY VOLUNTARY B PUBLIC ACTIVITY');
    assert.equal(observed.last_public_tool,'life_room_read');assert.equal(observed.busy,true);
    for(const field of ['session_id','args','thought','memory','core','filename','body'])assert.equal(Object.hasOwn(observed,field),false);
    t.activity.recordHost({lifeId:B.lifeId,sessionId:B.authoritySessionId,phase:'tool',toolName:'private_read'});
    const hidden=await t.tool('observe_life',{life_id:B.lifeId});assert.equal(hidden.phase,'private');assert.equal(hidden.activity_text,null);assert.equal(hidden.last_public_tool,null);
    const own=await t.tool('life_activity_publish',{text:'TEST ONLY A PUBLIC ACTIVITY',visibility:'public'});assert.equal(own.life_id,A.lifeId);
    const privateView=await t.tool('life_activity_publish',{text:'TEST ONLY A PRIVATE ACTIVITY CANARY',visibility:'private'});assert.equal(privateView.activity_text,null);
    await assert.rejects(t.tool('life_activity_publish',{text:'TEST ONLY SPOOF B',life_id:B.lifeId}),/LEGACY_WORKER_ARGUMENT_SCOPE_INVALID|invalid tool args/);
    await assert.rejects(t.tool('life_message_timeline',{life_id:B.lifeId}),/LEGACY_WORKER_ARGUMENT_SCOPE_INVALID|invalid tool args/);
    assert(!JSON.stringify(observed).includes('PRIVATE ACTIVITY'));assert(![...t.native.sections.values()].map(s=>s.text()).join('\n').includes('TEST ONLY B TIMELINE'));
    const persisted=await readFile(resolve(t.activityRoot,'public-activity.json'),'utf8');assert(!persisted.includes('PRIVATE ACTIVITY CANARY'));assert(!persisted.includes('private_read'));
    for(const token of t.tokens)assert(!JSON.stringify(timeline).includes(token));assert.equal(t.native.forbiddenCalls(),0);
  }finally{await t.cleanup();}
});

test('formal inbox remains queued on peek; receiver explicitly defers, replies or ignores without native prompts',async()=>{
  const t=await setup();
  try {
    await t.mount();const [A,B]=t.fixture.manifests,room=t.rooms.defineRoom({participants:[A.lifeId,B.lifeId]});
    const sent=t.gateway.post(t.b,{sessionId:B.authoritySessionId,args:{room_id:room.room_id,body:'TEST ONLY TRUSTED B MESSAGE'}});
    const inbox=await t.tool('life_receive_message'),item=inbox.items[0];assert.equal(item.message.message_id,sent.message_id);assert.equal(item.message.sender_id,B.lifeId);assert.equal(item.status,'pending');
    assert.equal((await t.tool('life_receive_message')).items[0].revision,item.revision);
    const deferred=await t.tool('life_message_decide',{inbox_id:item.inbox_id,action:'defer',expected_revision:item.revision,until:new Date(Date.now()+60000).toISOString()});
    assert.equal(deferred.status,'deferred');
    await assert.rejects(t.tool('life_message_decide',{inbox_id:item.inbox_id,action:'ignore',expected_revision:item.revision}),/INBOX_REVISION_CONFLICT/);
    await t.tool('life_send_message',{room_id:room.room_id,reply_to:sent.message_id,body:'TEST ONLY CHOSEN A REPLY'});
    const replied=(await t.tool('life_receive_message')).items[0];assert.equal(replied.status,'deferred');assert.equal(replied.effect_result.status,'confirmed_success');
    const reply=await t.tool('life_message_decide',{decision_token:replied.decision_token,action:'complete'});assert.equal(reply.status,'handled');assert.equal((await t.tool('life_receive_message')).items.length,0);
    const bInbox=t.gateway.inbox(t.b);assert.equal(bInbox.items[0].message.sender_id,A.lifeId);assert.equal(bInbox.items[0].message.body,'TEST ONLY CHOSEN A REPLY');
    t.gateway.post(t.b,{sessionId:B.authoritySessionId,args:{room_id:room.room_id,body:'TEST ONLY MAY IGNORE'}});
    const second=(await t.tool('life_receive_message')).items[0],ignored=await t.tool('life_message_decide',{inbox_id:second.inbox_id,action:'ignore',expected_revision:second.revision});
    assert.equal(ignored.status,'ignored');assert.equal((await t.tool('life_receive_message')).items.length,0);
    const terminal=await t.tool('life_receive_message',{includeTerminal:true});assert.equal(terminal.items.length,2);
    assert.equal((await t.tool('life_room_read',{room_id:room.room_id})).messages.length,3);
    assert.equal(t.native.forbiddenCalls(),0);assert(t.requests.every(name=>['registerSession','list','read','post','inbox','decide'].includes(name)));
    for(const token of t.tokens)for(const path of [resolve(t.roomRoot,'rooms.sqlite'),resolve(t.taskRoot,'tasks.json')])assert(!(await readFile(path,'utf8')).includes(token));
  }finally{await t.cleanup();}
});

test('membership removal/rejoin preserves Room visibility epochs for the actual legacy receiver',async()=>{
  const t=await setup();
  try {
    await t.mount();const [A,B]=t.fixture.manifests,room=t.rooms.defineRoom({participants:[A.lifeId,B.lifeId]});
    const post=body=>t.gateway.post(t.b,{sessionId:B.authoritySessionId,args:{room_id:room.room_id,body}});
    post('TEST ONLY OLD A MEMBERSHIP');const previous=(await t.tool('life_receive_message')).items[0];
    t.rooms.setMembership({room_id:room.room_id,principalId:A.lifeId,present:false,expectedRevision:1});
    await assert.rejects(t.tool('life_room_read',{room_id:room.room_id}),/CONVERSATION_NOT_VISIBLE/);
    assert.equal((await t.tool('life_room_list')).length,0);assert.equal((await t.tool('life_receive_message')).items.length,0);
    post('TEST ONLY A ABSENT');t.rooms.setMembership({room_id:room.room_id,principalId:A.lifeId,present:true,expectedRevision:2});
    assert.equal((await t.tool('life_room_read',{room_id:room.room_id})).messages.length,0);post('TEST ONLY NEW A MEMBERSHIP');
    const fresh=(await t.tool('life_receive_message')).items[0];assert.notEqual(fresh.membership_epoch,previous.membership_epoch);assert.equal(fresh.message.body,'TEST ONLY NEW A MEMBERSHIP');
    await assert.rejects(t.tool('life_message_decide',{inbox_id:previous.inbox_id,action:'complete',expected_revision:previous.revision}),/INBOX_MEMBERSHIP_REVOKED/);
    assert.equal((await t.tool('life_room_read',{room_id:room.room_id})).messages.length,1);assert.equal(t.native.forbiddenCalls(),0);
  }finally{await t.cleanup();}
});

test('binding, transport and disposed/replaced Agents fail closed; legacy frozen fetch does not block loopback control',async()=>{
  const t=await setup({cold:true});const savedFetch=globalThis.fetch;
  try {
    for(const supervisorUrl of ['https://127.0.0.1:1','http://localhost:1','http://127.0.0.1:1/arbitrary','http://user:private@127.0.0.1:1'])await assert.rejects(t.mount({supervisorUrl}),/LOOPBACK_SUPERVISOR_REQUIRED/);
    await assert.rejects(t.mount({presetId:'secondary'}),/WORKER_SESSION_HEADER_MISMATCH/);
    await assert.rejects(t.mount({token:t.tokens[1]}),/WORKER_AUTHENTICATION_FAILED/);
    assert.equal(t.native.tools.size,0);
    globalThis.fetch=async()=>{throw new Error('TEST ONLY protected fetch forbids loopback');};
    const worker=await t.mount();assert.equal(worker.status().ready,true);await worker.inspect();assert.equal(t.native.resolveCalls(),1);
    const removed=t.native.primary;t.native.setLive(undefined);await t.native.emit('agent/disposed',{agent:removed});assert.equal(worker.status().ready,false);
    await assert.rejects(t.tool('life_receive_message'),/LEGACY_WORKER_AUTHORITY_AGENT_REQUIRED/);
    t.native.setLive(removed);await t.native.emit('agent/created',{agent:removed});assert.equal(worker.status().ready,false,'disposed exact instance must not silently regain authority');
    worker.dispose();assert.equal(t.native.tools.size,0);assert.equal(t.native.forbiddenCalls(),0);
  }finally{globalThis.fetch=savedFetch;await t.cleanup();}
});
