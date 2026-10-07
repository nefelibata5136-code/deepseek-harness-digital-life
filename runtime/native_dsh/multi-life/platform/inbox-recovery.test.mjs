import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {LlmAdapter,LlmError} from '@deepseek-ai/dsh-llm';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {interruptedTurnClosers} from '@deepseek-ai/dsh-session';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {Conversations} from './conversations.mjs';
import {TaskStore} from './tasks.mjs';
import {WorkerGateway} from './worker-gateway.mjs';
import {mountRoomInbox} from './legacy-room-inbox.mjs';
import {nativeInboxEvidence,batchInboxSelection,nativeToolResultForCall} from './inbox-recovery.mjs';
import {communicationEventId} from './social.mjs';

class Stub extends LlmAdapter {
  calls=0;failOnce=false;failPreparation=false;failPreparationCode='UNSUPPORTED_REASONING_EFFORT';toolBlocks=null;failAfterTools=false;
  async resolveModel(provider,id){if(this.failPreparation)throw new LlmError('TEST ONLY deterministic pre-provider failure',this.failPreparationCode);return {provider,id,name:id,context:{contextWindow:1000000},defaultMaxTokens:256};}
  async *stream(){this.calls++;if(this.failOnce||this.failAfterTools&&this.calls>1){this.failOnce=false;yield {type:'finish',reason:{kind:'error',failure:{code:'TRANSPORT',message:'TEST ONLY temporary provider failure',retryable:true}}};return;}
    if(this.toolBlocks&&this.calls===1){for(const [index,block] of this.toolBlocks.entries()){
      yield {type:'block-start',index,blockType:'tool-call'};yield {type:'tool-call-delta',index,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index,block};
    }yield {type:'finish',reason:{kind:'tool-calls'}};return;}
    const block={type:'text',text:'TEST ONLY optional decision postponed'};yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:block.text};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}};}
}
async function setup(){const fixture=await createFixture(['A','B']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});for(const manifest of fixture.manifests)registry.register(manifest);
  const adapter=new Stub(),host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter,providerRoutes:['TEST-shared-provider']});
  const agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'}))),contexts=agents.map(agent=>host.contexts.execution(agent));
  const tasks=new TaskStore({contexts:host.contexts,root:resolve(fixture.root,'TEST-ONLY-tasks')}),roomRoot=resolve(fixture.root,'TEST-ONLY-rooms'),rooms=new Conversations({contexts:host.contexts,root:roomRoot,tasks});
  const [A,B]=fixture.manifests,room=rooms.defineRoom({participants:[A.lifeId,B.lifeId]}),token='TEST ONLY '+randomUUID(),gateway=new WorkerGateway({registry,rooms,tasks,workerBindings:new Map([[B.lifeId,{token,allowedPresetId:B.deployment.presetId}]])}),handle=gateway.authenticate({lifeId:B.lifeId,token});
  gateway.registerSession(handle,{header:agents[1].session.header,presetId:B.deployment.presetId,role:'authority'});
  const bridge={status:()=>({ready:true,life_id:B.lifeId,registered_session_id:B.authoritySessionId}),async inspect(args){return {inbox:gateway.inbox(handle,args)};},
    ...Object.fromEntries(['selectDelivery','authorizeDelivery','acknowledgeDelivery','failDelivery','selectBatch','authorizeBatch','acknowledgeBatch','reconcileDelivery'].map(name=>[name,args=>gateway[name](handle,{sessionId:B.authoritySessionId,...args})]))};
  let driver;const stores=new Set([rooms.recentEvents.store]),roomInstances=new Set([rooms]);
  return {fixture,registry,host,adapter,agents,contexts,tasks,rooms,roomRoot,room,A,B,gateway,handle,bridge,
    post(body='TEST ONLY message'){return rooms.post(contexts[0],{room_id:room.room_id,body});},
    trackRooms(value){stores.add(value.recentEvents.store);roomInstances.add(value);return value;},
    async mount(){driver=await mountRoomInbox({ctx:host.ctx,bridge,lifeId:B.lifeId,authoritySessionId:B.authoritySessionId,root:resolve(fixture.root,'TEST-ONLY-policy'),intervalMs:60000,coalesceMs:0});return driver;},
    async idle(){await agents[1].whenIdle();await host.ctx.sessions.flush(agents[1].session);},
    async close(){driver?.dispose();await driver?.drain();await host.ctx.fiber.dispose();for(const value of roomInstances)value.close?.();for(const store of stores)store.close();registry.close();await fixture.cleanup();}};
}
test('send(reply_to) is the sole reply writer; old decide(reply) only recognizes the same existing receipt',async()=>{const t=await setup();try{
  for(const sendFirst of [true,false]){const m=t.post('TEST ONLY incoming '+sendFirst),item=t.rooms.receive(t.contexts[1]).items.find(i=>i.message_id===m.message_id),args={decision_token:item.decision_token,action:'reply',body:'TEST ONLY chosen reply'};
    const send=()=>t.rooms.post(t.contexts[1],{room_id:t.room.room_id,reply_to:m.message_id,body:args.body});
    if(!sendFirst)assert.throws(()=>t.rooms.decide(t.contexts[1],args),/REPLY_USE_SEND_MESSAGE/);
    const receipt=send();t.rooms.decide(t.contexts[1],args);assert.equal(receipt.effect_result.status,'confirmed_success');
    const cold=t.trackRooms(new Conversations({contexts:t.host.contexts,root:t.roomRoot,tasks:t.tasks}));cold.decide(t.contexts[1],args);
    const replies=cold.read(t.contexts[1],{room_id:t.room.room_id}).messages.filter(msg=>msg.reply_to===m.message_id);assert.equal(replies.length,1);
    assert.equal(cold.receive(t.contexts[1]).items.find(row=>row.message_id===m.message_id).status,'pending','a Room receipt never completes the semantic input');
    assert.throws(()=>cold.decide(t.contexts[1],{...args,body:'TEST ONLY second different reply'}),/REPLY_USE_SEND_MESSAGE/);
    assert.throws(()=>cold.post(t.contexts[1],{room_id:t.room.room_id,reply_to:m.message_id,body:'TEST ONLY second different reply'}),/REPLY_ALREADY_COMMITTED/);
  }
}finally{await t.close();}});
test('decision references are owner bound and stale choices fail while metadata admission keeps tokens usable',async()=>{const t=await setup();try{
  const m=t.post(),item=t.rooms.receive(t.contexts[1]).items[0];assert.throws(()=>t.rooms.decide(t.contexts[0],{decision_token:item.decision_token,action:'ignore'}),/INBOX_NOT_VISIBLE/);
  const selected=t.rooms.selectWorkerBatch({lifeId:t.B.lifeId,sessionId:t.B.authoritySessionId,items:[{inbox_id:item.inbox_id,expectedRevision:item.revision}]});t.rooms.acknowledgeWorkerBatchDelivery({lifeId:t.B.lifeId,sessionId:t.B.authoritySessionId,inbox_ids:[item.inbox_id],attempt_id:selected.attempt.attempt_id});
  t.rooms.decide(t.contexts[1],{decision_token:item.decision_token,action:'defer'});assert.throws(()=>t.rooms.decide(t.contexts[1],{decision_token:item.decision_token,action:'ignore'}),/DECISION_TOKEN_STALE/);
  const current=t.rooms.receive(t.contexts[1]).items[0];assert.throws(()=>t.rooms.decide(t.contexts[1],{inbox_id:m.message_id,action:'ignore',expectedRevision:current.revision}),/INBOX_ID_IS_MESSAGE_ID/);
  const done=t.rooms.decide(t.contexts[1],{message_ref:m.message_id,expectedRevision:current.revision,action:'ignore'});assert.equal(done.status,'ignored');
}finally{await t.close();}});
test('120 deferred prefix entries do not starve a 20-message burst; native wake/model count is one',async()=>{const t=await setup();try{
  for(let n=0;n<120;n++){t.post('TEST ONLY indefinite old '+n);const row=t.rooms.receive(t.contexts[1],{after:n,limit:100}).items.at(-1);t.rooms.decide(t.contexts[1],{decision_token:row.decision_token,action:'defer'});}
  const sent=[];for(let n=0;n<20;n++)sent.push(t.post('TEST ONLY burst '+n));
  assert.deepEqual(t.rooms.deliveryCandidates({lifeId:t.B.lifeId,limit:20}).map(i=>i.message_id),sent.map(m=>m.message_id));
  const driver=await t.mount(),result=await driver.tick();assert.equal(result.count,20);await t.idle();assert.equal(t.adapter.calls,1);assert.equal(driver.status().batch_wakes,1);
  const publicRows=t.rooms.receive(t.contexts[1],{after:120,limit:20}).items;assert(publicRows.every(row=>row.attempt.native_message===undefined&&row.attempt.native_message_id));
  const input=[...t.agents[1].session.ownEvents()].find(e=>e.type==='user/message'&&e.data.source.kind==='room-inbox-batch');const payload=JSON.parse(input.data.content[0].text);
  assert.deepEqual(payload.items.map(i=>i.event_id),sent.map(m=>communicationEventId(t.room.room_id,m.message_id)));assert.equal(new Set(payload.items.map(i=>i.event_id)).size,20);
  for(let n=0;n<payload.items.length;n++) {
    if(n%3===0)t.rooms.post(t.contexts[1],{room_id:t.room.room_id,reply_to:sent[n].message_id,body:'TEST ONLY reply '+n});
    t.rooms.decide(t.contexts[1],{decision_token:payload.items[n].decision_token,action:n%3===0?'complete':n%3===1?'ignore':'defer'});
  }
  await driver.tick();assert.equal(t.adapter.calls,1);assert.equal(t.rooms.receive(t.contexts[0]).items.length,7);
}finally{await t.close();}});
test('prepared before native admission resumes the stable attempt; completed execution leaves semantic input pending without rerunning',async()=>{const t=await setup();try{
  t.post();const item=t.rooms.receive(t.contexts[1]).items[0],selected=t.rooms.selectWorkerBatch({lifeId:t.B.lifeId,sessionId:t.B.authoritySessionId,items:[{inbox_id:item.inbox_id,expectedRevision:item.revision}]});
  const driver=await t.mount(),receipt=await driver.tick();assert.equal(receipt.attempt_id,selected.attempt.attempt_id);await t.idle();assert.equal(t.adapter.calls,1);
  await driver.tick();const reviewed=t.rooms.receive(t.contexts[1]).items[0];assert.equal(reviewed.status,'pending');assert.equal(reviewed.attempt.state,'completed');assert.equal(reviewed.requested,false);
  await driver.tick();assert.equal(t.adapter.calls,1);
}finally{await t.close();}});
test('completed native attempts are observed independently of send, ignore and defer without waking again',async()=>{const t=await setup();try{
  for(let n=0;n<3;n++)t.post('TEST ONLY decided batch '+n);
  const driver=await t.mount();await driver.tick();await t.idle();
  const original=t.rooms.receive(t.contexts[1]).items;
  t.rooms.post(t.contexts[1],{room_id:t.room.room_id,reply_to:original[0].message_id,body:'TEST ONLY unique reply'});
  for(let n=1;n<3;n++)t.rooms.decide(t.contexts[1],{decision_token:original[n].decision_token,action:['continue','ignore','defer'][n]});
  const before=t.rooms.inboxForLife({lifeId:t.B.lifeId,includeTerminal:true}).items;
  assert(before.every(row=>row.attempt.state==='pending'));
  await driver.tick();const after=t.rooms.inboxForLife({lifeId:t.B.lifeId,includeTerminal:true}).items;
  assert.deepEqual(after.map(row=>row.status),['pending','ignored','deferred']);assert(after.every(row=>row.attempt.state==='completed'));
  assert.deepEqual(after.map(row=>row.decision_token),before.map(row=>row.decision_token));
  assert.deepEqual(after.map(row=>row.reply_message_id),before.map(row=>row.reply_message_id));
  assert.equal(t.adapter.calls,1);assert.equal(driver.status().batch_wakes,1);assert.equal(t.rooms.receive(t.contexts[0]).items.length,1);
  await driver.tick();assert.deepEqual(t.rooms.inboxForLife({lifeId:t.B.lifeId,includeTerminal:true}).items,after);
  const cold=t.trackRooms(new Conversations({contexts:t.host.contexts,root:t.roomRoot,tasks:t.tasks}));
  for(const row of after){const args={lifeId:t.B.lifeId,sessionId:t.B.authoritySessionId,inbox_id:row.inbox_id,attempt_id:row.attempt.attempt_id};
    assert.equal(cold.reconcileWorkerDelivery({...args,evidence:{state:'pending'}}).attempt.state,'completed');
    assert.throws(()=>cold.reconcileWorkerDelivery({...args,attempt_id:randomUUID(),evidence:{state:'completed'}}),/DELIVERY_ATTEMPT_REPLACED/);
    assert.throws(()=>cold.reconcileWorkerDelivery({...args,sessionId:t.A.authoritySessionId,evidence:{state:'completed'}}),/SESSION_OWNER_MISMATCH|DELIVERY_ATTEMPT_REPLACED/);
  }
  assert.deepEqual(cold.inboxForLife({lifeId:t.B.lifeId,includeTerminal:true}).items,after);
}finally{await t.close();}});
test('temporary provider failure retries only after durable no-side-effect evidence and backoff',async()=>{const t=await setup();try{
  t.adapter.failOnce=true;t.post();const driver=await t.mount();await driver.tick();await t.idle();await driver.tick();
  const failed=t.rooms.receive(t.contexts[1]).items[0];assert.equal(failed.status,'pending');assert.equal(failed.attempt.state,'failed');assert.equal(failed.attempt.retryable,true);assert.equal(t.adapter.calls,1);
  await new Promise(r=>setTimeout(r,1100));const retried=await driver.tick();assert.equal(retried.state,'admitted');await t.idle();await driver.tick();assert.equal(t.adapter.calls,2);
  const item=t.rooms.receive(t.contexts[1]).items[0];assert.equal(item.status,'pending');assert.equal(item.attempt.state,'completed');assert.equal(item.previous_attempts.length,1);assert.notEqual(item.attempt.attempt_id,item.previous_attempts[0].attempt_id);
}finally{await t.close();}});
test('deferred expiry reopens once; indefinite deferral and ambiguous effects never auto-retry',async()=>{const t=await setup();try{
  let now=1000;const rooms=t.trackRooms(new Conversations({contexts:t.host.contexts,root:resolve(t.fixture.root,'TEST-ONLY-clock-rooms'),tasks:t.tasks,now:()=>now})),room=rooms.defineRoom({participants:[t.A.lifeId,t.B.lifeId]});
  for(let n=0;n<3;n++){rooms.post(t.contexts[0],{room_id:room.room_id,body:'TEST ONLY deferred '+n});const item=rooms.receive(t.contexts[1]).items.at(-1);rooms.decide(t.contexts[1],{decision_token:item.decision_token,action:'defer',until:n?new Date(2000).toISOString():null});}
  now=3000;assert.equal(rooms.refreshDeferred({lifeId:t.B.lifeId}).reopened,2);assert.equal(rooms.refreshDeferred({lifeId:t.B.lifeId}).reopened,0);assert.equal(rooms.deliveryCandidates({lifeId:t.B.lifeId}).length,2);
  const items=rooms.deliveryCandidates({lifeId:t.B.lifeId}),batch=rooms.selectWorkerBatch({lifeId:t.B.lifeId,sessionId:t.B.authoritySessionId,items:items.map(i=>({inbox_id:i.inbox_id,expectedRevision:i.revision}))});
  for(const item of items)rooms.reconcileWorkerDelivery({lifeId:t.B.lifeId,sessionId:t.B.authoritySessionId,inbox_id:item.inbox_id,attempt_id:batch.attempt.attempt_id,evidence:{state:'interrupted',effect_results:[{call_id:'TEST ONLY unknown mutation',status:'unknown',kind:'native_tool_return'}],retryable:false}});
  assert.equal(rooms.deliveryCandidates({lifeId:t.B.lifeId}).length,0);assert(rooms.receive(t.contexts[1]).items.filter(i=>i.attempt).every(i=>i.status==='pending'&&i.attempt.retryable===false));
}finally{await t.close();}});
test('native evidence distinguishes cancellation, interrupted side effects, and absent pre-model journal',()=>{
  const start={type:'turn/start',seq:1,data:{turn:1}},input={type:'user/message',seq:2,data:{source:{rpcId:'TEST RPC'}}},tool={type:'tool/call',seq:3,data:{name:'write'}},end={type:'turn/end',seq:4,data:{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}}};
  assert.equal(nativeInboxEvidence({events:[start,input,tool,end],requestId:'TEST RPC'}).state,'cancelled');
  assert.equal(nativeInboxEvidence({events:[start,input,{type:'turn/end',seq:4,data:{turn:1,reason:{kind:'completed'}}}],pending:[{id:'old',source:{rpcId:'TEST RPC'}}],requestId:'TEST RPC'}).state,'completed');
  const crash=nativeInboxEvidence({events:[start,input,tool],requestId:'TEST RPC'});assert.equal(crash.state,'interrupted');assert.equal(crash.effect_results[0].status,'unknown');assert(!Object.hasOwn(crash,'side_effects'));
  const insert={type:'agent/inbox/spliced',seq:0,data:{inserted:[{source:{rpcId:'TEST RPC'}}]}};
  assert.equal(nativeInboxEvidence({events:[insert,start],requestId:'TEST RPC'}).state,'ambiguous');assert.equal(nativeInboxEvidence({events:[insert,start],requestId:'TEST RPC',durableBeforeModel:true}).state,'absent');
  const fake=Array.from({length:120},(_,n)=>({status:'needs_review',inbox_seq:n}));fake.push({status:'queued',inbox_seq:121,received_at:new Date(0).toISOString(),message:{sender_type:'life'}});assert.equal(batchInboxSelection(fake,{now:1000}).items[0].inbox_seq,121);
});
test('real worker kills at five durable checkpoints recover without duplicate model execution or reply',async()=>{
  const launch=(fixture,mode,stage)=>{const child=fork(fileURLToPath(new URL('./inbox-recovery-crash-worker.mjs',import.meta.url)),[fixture.root,mode,stage],{windowsHide:true,silent:true});let diagnostics='';child.stderr.on('data',chunk=>{diagnostics+=chunk;});
    const message=new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('TEST ONLY crash child deadline '+diagnostics)),25000);child.once('message',value=>{clearTimeout(timer);accept(value);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{if(code){clearTimeout(timer);reject(Error('TEST ONLY child failed '+diagnostics));}});});
    const exit=new Promise(accept=>child.once('exit',accept));return {child,message,exit};};
  for(const stage of ['after-message','after-select','before-model','after-model','after-reply']){const fixture=await createFixture(['A','B']);let child;
    try{await writeFile(resolve(fixture.root,'crash-manifests.json'),JSON.stringify(fixture.manifests));let job=launch(fixture,'prepare',stage);child=job.child;assert.equal((await job.message).checkpoint,stage);child.kill('SIGKILL');await job.exit;
      job=launch(fixture,'recover',stage);child=job.child;const result=await job.message;await job.exit;assert.equal(result.recovered,true);assert.equal(result.calls,1,stage+' executes exactly one provider request across both processes');assert.equal(result.status,'pending');assert.equal(result.attempt_state,'completed');assert.equal(result.reply_count,stage==='after-reply'?1:0);
      if(stage==='before-model')assert.deepEqual(result.before_retry,{status:'pending',attempt_state:'interrupted',retryable:true,no_effect_dispatch_proven:true,calls:0},'checkpointed closed turn proves no effect dispatched and allows bounded automatic retry');
    }finally{if(child&&child.exitCode===null&&!child.killed){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}await fixture.cleanup();}}
});
test('lost batch ACK preserves the same durable native input and resumes it once without creating a new attempt',async()=>{const t=await setup();try{
  t.post();const ack=t.bridge.acknowledgeBatch;t.bridge.acknowledgeBatch=()=>{throw Object.assign(Error('TEST ONLY batch ACK failure'),{code:'TEST_ACK_FAILURE'});};
  const driver=await t.mount(),lost=await driver.tick();assert.equal(lost.state,'pending');await t.idle();assert.equal(t.adapter.calls,0);assert.equal(t.agents[1].inbox.hasPending,true);
  const row=t.rooms.receive(t.contexts[1]).items[0],messageId=t.agents[1].inbox.nextTurn[0].id;
  assert.equal(row.status,'pending');t.bridge.acknowledgeBatch=ack;
  const resumed=await driver.tick();assert.equal(resumed.state,'admitted');assert.equal(resumed.attempt_id,lost.attempt_id);await t.idle();assert.equal(t.adapter.calls,1);
  await driver.tick();assert.equal(t.rooms.receive(t.contexts[1]).items[0].attempt.attempt_id,lost.attempt_id);
  assert.equal([...t.agents[1].session.ownEvents()].filter(event=>event.type==='user/message'&&event.data.id===messageId).length,1);
}finally{await t.close();}});
test('deterministic pre-provider rejection is failed once and never enters an absent-envelope wake loop',async()=>{const t=await setup();try{
  t.adapter.failPreparation=true;t.post();const driver=await t.mount();assert.equal((await driver.tick()).state,'admitted');await t.idle();await driver.tick();
  const item=t.rooms.receive(t.contexts[1]).items[0];assert.equal(item.status,'pending');assert.equal(item.attempt.state,'failed');assert.equal(item.attempt.retryable,false);assert.equal(item.attempt.error_code,'UNSUPPORTED_REASONING_EFFORT');assert.equal(item.attempt.native_evidence.pre_input,true);
  assert.equal(driver.status().batch_wakes,1);assert.equal(driver.status().model_requests,0);assert.equal(t.adapter.calls,0);
  for(let n=0;n<10;n++){await driver.tick();await t.idle();}assert.equal(driver.status().batch_wakes,1);assert.equal(t.adapter.calls,0);
  assert.equal(t.rooms.receive(t.contexts[1]).items[0].revision,item.revision,'identical non-retryable failure observation is a zero-write operation');
  assert.equal([...t.agents[1].session.ownEvents()].filter(event=>event.type==='turn/start').length,1);
}finally{await t.close();}});
test('retryable pre-provider rejection still stops after three retries, even across repeated idle polls',async()=>{const t=await setup();try{
  // A Host test clock makes every recorded backoff already elapsed. Native
  // model preparation, inbox claims, and failure journals remain real.
  let testNow=Date.now()-120000;t.rooms.now=()=>testNow;t.adapter.failPreparation=true;t.adapter.failPreparationCode='TRANSPORT';t.post();const driver=await t.mount();
  for(let n=0;n<10;n++){testNow+=10000;await driver.tick();await t.idle();}
  const item=t.rooms.receive(t.contexts[1]).items[0];assert.equal(item.status,'pending');assert.equal(item.attempt.state,'failed');assert.equal(item.attempt.retryable,false);assert.equal(item.attempt.retry_count,4);assert.equal(item.attempt.error_code,'TRANSPORT');
  assert.equal(driver.status().batch_wakes,4);assert.equal(driver.status().model_requests,0);assert.equal(t.adapter.calls,0);
  for(let n=0;n<5;n++)await driver.tick();assert.equal(driver.status().batch_wakes,4);
}finally{await t.close();}});
test('authority and independent activity controllers consume only their trusted Room Session bindings',async()=>{const t=await setup();let activityDriver;try{
  const sessionId=randomUUID(),activity=await t.host.runtime.create({lifeId:t.B.lifeId,sessionId,role:'activity'});
  t.gateway.registerSession(t.handle,{header:activity.session.header,presetId:t.B.deployment.presetId,role:'activity'});
  const testRoom=t.rooms.defineRoom({participants:[t.A.lifeId,t.B.lifeId]});t.rooms.bindReceiver({lifeId:t.B.lifeId,room_id:testRoom.room_id,sessionId});
  const testMessage=t.rooms.post(t.contexts[0],{room_id:testRoom.room_id,body:'TEST ONLY independently bound developer activity'}),mainMessage=t.post('TEST ONLY ordinary authority Room');
  let all=t.rooms.receive(t.contexts[1]).items;assert.equal(all.length,2);const testItem=all.find(item=>item.message_id===testMessage.message_id),mainItem=all.find(item=>item.message_id===mainMessage.message_id);
  assert.equal(testItem.execution_session_id,sessionId);assert.equal(mainItem.execution_session_id,t.B.authoritySessionId);
  assert.throws(()=>t.gateway.selectBatch(t.handle,{sessionId:t.B.authoritySessionId,items:[{inbox_id:testItem.inbox_id,expectedRevision:testItem.revision}]}),/DELIVERY_SESSION_BINDING_CHANGED/);
  assert.throws(()=>t.gateway.selectBatch(t.handle,{sessionId,items:[{inbox_id:mainItem.inbox_id,expectedRevision:mainItem.revision}]}),/DELIVERY_SESSION_BINDING_CHANGED/);
  const mainDriver=await t.mount();assert.equal((await mainDriver.tick()).count,1);await t.idle();assert.equal(t.adapter.calls,1);
  assert.equal(t.rooms.receive(t.contexts[1]).items.find(item=>item.message_id===testMessage.message_id).status,'pending');
  const bridge={status:()=>({ready:true,life_id:t.B.lifeId,registered_session_id:sessionId}),inspect:args=>({inbox:t.gateway.inbox(t.handle,args)}),
    ...Object.fromEntries(['selectDelivery','authorizeDelivery','acknowledgeDelivery','failDelivery','selectBatch','authorizeBatch','acknowledgeBatch','reconcileDelivery'].map(name=>[name,args=>t.gateway[name](t.handle,{sessionId,...args})]))};
  activityDriver=await mountRoomInbox({ctx:t.host.ctx,bridge,lifeId:t.B.lifeId,authoritySessionId:sessionId,root:resolve(t.fixture.root,'TEST-ONLY-activity-policy'),initialPolicy:{peer_idle:true,human_idle:true},intervalMs:60000,debounceMs:0});
  assert.equal((await activityDriver.tick()).count,1);await activity.whenIdle();await t.host.ctx.sessions.flush(activity.session);assert.equal(t.adapter.calls,2);
  const inputs=agent=>[...agent.session.ownEvents()].filter(event=>event.type==='user/message'&&event.data.source.kind==='room-inbox-batch').flatMap(event=>JSON.parse(event.data.content[0].text).items.map(item=>item.event_id));
  assert.deepEqual(inputs(t.agents[1]),[communicationEventId(t.room.room_id,mainMessage.message_id)]);assert.deepEqual(inputs(activity),[communicationEventId(testRoom.room_id,testMessage.message_id)]);
  all=t.rooms.receive(t.contexts[1]).items;assert.equal(all.length,2,'self Inbox remains owner-wide, including independent activity items');
}finally{activityDriver?.dispose();await activityDriver?.drain();await t.close();}});

