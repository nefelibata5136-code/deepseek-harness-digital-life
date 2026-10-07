import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {LlmAdapter,freezeMessage} from '@deepseek-ai/dsh-llm';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {TaskStore} from './tasks.mjs';
import {Conversations} from './conversations.mjs';
import {WorkerGateway} from './worker-gateway.mjs';
import {mountLegacyRoomInbox} from './legacy-room-inbox.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST ONLY native inbox deadline')),15000);})]);}finally{clearTimeout(timer);}}
class Stub extends LlmAdapter {
  entries=[];
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}
  async *stream(options){
    this.entries.push(options.sessionId);await this.onStream?.(options);
    const block={type:'text',text:'TEST ONLY OPTIONAL ROOM RESPONSE'};
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:block.text};
    yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:'stop'}};
  }
}
async function setup(){
  const fixture=await createFixture(['A','B']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});let host,inbox;
  try {
    for(const m of fixture.manifests)registry.register(m);
    const adapter=new Stub();host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter,providerRoutes:['TEST-shared-provider']});
    const agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    const contexts=host.contexts,tasks=new TaskStore({contexts,root:resolve(fixture.root,'TEST-ONLY-inbox-tasks')}),rooms=new Conversations({contexts,tasks,root:resolve(fixture.root,'TEST-ONLY-inbox-rooms')});
    const tokens=fixture.manifests.map(()=> 'TEST ONLY PRIVATE INBOX TOKEN '+randomUUID()),gateway=new WorkerGateway({registry,rooms,tasks,
      workerBindings:new Map(fixture.manifests.map((m,i)=>[m.lifeId,{token:tokens[i],allowedPresetId:m.deployment.presetId}]))});
    const handles=fixture.manifests.map((m,i)=>gateway.authenticate({lifeId:m.lifeId,token:tokens[i]}));
    agents.forEach((agent,i)=>gateway.registerSession(handles[i],{header:agent.session.header,presetId:fixture.manifests[i].deployment.presetId,role:'authority'}));
    const [A,B]=fixture.manifests,room=rooms.defineRoom({participants:[A.lifeId,B.lifeId]}),root=resolve(fixture.root,'TEST-ONLY-A-inbox-control'),calls=[];
    const bridge={status:()=>({ready:true,life_id:A.lifeId,registered_session_id:A.authoritySessionId}),
      async inspect(args){calls.push('inspect');return {inbox:gateway.inbox(handles[0],args)};},
      ...Object.fromEntries(['selectDelivery','authorizeDelivery','acknowledgeDelivery','failDelivery'].map(name=>[name,async args=>{calls.push(name);return gateway[name](handles[0],{sessionId:A.authoritySessionId,...args});}]))};
    const t={fixture,registry,host,adapter,agents,rooms,gateway,handles,bridge,calls,root,room,A,B,
      post(body='TEST ONLY PEER BODY'){return gateway.post(handles[1],{sessionId:B.authoritySessionId,args:{room_id:room.room_id,body}});},
      selfInbox(){return gateway.inbox(handles[0]);},
      async mount(override={}){inbox=await mountLegacyRoomInbox({ctx:host.ctx,bridge,lifeId:A.lifeId,authoritySessionId:A.authoritySessionId,root,intervalMs:60000,...override});t.inbox=inbox;return inbox;},
      async policy(args={},agent=agents[0]){return host.ctx.tools.get('life_inbox_policy',agents[0]).execute(args,{agent,signal:new AbortController().signal});},
      async idle(index=0){return bounded(agents[index].whenIdle());},
      async cleanup(){inbox?.dispose();await inbox?.drain();await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}};
    return t;
  }catch(error){inbox?.dispose();if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();throw error;}
}
const roomEvents=(t,index=0)=>[...t.agents[index].session.ownEvents()].filter(e=>e.type==='user/message'&&e.data.source?.kind==='room-inbox');
const prompt=(t,index)=>t.host.runtime.prompt({lifeId:t.fixture.manifests[index].lifeId,sessionId:t.agents[index].session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY OWN NATIVE BUSY BARRIER'}]});

test('formal peer source enters native idle turns repeatedly; policy is self-owned and human ingress defaults off',async()=>{
  const t=await setup();
  try {
    const inbox=await t.mount();assert.equal(t.host.ctx.tools.get('life_inbox_policy',t.agents[1]),undefined);
    await assert.rejects(t.policy({rest:true},t.agents[1]),/LEGACY_INBOX_AUTHORITY_REQUIRED/);
    assert.deepEqual(inbox.status().policy,{peer_idle:true,human_idle:false,rest:false});
    t.rooms.registerHuman({sender_id:'human:TEST',display_name:'TEST ONLY HUMAN'});
    const humanRoom=t.rooms.defineRoom({participants:['human:TEST',t.A.lifeId]});t.rooms.postHuman('human:TEST',{room_id:humanRoom.room_id,body:'TEST ONLY ALREADY NATIVE HUMAN'});
    await t.policy({rest:true});t.post();assert.equal((await inbox.tick()).state,'rest');assert.equal(t.adapter.entries.length,0);
    await t.policy({rest:false});
    for(let round=0;round<3;round++){
      if(round)t.post('TEST ONLY CONTINUING PEER '+round);
      assert.equal((await inbox.tick()).state,'admitted');await t.idle();
      assert.equal(roomEvents(t).length,round+1);assert.equal(t.adapter.entries.length,round+1);
    }
    assert.equal((await inbox.tick()).state,'idle');assert.equal(t.adapter.entries.length,3);
    const event=roomEvents(t)[0];assert.equal(event.data.source.senderPrincipalId,t.B.lifeId);assert.equal(event.data.source.receiverLifeId,t.A.lifeId);
    assert.equal(event.data.source.sender.sender_type,'life');assert.equal(event.data.source.roomId,t.room.room_id);assert.notEqual(event.data.source.kind,'user');
    const payload=JSON.parse(event.data.content[0].text);assert.equal(payload.message.body,'TEST ONLY PEER BODY');assert.deepEqual(payload.choices,['reply','defer','ignore']);
    assert.equal(t.selfInbox().items.find(x=>x.message.sender_type==='human').status,'queued');
    const policy=readFileSync(resolve(t.root,'room-inbox-policy.json'),'utf8');assert(!policy.includes('TEST ONLY PEER BODY'));assert(!policy.includes('TEST ONLY ALREADY NATIVE HUMAN'));
    assert.equal(inbox.status().conversation_round_limit,null);assert.equal(inbox.status().envelopes_admitted,3);
  }finally{await t.cleanup();}
});

test('own native busy turn preserves central inbox without selecting; another owner running does not freeze delivery',async()=>{
  const t=await setup(),releaseA=deferred(),releaseB=deferred(),enteredA=deferred(),enteredB=deferred();
  try {
    const inbox=await t.mount();
    t.adapter.onStream=async options=>{if(options.sessionId===t.A.authoritySessionId){enteredA.resolve();await releaseA.promise;}else{enteredB.resolve();await releaseB.promise;}};
    await prompt(t,0);await bounded(enteredA.promise);t.post('TEST ONLY STORED WHILE A BUSY');
    assert.equal((await inbox.tick()).state,'busy');assert.equal(t.calls.length,0);assert.equal(t.selfInbox().items[0].status,'queued');assert.equal(roomEvents(t).length,0);
    releaseA.resolve();await t.idle();
    await prompt(t,1);await bounded(enteredB.promise);assert.equal(t.agents[1].status,'running');
    assert.equal((await inbox.tick()).state,'admitted');await t.idle();assert.equal(roomEvents(t).length,1);assert.equal(t.agents[1].status,'running');
    assert.equal(t.selfInbox().items[0].status,'admitted');releaseB.resolve();await t.idle(1);
  }finally{releaseA.resolve();releaseB.resolve();await t.cleanup();}
});

test('authorization revoked after native flush and ACK failure remove the exact envelope before maintenance releases wake',async()=>{
  for(const mode of ['revoked','ack-failure']){
    const t=await setup();
    try {
      let authorizations=0;const realAuthorize=t.bridge.authorizeDelivery;
      if(mode==='revoked')t.bridge.authorizeDelivery=async args=>{if(++authorizations===2)t.rooms.setMembership({room_id:t.room.room_id,principalId:t.A.lifeId,present:false,expectedRevision:1});return realAuthorize(args);};
      else t.bridge.acknowledgeDelivery=async()=>{const error=Error('TEST ONLY ACK transport failed');error.code='TEST_ACK_FAILED';throw error;};
      const inbox=await t.mount();t.post();const result=await inbox.tick();assert.equal(result.state,'needs_review');await t.idle();
      assert.equal(t.adapter.entries.length,0);assert.equal(roomEvents(t).length,0);assert.equal(t.agents[0].inbox.hasPending,false);assert.equal(inbox.status().needs_review,1);
      assert.equal((await inbox.tick()).state,'idle');assert.equal(t.calls.filter(x=>x==='selectDelivery').length,1);
      if(mode==='ack-failure')assert.equal(t.selfInbox().items[0].status,'needs_review');
    }finally{await t.cleanup();}
  }
});

test('pending recovery reuses one attempt and native RPC; materialized cold recovery acknowledges without another model call',async()=>{
  const t=await setup();
  try {
    const inbox=await t.mount();t.post('TEST ONLY PENDING RECOVERY');let row=t.selfInbox().items[0];
    const first=await t.bridge.selectDelivery({inbox_id:row.inbox_id,expectedRevision:row.revision}),pending=freezeMessage(structuredClone(first.native_message));
    await t.agents[0].runMaintenance(async()=>{t.agents[0].send(pending,'next-turn',false);await t.host.ctx.sessions.flush(t.agents[0].session);});
    assert.equal(t.adapter.entries.length,0);assert.equal((await inbox.tick()).state,'admitted');await t.idle();
    assert.equal(t.selfInbox().items[0].attempt.attempt_id,first.attempt.attempt_id);assert.equal(roomEvents(t).length,1);assert.equal(roomEvents(t)[0].data.id,pending.id);
    t.post('TEST ONLY MATERIALIZED RECOVERY');row=t.selfInbox().items.find(x=>x.status==='queued');
    const second=await t.bridge.selectDelivery({inbox_id:row.inbox_id,expectedRevision:row.revision}),materialized=freezeMessage(structuredClone(second.native_message));
    await t.agents[0].runMaintenance(async()=>{t.agents[0].send(materialized,'next-turn',true);await t.host.ctx.sessions.flush(t.agents[0].session);});await t.idle();
    assert.equal(t.adapter.entries.length,2);inbox.dispose();const cold=await t.mount();assert.equal((await cold.tick()).state,'materialized');await t.idle();
    assert.equal(t.adapter.entries.length,2);assert.equal(roomEvents(t).length,2);assert.equal(cold.status().materialized_recovered,1);assert.equal((await cold.tick()).state,'idle');
    assert.equal(t.selfInbox().items.find(x=>x.inbox_id===row.inbox_id).attempt.attempt_id,second.attempt.attempt_id);
  }finally{await t.cleanup();}
});

test('forged receiver or source cannot enter the native inbox',async()=>{
  const t=await setup();
  try {
    const real=t.bridge.selectDelivery;t.bridge.selectDelivery=async args=>{const result=structuredClone(await real(args));result.native_message.source.receiverLifeId=t.B.lifeId;return result;};
    const inbox=await t.mount();t.post();const result=await inbox.tick();assert.equal(result.error_code,'TRUSTED_STABLE_ROOM_ENVELOPE_REQUIRED');await t.idle();
    assert.equal(t.adapter.entries.length,0);assert.equal(t.agents[0].inbox.hasPending,false);assert.equal(roomEvents(t).length,0);
  }finally{await t.cleanup();}
});

test('disabled automatic policies leave queued messages untouched while explicit peer and human process remain available; rest still blocks',async()=>{
  const t=await setup();
  try {
    const inbox=await t.mount();await t.policy({peer_idle:false,human_idle:false});t.post('TEST ONLY EXPLICIT PEER');
    t.rooms.registerHuman({sender_id:'human:TEST',display_name:'TEST ONLY EXPLICIT HUMAN'});
    const humanRoom=t.rooms.defineRoom({participants:['human:TEST',t.A.lifeId]});t.rooms.postHuman('human:TEST',{room_id:humanRoom.room_id,body:'TEST ONLY EXPLICIT HUMAN PROCESS'});
    assert.equal((await inbox.tick()).state,'idle');assert.equal(t.calls.filter(x=>x==='selectDelivery').length,0);assert.equal(t.adapter.entries.length,0);
    let peer=t.selfInbox().items.find(x=>x.message.sender_type==='life');t.gateway.decide(t.handles[0],{sessionId:t.A.authoritySessionId,args:{inbox_id:peer.inbox_id,action:'process',expectedRevision:peer.revision}});
    await t.policy({rest:true});assert.equal((await inbox.tick()).state,'rest');assert.equal(t.adapter.entries.length,0);
    await t.policy({rest:false});assert.equal((await inbox.tick()).state,'admitted');await t.idle();assert.equal(t.adapter.entries.length,1);
    let human=t.selfInbox().items.find(x=>x.message.sender_type==='human');assert.equal(human.status,'queued');
    t.gateway.decide(t.handles[0],{sessionId:t.A.authoritySessionId,args:{inbox_id:human.inbox_id,action:'process',expectedRevision:human.revision}});
    assert.equal((await inbox.tick()).state,'admitted');await t.idle();assert.equal(t.adapter.entries.length,2);
    const humanEvent=roomEvents(t).find(e=>e.data.source.senderPrincipalId==='human:TEST');assert.equal(humanEvent.data.source.sender.sender_type,'human');assert.equal(humanEvent.data.source.kind,'room-inbox');
    assert.deepEqual(inbox.status().policy,{peer_idle:false,human_idle:false,rest:false});
  }finally{await t.cleanup();}
});

test('queued selection cannot become an explicit choice when automatic policy closes during the select RPC',async()=>{
  const t=await setup();
  try {
    const inbox=await t.mount(),realSelect=t.bridge.selectDelivery;t.post();
    t.bridge.selectDelivery=async args=>{const selected=await realSelect(args);await t.policy({peer_idle:false});return selected;};
    assert.equal((await inbox.tick()).state,'busy');await t.idle();assert.equal(t.adapter.entries.length,0);assert.equal(t.agents[0].inbox.hasPending,false);
    const retried=t.selfInbox().items[0];assert.equal(retried.status,'requested');assert.equal((await inbox.tick()).state,'idle');assert.equal(t.adapter.entries.length,0);
    t.bridge.selectDelivery=realSelect;
    t.gateway.decide(t.handles[0],{sessionId:t.A.authoritySessionId,args:{inbox_id:retried.inbox_id,action:'process',expectedRevision:retried.revision}});
    assert.equal((await inbox.tick()).state,'admitted');await t.idle();assert.equal(t.adapter.entries.length,1);assert.equal(roomEvents(t).length,1);
  }finally{await t.cleanup();}
});

test('an explicit choice survives processing and cold recovery while automatic ingress remains disabled',async()=>{
  const t=await setup();
  try {
    let inbox=await t.mount();await t.policy({peer_idle:false,human_idle:false});t.post();const row=t.selfInbox().items[0];
    t.gateway.decide(t.handles[0],{sessionId:t.A.authoritySessionId,args:{inbox_id:row.inbox_id,action:'process',expectedRevision:row.revision}});
    const realSelect=t.bridge.selectDelivery,realFail=t.bridge.failDelivery;
    t.bridge.selectDelivery=async args=>{const selected=await realSelect(args);await t.policy({rest:true});return selected;};
    t.bridge.failDelivery=async()=>{const error=Error('TEST ONLY offline failure reporting');error.code='TEST_OFFLINE';throw error;};
    assert.equal((await inbox.tick()).state,'busy');assert.equal(t.selfInbox().items[0].status,'processing');assert.equal(t.adapter.entries.length,0);
    const attempt=t.selfInbox().items[0].attempt.attempt_id;inbox.dispose();t.bridge.selectDelivery=realSelect;t.bridge.failDelivery=realFail;
    inbox=await t.mount();assert.equal((await inbox.tick()).state,'rest');await t.policy({rest:false});
    assert.equal((await inbox.tick()).state,'admitted');await t.idle();assert.equal(t.adapter.entries.length,1);assert.equal(t.selfInbox().items[0].attempt.attempt_id,attempt);
    assert.equal(roomEvents(t).length,1);assert.deepEqual(inbox.status().policy,{peer_idle:false,human_idle:false,rest:false});
  }finally{await t.cleanup();}
});