function nativeSample() {
  const requestId='TEST ONLY evidence RPC',turn=1,step=0,callId='TEST ONLY effect call';
  const start={type:'turn/start',seq:0,time:1,data:{turn}},input={type:'user/message',seq:1,time:1,data:{id:'TEST ONLY input',source:{rpcId:requestId}}};
  const assistant={type:'assistant/message',seq:2,time:1,data:{turn,step,message:{role:'assistant',content:[{type:'tool-call',id:callId,name:'write',arguments:'{}'}]}}};
  const call={type:'tool/call',seq:3,time:1,data:{turn,step,callId,name:'write'}};
  const result=(code,seq=4)=>({type:'tool/result',seq,time:1,surfaceOp:'append',sourceEventSeqs:[call.seq],data:{turn,step,
    message:{role:'tool',toolCallId:callId,source:{kind:'tool',callId},isError:!!code,content:[{type:'text',text:code??'TEST ONLY durable success'}]},
    ...(code?{error:{name:'TEST ONLY tool error',code}}:{})}});
  const end=(kind='error',seq=5)=>({type:'turn/end',seq,time:1,data:{turn,reason:kind==='error'?{kind,error:{code:'TRANSPORT',retryable:true}}:{kind}}});
  return {requestId,start,input,assistant,call,result,end};
}

test('native effect evidence preserves successful results across turn failure and rejects unmatched result identities',()=>{
  const s=nativeSample(),base=[s.start,s.input,s.assistant,s.call];
  const success=nativeInboxEvidence({events:[...base,s.result(),s.end()],requestId:s.requestId});
  assert.equal(success.state,'failed');assert.equal(success.effect_results[0].status,'confirmed_success');assert.equal(success.retryable,false);
  assert(!Object.hasOwn(success,'side_effects'));assert.equal(success.effect_results[0].call_seq,s.call.seq);
  const wrong=s.result();wrong.sourceEventSeqs=[2];
  const rejected=nativeInboxEvidence({events:[...base,wrong,s.end()],requestId:s.requestId});
  assert.equal(rejected.effect_results[0].status,'unknown');assert.equal(rejected.effect_results[0].result_seq,null);
  const unlinked=s.result();delete unlinked.sourceEventSeqs;
  assert.equal(nativeToolResultForCall({events:[...base,unlinked,s.end()],callId:s.call.data.callId}).status,'unknown');
  for(const code of ['EPERM','TRANSPORT','ABORTED','INVALID_TOOL_OUTPUT','TOOL_OUTCOME_UNKNOWN'])
    assert.equal(nativeInboxEvidence({events:[...base,s.result(code),s.end()],requestId:s.requestId}).effect_results[0].status,'unknown',code);
  for(const code of ['INVALID_ARGS','ABORTED_BEFORE_DISPATCH','UNKNOWN_TOOL','ROOM_ACTION_NOT_COMMITTED'])
    assert.equal(nativeInboxEvidence({events:[...base,s.result(code),s.end()],requestId:s.requestId}).effect_results[0].status,'confirmed_failure',code);
  const unknown=s.result();unknown.data.message.content=[{type:'text',text:JSON.stringify({effect_result:{status:'unknown'}})}];
  const explicit=nativeInboxEvidence({events:[...base,unknown,s.end()],requestId:s.requestId}).effect_results[0];
  assert.equal(explicit.status,'unknown');assert.equal(explicit.kind,'effect_result');
  assert.equal(success.effect_results[0].kind,'native_tool_return');
  const readSample=nativeSample();readSample.call.data.name='life_action_result';readSample.assistant.data.message.content[0].name='life_action_result';
  assert.equal(nativeInboxEvidence({events:[readSample.start,readSample.input,readSample.assistant,readSample.call,readSample.result('EPERM'),readSample.end()],requestId:readSample.requestId}).effect_results[0].status,'confirmed_failure');
});

test('native effect evidence uses official interrupted recovery results for started and never-started calls',()=>{
  const s=nativeSample(),unstarted={type:'tool-call',id:'TEST ONLY not started',name:'write',arguments:'{}'};
  s.assistant.data.message.content.push(unstarted);
  const prefix=[s.start,s.input,s.assistant,s.call],closers=interruptedTurnClosers(prefix);
  const evidence=nativeInboxEvidence({events:[...prefix,...closers],requestId:s.requestId});
  assert.equal(evidence.state,'interrupted');assert.equal(evidence.retryable,false);
  assert.deepEqual(evidence.effect_results.map(result=>[result.call_id,result.status,result.error_code]),[
    [s.call.data.callId,'unknown','TOOL_OUTCOME_UNKNOWN'],[unstarted.id,'confirmed_failure','TOOL_NOT_STARTED']]);
  assert.equal(nativeToolResultForCall({events:[...prefix,...closers],callId:unstarted.id}).status,'confirmed_failure');
});

test('native effect receipt lookup returns metadata only and never calls journal absence a failure',()=>{
  const s=nativeSample(),prefix=[s.start,s.input,s.assistant,s.call],callId=s.call.data.callId;
  assert.deepEqual(nativeToolResultForCall({events:prefix,callId:'TEST ONLY absent'}),
    {status:'unknown',kind:'native_tool_return',reason:'NATIVE_CALL_NOT_FOUND'});
  assert.equal(nativeToolResultForCall({events:prefix,callId}).status,'unknown');
  const success=nativeToolResultForCall({events:[...prefix,s.result(),s.end()],callId});
  assert.equal(success.status,'confirmed_success');assert.equal(success.result_seq,4);
  assert(!Object.hasOwn(success,'arguments'));assert(!Object.hasOwn(success,'body'));assert(!Object.hasOwn(success,'content'));
  assert.equal(nativeToolResultForCall({events:[...prefix,{...s.call,seq:9}],callId}).reason,'NATIVE_CALL_ID_AMBIGUOUS');
  const duplicated=nativeInboxEvidence({events:[...prefix,{...s.call,seq:4},s.result(undefined,5),s.end('error',6)],requestId:s.requestId});
  assert.equal(duplicated.effect_results[0].status,'unknown');assert.equal(duplicated.effect_results[0].reason,'NATIVE_CALL_ID_AMBIGUOUS');
});

test('native effect evidence scans claimed-before-input turn tools and does not trust a stale no-dispatch assertion',()=>{
  const s=nativeSample(),envelope={id:'TEST ONLY envelope',source:{rpcId:s.requestId}};
  const events=[{type:'agent/inbox/spliced',seq:0,data:{target:'next-step',start:0,inserted:[envelope]}},
    {...s.start,seq:1},{type:'agent/inbox/spliced',seq:2,data:{target:'next-step',start:0,removedCount:1,inserted:[]}},
    {...s.call,seq:3},s.result(),s.end()];
  const evidence=nativeInboxEvidence({events,requestId:s.requestId,dispatchState:'not-dispatched',durableBeforeModel:true});
  assert.equal(evidence.pre_input,true);assert.equal(evidence.tool_start_count,1);assert.equal(evidence.retryable,false);
  assert.equal(evidence.effect_results[0].status,'confirmed_success');
  const noTools=nativeInboxEvidence({events:events.filter(event=>!['tool/call','tool/result'].includes(event.type)),requestId:s.requestId});
  assert.equal(noTools.retryable,true);assert.equal(noTools.no_effect_dispatch_proven,true);
});

test('native effect evidence retains execution completion when an invalid machine ACK follows a successful tool',()=>{
  const s=nativeSample();s.call.data.name='life_turn_ack';s.assistant.data.message.content[0].name='life_turn_ack';
  const evidence=nativeInboxEvidence({events:[s.start,s.input,s.assistant,s.call,s.result(),s.end('completed')],requestId:s.requestId});
  assert.equal(evidence.state,'completed');assert.equal(evidence.ack_error_code,'ACTION_RESULT_ACK_INVALID');
  assert.equal(evidence.effect_results[0].status,'confirmed_success');assert.equal(evidence.retryable,false);
});

test('native machine ACK retains explicitly authored completion IDs without inferring completion from an empty list',()=>{
  for(const completed_event_ids of [[],['TEST ONLY completed event']]) {
    const s=nativeSample(),ack={status:'ok',disposition:'silent',actions:[],completed_event_ids};
    s.call.data.name='life_turn_ack';s.call.data.arguments=JSON.stringify(ack);
    s.assistant.data.message.content[0].name='life_turn_ack';s.assistant.data.message.content[0].arguments=s.call.data.arguments;
    const result=s.result();result.data.message.content=[{type:'text',text:JSON.stringify({acknowledged:true,result:ack})}];
    const evidence=nativeInboxEvidence({events:[s.start,s.input,s.assistant,s.call,result,s.end('completed')],requestId:s.requestId});
    assert.equal(evidence.state,'completed');assert.equal(evidence.machine_ack,true);
    assert.deepEqual(evidence.action_result.completed_event_ids,completed_event_ids);assert.equal(evidence.effect_results[0].status,'confirmed_success');
  }
});

test('closed interrupted recovery retries only checkpointed pre-effect turns without committed assistant work',()=>{
  const s=nativeSample(),closed=[s.start,s.input,s.end('interrupted')];
  const safe=nativeInboxEvidence({events:closed,requestId:s.requestId,durableBeforeModel:true});
  assert.equal(safe.state,'interrupted');assert.equal(safe.retryable,true);assert.equal(safe.no_effect_dispatch_proven,true);
  assert.equal(safe.error_code,'NATIVE_TURN_INTERRUPTED_BEFORE_EFFECT');assert(!Object.hasOwn(safe,'provider_not_dispatched'));
  for(const [events,durableBeforeModel] of [[closed,false],[[s.start,s.input],true],[[s.start,s.input,s.assistant,s.end('interrupted')],true],[[s.start,s.input,s.call,s.end('interrupted')],true]])
    assert.equal(nativeInboxEvidence({events,requestId:s.requestId,durableBeforeModel}).retryable,false);
  const envelope={id:'TEST ONLY pre-input recovery',source:{rpcId:s.requestId}},claim=[
    {type:'agent/inbox/spliced',seq:0,data:{target:'next-step',start:0,inserted:[envelope]}},{...s.start,seq:1},
    {type:'agent/inbox/spliced',seq:2,data:{target:'next-step',start:0,removedCount:1,inserted:[]}},s.end('interrupted')];
  const preInput=nativeInboxEvidence({events:claim,requestId:s.requestId,durableBeforeModel:true});
  assert.equal(preInput.pre_input,true);assert.equal(preInput.state,'interrupted');assert.equal(preInput.retryable,true);
});

test('semantic pending selection starts only new or proven safe retry attempts and leaves native continuations intact',()=>{
  const row=(seq,attempt,extra={})=>({status:'pending',inbox_seq:seq,received_at:new Date(0).toISOString(),message:{sender_type:'life'},attempt,...extra});
  const candidates=[row(1,null),row(2,{state:'pending'}),row(3,{state:'absent'}),row(4,{state:'running'}),row(5,{state:'completed'}),
    row(6,{state:'failed',retryable:false}),row(7,{state:'failed',retryable:true},{retry_after:new Date(500).toISOString()}),
    row(8,{state:'failed',retryable:true},{retry_after:new Date(2000).toISOString()}),row(9,{state:'completed'},{requested:true}),
    {...row(10,null),status:'handled',requested:true},row(11,null,{message:{sender_type:'human'}}),
    row(12,null,{migration:{from_status:'replied'}}),row(13,null,{migration:{from_status:'handled'}}),row(14,{state:'pending'},{requested:true}),
    ...['needs_review','admitted','processing','failed'].map((from_status,index)=>row(15+index,null,{migration:{from_status}})),
    row(19,null,{migration:{from_status:'queued'}}),row(20,null,{migration:{from_status:'pending'}}),row(21,null,{migration:{from_status:'needs_review'},requested:true}),
    row(22,{state:'interrupted',retryable:true,retry_after:new Date(500).toISOString()}),
    row(23,null,{native_ingress:{session_id:'TEST ONLY session',request_id:'TEST ONLY human request'}}),row(24,null,{native_ingress:{session_id:'TEST ONLY session',request_id:'TEST ONLY human request'},requested:true}),
    row(25,{state:'interrupted',retryable:true,retry_after:new Date(500).toISOString()},{native_ingress:{session_id:'TEST ONLY session',request_id:'TEST ONLY human request'}}),
    row(26,{state:'failed'},{retryable:true}),{...row(27,{state:'failed'}),status:'failed',retryable:true}];
  assert.deepEqual(batchInboxSelection(candidates,{now:1000}).items.map(item=>item.inbox_seq),[1,7,9,19,20,21,22,24,25]);
  assert.deepEqual(batchInboxSelection(candidates,{now:1000,peer_idle:false}).items.map(item=>item.inbox_seq),[9,21,24]);
  assert.equal(batchInboxSelection(candidates,{now:1000,rest:true}).reason,'rest');
});

test('native effect evidence follows actual Harness tool dispatch and durable JSONL results without paid calls',{timeout:20000},async()=>{
  const t=await setup(),requestId=randomUUID(),successfulFile=resolve(t.fixture.root,'TEST-ONLY-effect-success.txt'),unknownFile=resolve(t.fixture.root,'TEST-ONLY-effect-before-EPERM.txt'),disposers=[];
  let checkpointProofs=0;
  try {
    const register=(name,path,throws)=>disposers.push(t.host.ctx.tools.register(defineTool({name,description:'TEST ONLY native effect evidence',parameters:{},
      output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      async execute(_args,exec){
        const reader=await t.host.ctx.sessionPersistence.open(t.B.authoritySessionId,'read');
        try {
          const persisted=(await reader.read()).events;
          assert(persisted.some(event=>event.type==='tool/call'&&event.data.callId===exec.callId),
            'official checkpoint must persist the call start before invoking its side-effecting body');
          checkpointProofs++;
        }finally{await reader.close();}
        await writeFile(path,'TEST ONLY committed effect');if(throws)throw Object.assign(Error('TEST ONLY EPERM after write'),{code:'EPERM'});return {written:true};}})));
    register('test_effect_success',successfulFile,false);register('test_effect_eperm',unknownFile,true);
    t.adapter.toolBlocks=['test_effect_success','test_effect_eperm','test_effect_unknown_tool'].map(name=>({type:'tool-call',id:randomUUID(),name,arguments:'{}'}));
    t.adapter.failAfterTools=true;
    await t.host.runtime.prompt({lifeId:t.B.lifeId,sessionId:t.B.authoritySessionId,requestId,content:[{type:'text',text:'TEST ONLY native effect evidence execution'}]});
    await t.idle();
    const agent=t.agents[1],events=[...agent.session.ownEvents()],evidence=nativeInboxEvidence({events,requestId});
    assert.equal(evidence.state,'failed');assert.equal(evidence.retryable,false);assert.equal(evidence.tool_start_count,3);
    assert.equal(checkpointProofs,2);
    assert.deepEqual(evidence.effect_results.map(result=>[result.tool_name,result.status]),[
      ['test_effect_success','confirmed_success'],['test_effect_eperm','unknown'],['test_effect_unknown_tool','confirmed_failure']]);
    const reader=await t.host.ctx.sessionPersistence.open(t.B.authoritySessionId,'read');
    try {
      const persisted=(await reader.read()).events,replayed=nativeInboxEvidence({events:persisted,requestId});
      assert.deepEqual(replayed.effect_results,evidence.effect_results);assert.equal(replayed.state,'failed');
    }finally{await reader.close();}
    const {readFile}=await import('node:fs/promises');
    assert.equal(await readFile(successfulFile,'utf8'),'TEST ONLY committed effect');
    assert.equal(await readFile(unknownFile,'utf8'),'TEST ONLY committed effect','EPERM is not evidence that the earlier write did not happen');
  }finally{for(const dispose of disposers.reverse())await dispose();await t.close();}
});
