import {test} from 'node:test';

test('zero cursor starts from the bounded recent tail instead of replaying the old archive',async()=>{
 const t=await setup();try{
  for(let n=1;n<=160;n++)t.call(1,'emit',{event:{source_key:'TEST-bounded-first-'+n,event_type:'tool_action',body:'TEST ONLY archived own fact '+n}});
  const result=t.call(1,'prepare',{wake_id:t.authority(1)+':bounded-first',cutoff_at_utc:t.utc(),trigger_messages:[],after:0});
  assert.equal(result.events.length,150);assert.equal(result.events[0].body,'TEST ONLY archived own fact 11');
  assert.equal(result.events.at(-1).body,'TEST ONLY archived own fact 160');assert.equal(result.batch.events.length,0);
  assert.equal(t.rooms.recentEvents.store.lastSequence,160);
 }finally{await t.close();}
});

test('legacy lost Room receipt is read back on a new wake without repeating its outward action',async()=>{
 const t=await setup();try{
  const target=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]});
  const a=t.prepare(1,1,[{id:'TEST-crash-stimulus',source:{kind:'scheduler',rpcId:'TEST-crash-once'},content:[{type:'text',text:'TEST ONLY native stimulus'}]}]);
  const old={status:'ok',disposition:'acted',records:[{key:'TEST-recovery-fact',kind:'finding',summary:'TEST ONLY stable fact'}],actions:[{type:'send_message',conversation_id:target.room_id,body:'TEST ONLY exactly one message'}]};
  t.legacy(1,a.batch,old,[0]);t.call(1,'fail',{batch_id:a.batch.batch_id,turn_status:'interrupted',error_code:'TEST_LOST_ACK'});t.cold();t.advance(1000);
  const b=t.prepare(1,2,[]);assert(b.batch.event_ids.includes(a.batch.event_ids[0]));assert.notEqual(b.batch.batch_id,a.batch.batch_id);
  assert.equal(b.context_state.outward_recovery[0].effects[0].status,'confirmed_success');
  const post=t.rooms.postForLife;t.rooms.postForLife=()=>{throw Error('TEST_FORBIDDEN_LEGACY_REPLAY');};
  const receipt=t.call(1,'complete',{batch_id:a.batch.batch_id,result:old});assert.equal(receipt.effect_results[0].status,'confirmed_success');
  const result={...completed(b.batch),records:old.records};t.call(1,'ack',{batch_id:b.batch.batch_id,result});t.call(1,'complete',{batch_id:b.batch.batch_id,result});t.rooms.postForLife=post;
  const messages=t.gateway.read(t.handles[1],{room_id:target.room_id}).messages;assert.equal(messages.length,1);assert.equal(messages[0].message_id,'batch-action:'+a.batch.batch_id+':0');
  assert.equal(t.inspect(1).events.filter(e=>e.event_type==='self_record'&&e.payload.record.key==='TEST-recovery-fact').length,1);
  assert.equal(t.inspect(1).state.batch_status[a.batch.batch_id].turn_status,'interrupted');assert.equal(t.inspect(1).state.batch_status[b.batch.batch_id].turn_status,'ok');
 }finally{await t.close();}
});

test('legacy outward evidence leaves next-wake choices free while new ACK sends are rejected before records',async()=>{
 const t=await setup();try{
  const target=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),trigger={id:'TEST-conflict-stimulus',source:{kind:'scheduler',rpcId:'TEST-conflict-once'},content:[{type:'text',text:'TEST ONLY unresolved intent'}]};
  const a=t.prepare(1,1,[trigger]),old={status:'ok',disposition:'acted',records:[],actions:[{type:'send_message',conversation_id:target.room_id,body:'TEST ONLY original committed send'}]};
  t.legacy(1,a.batch,old,[0]);t.call(1,'fail',{batch_id:a.batch.batch_id,turn_status:'failed'});t.advance(1000);
  const b=t.prepare(1,2,[]);assert.equal(b.context_state.outward_recovery[0].effects[0].status,'confirmed_success');
  const changed={...old,records:[{key:'TEST-not-saved-on-conflict',kind:'issue',summary:'TEST ONLY must not save'}],actions:[{...old.actions[0],body:'TEST ONLY changed send'}]};
  assert.throws(()=>t.call(1,'ack',{batch_id:b.batch.batch_id,result:changed}),/SEND_MESSAGE_USE_NATIVE_TOOL/);assert(!t.inspect(1).events.some(e=>e.payload?.record?.key==='TEST-not-saved-on-conflict'));
  const settled={...completed(b.batch),records:[{key:'TEST-deliberate-no-resend',kind:'decision',summary:'TEST ONLY observed success and complete stimulus'}]};t.call(1,'ack',{batch_id:b.batch.batch_id,result:settled});t.call(1,'complete',{batch_id:b.batch.batch_id,result:settled});
  t.advance(1000);const c=t.prepare(1,3,[{...trigger,id:'TEST-independent',source:{kind:'scheduler',rpcId:'TEST-independent'}}]);assert.deepEqual(c.context_state.outward_recovery,[]);
  t.post(1,target,'TEST ONLY deliberate independent tool send',{message_id:'TEST-native-independent'});t.call(1,'complete',{batch_id:c.batch.batch_id,result:completed(c.batch)});
  assert.equal(t.gateway.read(t.handles[1],{room_id:target.room_id}).messages.length,2);assert.equal(t.inspect(1).state.batch_status[a.batch.batch_id].turn_status,'failed');assert.deepEqual(t.prepare(2,1).context_state.outward_recovery,[]);
 }finally{await t.close();}
});

test('partial legacy sends remain success and unknown through repeated interrupted wakes without replay',async()=>{
 const t=await setup();try{
  const target=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),a=t.prepare(1,1,[{id:'TEST-partial-stimulus',source:{kind:'scheduler',rpcId:'TEST-partial-once'},content:[{type:'text',text:'TEST ONLY partial actions'}]}]);
  const old={status:'ok',disposition:'acted',records:[],actions:[{type:'send_message',conversation_id:target.room_id,body:'TEST ONLY first'},{type:'send_message',conversation_id:target.room_id,body:'TEST ONLY second unknown'}]};
  t.legacy(1,a.batch,old,[0]);t.call(1,'fail',{batch_id:a.batch.batch_id,turn_status:'interrupted'});t.cold();t.advance(1000);
  const b=t.prepare(1,2,[{id:'TEST-late-input',source:{kind:'scheduler',rpcId:'TEST-late-input'},content:[{type:'text',text:'TEST ONLY later input'}]}]);assert.equal(b.batch.event_ids.length,2);
  assert.deepEqual(b.context_state.outward_recovery[0].effects.map(effect=>effect.status),['confirmed_success','unknown']);t.call(1,'fail',{batch_id:b.batch.batch_id,turn_status:'interrupted'});t.cold();t.advance(1000);
  const c=t.prepare(1,3,[]);assert.deepEqual(c.context_state.outward_recovery[0].effects.map(effect=>effect.status),['confirmed_success','unknown']);
  const post=t.rooms.postForLife;t.rooms.postForLife=()=>{throw Error('TEST_FORBIDDEN_PARTIAL_REPLAY');};t.call(1,'complete',{batch_id:a.batch.batch_id,result:old});t.call(1,'complete',{batch_id:c.batch.batch_id,result:completed(c.batch)});t.rooms.postForLife=post;
  const messages=t.gateway.read(t.handles[1],{room_id:target.room_id}).messages;assert.equal(messages.length,1);assert.equal(messages[0].message_id,'batch-action:'+a.batch.batch_id+':0');assert.equal(t.inspect(1).state.batch_status[a.batch.batch_id].turn_status,'interrupted');
 }finally{await t.close();}
});

test('legacy outward recovery redacts revoked source content and does not constrain a new choice',async()=>{
 const t=await setup();try{
  const source=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),target=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),m=t.post(0,source,'TEST ONLY private recovery source');
  const a=t.prepare(1,1,[t.admit(1,[m.message_id]),{id:'TEST-visible-trigger',source:{kind:'scheduler',rpcId:'TEST-visible-trigger'},content:[{type:'text',text:'TEST ONLY still pending'}]}]);
  const old={status:'ok',disposition:'acted',records:[],actions:[{type:'send_message',conversation_id:target.room_id,body:'TEST ONLY PRIVATE RECOVERY INTENT'}]};t.legacy(1,a.batch,old,[0]);t.call(1,'fail',{batch_id:a.batch.batch_id,turn_status:'interrupted'});
  t.rooms.setMembership({room_id:source.room_id,principalId:t.life(1),present:false,expectedRevision:1});t.advance(1000);const b=t.prepare(1,2,[]);
  assert.deepEqual(b.context_state.outward_recovery,[{batch_id:a.batch.batch_id,scope_revoked:true}]);assert(!JSON.stringify(b.context_state).includes('PRIVATE RECOVERY INTENT'));
  t.call(1,'ack',{batch_id:b.batch.batch_id,result:completed(b.batch)});assert.deepEqual(t.prepare(2,1).context_state.outward_recovery,[]);
 }finally{await t.close();}
});

test('silent self-records are owner-bound and idempotent across retry and cold completion',async()=>{
 const t=await setup();try{
  const snapshot=t.prepare(1,1),result={...silent,records:[{key:'TEST-fact-1',kind:'finding',summary:'TEST ONLY selected fact',importance:'persistent'}]};
  t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result});t.advance(1000);t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result});t.cold();t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result});
  const records=t.inspect(1).events.filter(event=>event.event_type==='self_record');assert.equal(records.length,1);assert.equal(records[0].from_actor_id,t.life(1));assert.equal(records[0].originSessionId,t.authority(1));assert.deepEqual(records[0].visibility.members,[t.life(1)]);assert.equal(records[0].occurred_at_utc,null);
  assert(!t.inspect(0).events.some(event=>event.event_id===records[0].event_id));
  const next=t.prepare(1,2);t.call(1,'ack',{batch_id:next.batch.batch_id,result});assert.equal(t.inspect(1).events.filter(event=>event.event_type==='self_record').length,1);
  const bad=t.prepare(1,3);assert.throws(()=>t.call(1,'ack',{batch_id:bad.batch.batch_id,result:{...result,records:[{...result.records[0],summary:'TEST ONLY changed under same key'}]}}),/TURN_RECORD_IDEMPOTENCE_CONFLICT/);
 }finally{await t.close();}
});

test('cold legacy completion reads one saved outward message and retains already-durable records',async()=>{
 const t=await setup();try{
  const room=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),snapshot=t.prepare(1,1),old={status:'ok',disposition:'acted',records:[{key:'TEST-change-1',kind:'change',summary:'TEST ONLY already completed change'}],actions:[{type:'send_message',conversation_id:room.room_id,body:'TEST ONLY one outward message'}]};
  t.legacy(1,snapshot.batch,old,[0]);assert.equal(t.inspect(1).events.filter(event=>event.event_type==='self_record').length,1);t.cold();
  const post=t.rooms.postForLife;t.rooms.postForLife=()=>{throw Error('TEST_FORBIDDEN_REPLAY');};const first=t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result:old}),second=t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result:old});t.rooms.postForLife=post;
  assert.deepEqual(first.effect_results,second.effect_results);assert.equal(first.effect_results[0].status,'confirmed_success');assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1);assert.equal(t.inspect(1).events.filter(event=>event.event_type==='self_record').length,1);
 }finally{await t.close();}
});

test('record evidence cannot cross life or activity scopes, even before outward actions',async()=>{
 const t=await setup();try{
  const other=t.call(0,'emit',{event:{source_key:'TEST-private',event_type:'system',body:'TEST ONLY foreign private evidence'}});
  const snapshot=t.prepare(1,1);assert.throws(()=>t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result:{...silent,records:[{key:'TEST-fact',kind:'finding',summary:'TEST ONLY inaccessible evidence',evidence_event_ids:[other.event_id]}]}}),/TURN_RECORD_EVIDENCE_NOT_VISIBLE/);
  assert.equal(t.rooms.recentEvents.state.drafts[snapshot.batch.batch_id],undefined,'invalid record never freezes a draft');
  assert.deepEqual(snapshot.context_state.active_tasks.map(task=>task.execution_session_id),[t.authority(1)]);
  assert.throws(()=>t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result:{...silent,records:[{key:'TEST-task',kind:'finding',summary:'TEST ONLY wrong task',related_task:t.tasks.forSession(t.authority(0)).task_id}]}}),/TURN_RECORD_TASK_NOT_VISIBLE/);
  assert.equal(t.inspect(1).events.filter(event=>event.event_type==='self_record').length,0);
 }finally{await t.close();}
});
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {LifeContexts} from '../context.mjs';
import {TaskStore} from '../platform/tasks.mjs';
import {Conversations} from '../platform/conversations.mjs';
import {WorkerGateway} from '../platform/worker-gateway.mjs';
import {roomEventId} from './world.mjs';
import {renderEventBlock} from './render.mjs';
import {parseActionResult} from './action-result.mjs';

const silent={status:'ok',disposition:'silent',actions:[],completed_event_ids:[]};
const completed=batch=>({...silent,completed_event_ids:[...batch.event_ids]});

test('a completed native execution without an ACK preserves Room and native inputs as unresolved',async()=>{
 const t=await setup();try{
  const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY native completion is not semantic completion');
  const snapshot=t.prepare(1,1,[t.admit(1,[message.message_id]),{id:'TEST-no-ACK-native-input',source:{kind:'schedule',rpcId:'TEST-no-ACK-native-input'},content:[{type:'text',text:'TEST ONLY still undecided native stimulus'}]}]);
  assert.equal(snapshot.batch.event_ids.length,2);const item=t.item(1,message.message_id);
  const receipt=t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1});
  assert.deepEqual(receipt,{execution_finished:true,delivery_batch_id:snapshot.batch.batch_id,turn_status:'ok',semantic_ack_received:false,unresolved_event_ids:snapshot.batch.event_ids});
  const state=t.inspect(1).state,status=state.batch_status[snapshot.batch.batch_id];assert.equal(status.result,null);assert.equal(status.disposition,null);assert.equal(status.acknowledged,undefined);assert.equal(status.finished_at_utc,t.utc());
  assert.equal(t.item(1,message.message_id).status,'pending');assert.equal(t.item(1,message.message_id).revision,item.revision);assert.equal(t.rooms.recentEvents.state.drafts[snapshot.batch.batch_id],undefined);
  for(const id of snapshot.batch.event_ids){assert.equal(state.handled[id],undefined);assert.equal(state.deferred[id],undefined);assert(t.rooms.recentEvents.store.pending(t.life(1)).some(event=>event.event_id===id));}
  assert.equal(t.inspect(1).events.filter(event=>event.event_type==='self_record').length,0);assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1);
  t.advance(5000);t.cold();assert.deepEqual(t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1}),receipt);assert.deepEqual(t.inspect(1).state.batch_status[snapshot.batch.batch_id],status);
 }finally{await t.close();}
});

test('execution-only finish preserves direct complete, continue and defer without manufacturing an ACK',async()=>{
 for(const action of ['complete','continue','defer']){
  const t=await setup();try{
   const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY direct semantic '+action),snapshot=t.prepare(1,1,[t.admit(1,[message.message_id])]),item=t.item(1,message.message_id);
   const until=new Date(t.now+20000).toISOString();t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:item.inbox_id,expectedRevision:item.revision,action,...action==='defer'?{until}:{}}});
   const decided=t.item(1,message.message_id),receipt=t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1});
   assert.equal(receipt.semantic_ack_received,false);assert.deepEqual(receipt.unresolved_event_ids,action==='complete'?[]:snapshot.batch.event_ids);assert.equal(t.item(1,message.message_id).revision,decided.revision);assert.equal(t.item(1,message.message_id).status,decided.status);
   const state=t.inspect(1).state;assert.equal(state.batch_status[snapshot.batch.batch_id].turn_status,'ok');assert.equal(state.batch_status[snapshot.batch.batch_id].result,null);assert.equal(state.batch_status[snapshot.batch.batch_id].disposition,null);
   if(action==='complete')assert.equal(state.handled[snapshot.batch.event_ids[0]].source,'central-inbox');
   if(action==='defer'){assert.equal(t.item(1,message.message_id).defer_until,until);assert.equal(state.deferred[snapshot.batch.event_ids[0]].until_utc,until);}
   assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1);t.cold();assert.deepEqual(t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1}),receipt);
  }finally{await t.close();}
 }
});

test('execution-only finish retains an accepted ACK including an explicitly empty completion list',async()=>{
 for(const completeInput of [false,true]){
  const t=await setup();try{
   const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY accepted ACK remains evidence'),snapshot=t.prepare(1,1,[t.admit(1,[message.message_id])]);
   const result=parseActionResult(JSON.stringify({...(completeInput?completed(snapshot.batch):silent),records:[{key:'TEST-retained-ACK-record',kind:'finding',summary:'TEST ONLY Agent chose this record'}]}));
   t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result});const before=t.item(1,message.message_id),acknowledged=t.inspect(1).state.batch_status[snapshot.batch.batch_id];t.cold();
   const receipt=t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1}),status=t.inspect(1).state.batch_status[snapshot.batch.batch_id];
   assert.equal(receipt.semantic_ack_received,true);assert.deepEqual(receipt.unresolved_event_ids,completeInput?[]:snapshot.batch.event_ids);assert.deepEqual(status.result,result);assert.equal(status.disposition,result.disposition);assert.equal(status.acknowledged_at_utc,acknowledged.acknowledged_at_utc);assert.equal(status.acknowledged,true);assert.equal(status.turn_status,'ok');
   assert.equal(t.item(1,message.message_id).revision,before.revision);assert.equal(t.item(1,message.message_id).status,completeInput?'handled':'pending');assert.equal(t.inspect(1).events.filter(event=>event.payload?.record?.key==='TEST-retained-ACK-record').length,1);
   t.advance(10000);t.cold();assert.deepEqual(t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1}),receipt);assert.deepEqual(t.inspect(1).state.batch_status[snapshot.batch.batch_id],status);
  }finally{await t.close();}
 }
});

test('execution-only cold finish reconciles an already accepted semantic checkpoint gap once',async()=>{
 const t=await setup();try{
  const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY accepted checkpoint survives receipt loss'),snapshot=t.prepare(1,1,[t.admit(1,[message.message_id])]);
  const result=parseActionResult(JSON.stringify({...completed(snapshot.batch),records:[{key:'TEST-checkpoint-ACK-record',kind:'decision',summary:'TEST ONLY explicit completion before receipt loss'}]}));
  const world=t.rooms.recentEvents,commit=world.commit.bind(world);world.commit=next=>{if(next.drafts?.[snapshot.batch.batch_id]?.semantic_applied===true)throw Error('TEST_ONLY_AFTER_ACCEPTED_ACK');return commit(next);};
  assert.throws(()=>t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result}),/TEST_ONLY_AFTER_ACCEPTED_ACK/);assert.equal(world.state.drafts[snapshot.batch.batch_id].semantic_applied,false);const decided=t.item(1,message.message_id);t.cold();
  const receipt=t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1});assert.equal(receipt.semantic_ack_received,true);assert.deepEqual(receipt.unresolved_event_ids,[]);assert.equal(t.rooms.recentEvents.state.drafts[snapshot.batch.batch_id].semantic_applied,true);
  assert.equal(t.item(1,message.message_id).status,'handled');assert.equal(t.item(1,message.message_id).revision,decided.revision);assert.deepEqual(t.inspect(1).state.batch_status[snapshot.batch.batch_id].result,result);assert.equal(t.inspect(1).events.filter(event=>event.payload?.record?.key==='TEST-checkpoint-ACK-record').length,1);
  assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1);assert.deepEqual(t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1}),receipt);
 }finally{await t.close();}
});

test('execution finish rejects a foreign owner, mismatched native turn, fabricated result and failed history',async()=>{
 const t=await setup();try{
  const snapshot=t.prepare(1,1),before=t.inspect(1).state.batch_status[snapshot.batch.batch_id];
  assert.throws(()=>t.call(0,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1}),/DELIVERY_BATCH_NOT_FOUND/);
  assert.throws(()=>t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:2}),/DELIVERY_WAKE_ID_MISMATCH/);
  assert.throws(()=>t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1,result:silent}),/EXECUTION_FINISH_DOES_NOT_ACCEPT_AGENT_RESULT/);
  assert.throws(()=>t.call(1,'finish_execution',{batch_id:snapshot.batch.batch_id,turn:1,turn_status:'failed'}),/NATIVE_COMPLETED_TURN_REQUIRED/);
  assert.deepEqual(t.inspect(1).state.batch_status[snapshot.batch.batch_id],before);assert.equal(t.rooms.recentEvents.state.drafts[snapshot.batch.batch_id],undefined);
  for(const [turn,state]of [[2,'failed'],[3,'interrupted']]){
   const batch=t.prepare(1,turn).batch;t.call(1,'fail',{batch_id:batch.batch_id,turn_status:state,error_code:'TEST_NATIVE_HISTORY'});const failed=t.inspect(1).state.batch_status[batch.batch_id];
   assert.throws(()=>t.call(1,'finish_execution',{batch_id:batch.batch_id,turn}),/FAILED_BATCH_REQUIRES_NEW_WAKE/);assert.deepEqual(t.inspect(1).state.batch_status[batch.batch_id],failed);
  }
 }finally{await t.close();}
});

test('ACK cannot override an explicit defer or continue and reports the conflict without saving records',async()=>{
 for(const action of ['defer','continue']){
  const t=await setup();try{
   const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY explicit choice wins'),first=t.prepare(1,1,[t.admit(1,[message.message_id])]),id=first.batch.event_ids[0],item=t.item(1,message.message_id);
   t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:item.inbox_id,expectedRevision:item.revision,action,...action==='defer'?{until:null}:{}}});
   const before=t.item(1,message.message_id),bad={...completed(first.batch),records:[{key:'TEST-conflicting-ACK-record',kind:'decision',summary:'TEST ONLY must remain unsaved'}]};
   assert.throws(()=>t.call(1,'ack',{batch_id:first.batch.batch_id,result:bad}),/ACK_CONFLICTS_WITH_INPUT_DECISION/);
   assert.equal(t.rooms.recentEvents.state.drafts[first.batch.batch_id],undefined);assert.equal(t.item(1,message.message_id).revision,before.revision);
   assert.equal(t.item(1,message.message_id).status,action==='defer'?'deferred':'pending');
   const state=t.inspect(1);assert.equal(state.state.handled[id],undefined);assert(!state.events.some(event=>event.payload?.record?.key==='TEST-conflicting-ACK-record'));
   assert.equal(state.events.filter(event=>event.payload?.code==='ACK_CONFLICTS_WITH_INPUT_DECISION').length,1);
   assert.throws(()=>t.call(1,'ack',{batch_id:first.batch.batch_id,result:bad}),/ACK_CONFLICTS_WITH_INPUT_DECISION/);assert.equal(t.inspect(1).events.filter(event=>event.payload?.code==='ACK_CONFLICTS_WITH_INPUT_DECISION').length,1);
   t.call(1,'ack',{batch_id:first.batch.batch_id,result:silent});t.call(1,'complete',{batch_id:first.batch.batch_id,result:silent});
   assert.equal(t.item(1,message.message_id).revision,before.revision);assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1);
  }finally{await t.close();}
 }
});

test('the next real wake can complete a prior continue, while a deliberate same-wake complete and ignore remain authoritative',async()=>{
 const t=await setup();try{
  const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY continue now complete later'),first=t.prepare(1,1,[t.admit(1,[message.message_id])]),item=t.item(1,message.message_id);
  t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:item.inbox_id,expectedRevision:item.revision,action:'continue'}});t.call(1,'complete',{batch_id:first.batch.batch_id,result:silent});
  t.advance(1000);const next=t.prepare(1,2);t.cold();t.call(1,'complete',{batch_id:next.batch.batch_id,result:completed(next.batch)});assert.equal(t.item(1,message.message_id).status,'handled');
  for(const action of ['complete','ignore']){
   const m=t.post(0,room,'TEST ONLY terminal '+action),batch=t.prepare(1,action,[t.admit(1,[m.message_id])]),current=t.item(1,m.message_id);
   t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:current.inbox_id,expectedRevision:current.revision,action}});const decided=t.item(1,m.message_id);
   t.call(1,'complete',{batch_id:batch.batch.batch_id,result:completed(batch.batch)});assert.equal(t.item(1,m.message_id).status,action==='ignore'?'ignored':'handled');assert.equal(t.item(1,m.message_id).decision_revision,decided.decision_revision);
  }
 }finally{await t.close();}
});

test('old snapshot arrays retain their immutable view and cannot silently consume a direct defer',async()=>{
 const t=await setup();try{
  const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),m=t.post(0,room,'TEST ONLY old snapshot compatibility'),first=t.prepare(1,1,[t.admit(1,[m.message_id])]),world=t.rooms.recentEvents;
  world.commit({snapshots:{[first.batch.batch_id]:first.events.map(event=>event.event_id)}});const current=t.item(1,m.message_id);
  t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:current.inbox_id,expectedRevision:current.revision,action:'defer',until:null}});t.cold();
  assert.deepEqual(t.prepare(1,1).events,first.events);assert.throws(()=>t.call(1,'ack',{batch_id:first.batch.batch_id,result:completed(first.batch)}),/ACK_CONFLICTS_WITH_INPUT_DECISION/);assert.equal(t.item(1,m.message_id).status,'deferred');
 }finally{await t.close();}
});

test('a contradictory old durable ACK exposes recovery failure and preserves a deferred input',async()=>{
 const t=await setup();try{
  const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),m=t.post(0,room,'TEST ONLY old ACK conflict'),first=t.prepare(1,1,[t.admit(1,[m.message_id])]),world=t.rooms.recentEvents,item=t.item(1,m.message_id);
  t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:item.inbox_id,expectedRevision:item.revision,action:'defer',until:null}});const deferred=t.item(1,m.message_id);
  world.updateDraft(first.batch.batch_id,{schema_version:2,life_id:t.life(1),session_id:t.authority(1),result:completed(first.batch),state:'acknowledged',semantic_applied:false,
   input_decision_revisions:{[item.inbox_id]:deferred.decision_revision}});t.cold();t.advance(1000);t.prepare(1,2);
  assert.equal(t.item(1,m.message_id).status,'deferred');assert.equal(t.item(1,m.message_id).decision_revision,deferred.decision_revision);
  const state=t.inspect(1);assert.equal(state.state.handled[first.batch.event_ids[0]],undefined);assert(state.events.some(event=>event.payload?.code==='RECENT_ACK_RECONCILE_FAILED'));
  assert.equal(t.rooms.recentEvents.state.drafts[first.batch.batch_id].semantic_applied,false);
 }finally{await t.close();}
});
test('native emit retries retain first availability across time and cold reopen, but changed source facts conflict',async()=>{
  const t=await setup();try {
    const input={source_key:'TEST-stable-retry',event_type:'external_stimulus',body:'TEST ONLY unchanged',payload:{value:1}};
    const first=t.call(1,'emit',{event:input});t.advance(60000);
    assert.deepEqual(t.call(1,'emit',{event:input}),first);
    t.cold();t.advance(60000);assert.deepEqual(t.call(1,'emit',{event:input}),first);
    assert.equal(first.occurred_at_utc,null);
    for(const patch of [{body:'TEST ONLY changed'},{payload:{value:2}},{event_type:'system'},{occurred_at_utc:t.utc()}])
      assert.throws(()=>t.call(1,'emit',{event:{...input,...patch}}),/EVENT_IDEMPOTENCE_CONFLICT/);
    assert.equal(t.rooms.recentEvents.store.events.filter(e=>e.source_key===first.source_key).length,1);
    assert.equal(t.rooms.recentEvents.all(t.life(0)).some(e=>e.event_id===first.event_id),false);
  }finally{await t.close();}
});

test('Room projection preserves private versus shared scope without exposing private tools to peers',async()=>{
  const t=await setup();try {
    const members=['human:maintainer',t.life(0),t.life(1)];
    for(const visibility of ['private','shared']){
      const room=t.rooms.defineRoom({participants:members,room_type:'group',visibility});
      const message=t.rooms.postHuman('human:maintainer',{room_id:room.room_id,body:'TEST ONLY '+visibility});
      t.rooms.recentEvents.sync(t.life(1),t.authority(1));
      const e=t.rooms.recentEvents.all(t.life(1)).find(e=>e.event_id===roomEventId(room.room_id,message.message_id));
      assert.equal(e.payload.room_visibility,visibility);
      assert.match(renderEventBlock({lifeId:t.life(1),event:e}),visibility==='private'?/In: 私密多人会话/:/In: 公共区域/);
    }
    const own=t.call(0,'emit',{event:{source_key:'TEST-own-read',event_type:'tool_action',body:'我完成了工具 read 的调用。',payload:{tool_name:'read'}}});
    assert.equal(t.rooms.recentEvents.all(t.life(1)).some(e=>e.event_id===own.event_id),false);
  }finally{await t.close();}
});
async function setup() {
  const fixture=await createFixture(['A','B','C']);let registry;
  try {
    registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});for(const manifest of fixture.manifests)registry.register(manifest);
    const contexts=new LifeContexts(registry),t={fixture,registry,contexts,now:Date.parse('2026-10-06T02:00:00.000Z')};
    const clock=()=>t.now;t.tasks=new TaskStore({contexts,root:resolve(fixture.root,'TEST-ONLY-recent-tasks'),now:clock});
    t.roomRoot=resolve(fixture.root,'TEST-ONLY-recent-rooms');t.tokens=fixture.manifests.map(()=> 'TEST ONLY '+randomUUID());
    t.bindings=new Map(fixture.manifests.map((manifest,index)=>[manifest.lifeId,{token:t.tokens[index],allowedPresetId:manifest.deployment.presetId,humanPrincipalId:'human:maintainer'}]));
    t.authority=index=>fixture.manifests[index].authoritySessionId;
    t.life=index=>fixture.manifests[index].lifeId;
    t.mount=()=>{
      t.rooms=new Conversations({contexts,root:t.roomRoot,tasks:t.tasks,now:clock});
      t.gateway=new WorkerGateway({registry,rooms:t.rooms,tasks:t.tasks,workerBindings:t.bindings});
      t.handles=fixture.manifests.map((manifest,index)=>t.gateway.authenticate({lifeId:manifest.lifeId,token:t.tokens[index]}));
    };
    t.mount();
    for(const [index,manifest] of fixture.manifests.entries())t.gateway.registerSession(t.handles[index],{presetId:manifest.deployment.presetId,role:'authority',
      header:{version:4,id:manifest.authoritySessionId,cwd:manifest.deployment.workspace,createdAt:index+1,agentPreset:manifest.deployment.presetId,isSeeded:false}});
    t.rooms.registerHuman({sender_id:'human:maintainer',display_name:'用户'});
    t.utc=()=>new Date(t.now).toISOString();t.advance=milliseconds=>{t.now+=milliseconds;};
    t.call=(index,operation,input={},sessionId=t.authority(index))=>t.gateway.timeline(t.handles[index],{recent:{operation,sessionId,...input}});
    t.inspect=(index,sessionId)=>t.call(index,'inspect',{},sessionId);
    t.prepare=(index,turn,trigger_messages=[],sessionId=t.authority(index))=>t.call(index,'prepare',{wake_id:sessionId+':'+turn,cutoff_at_utc:t.utc(),trigger_messages},sessionId);
    t.post=(index,room,body,extra={})=>t.gateway.post(t.handles[index],{sessionId:t.authority(index),args:{room_id:room.room_id,body,...extra}});
    // Simulate only durable artifacts created by the historical ACK dispatcher.
    // The current implementation must read these receipts and never replay them.
    t.legacy=(index,batch,result,saved=[])=>{
      result=parseActionResult(JSON.stringify(result));
      const owner={lifeId:t.life(index),sessionId:t.authority(index),task:t.tasks.forSession(t.authority(index))},world=t.rooms.recentEvents;
      const resolved=result.actions.map(action=>action.type==='send_message'?t.rooms.resolveRecentActionTarget({...owner,action}):null);
      world.updateDraft(batch.batch_id,{life_id:owner.lifeId,session_id:owner.sessionId,state:'prepared',result,resolved_targets:resolved});
      world.recordResult(owner,batch,result);
      for(const n of saved){const action=result.actions[n];t.post(index,{room_id:resolved[n]},action.body,{message_id:'batch-action:'+batch.batch_id+':'+n,...action.reply_to?{reply_to:action.reply_to}:{}});}
    };
    t.admit=(index,messageIds,sessionId=t.authority(index))=>{
      const items=t.gateway.inbox(t.handles[index],{includeTerminal:true}).items.filter(item=>messageIds.includes(item.message_id));
      assert.equal(items.length,messageIds.length,'every intended native input has its existing durable Inbox row');
      const selection=t.gateway.selectBatch(t.handles[index],{sessionId,items:items.map(item=>({inbox_id:item.inbox_id,expectedRevision:item.revision}))});
      t.gateway.acknowledgeBatch(t.handles[index],{sessionId,inbox_ids:selection.attempt.inbox_ids,attempt_id:selection.attempt.attempt_id});
      return selection.native_message;
    };
    t.item=(index,messageId)=>t.gateway.inbox(t.handles[index],{includeTerminal:true}).items.find(item=>item.message_id===messageId);
    t.cold=()=>{t.rooms.close();t.mount();};
    t.close=async()=>{t.rooms.close();registry.close();await fixture.cleanup();};return t;
  }catch(error){registry?.close();await fixture.cleanup();throw error;}
}

test('authenticated human occurrence and delivery stay distinct; explicit ACK completes independently of native finalization',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:['human:maintainer',t.life(1)]}),message=t.rooms.postHuman('human:maintainer',{room_id:room.room_id,body:'TEST ONLY human event'});
    const original=t.item(1,message.message_id);t.advance(19*60*1000);
    const snapshot=t.prepare(1,1,[t.admit(1,[message.message_id])]),event=snapshot.batch.events[0];
    assert.equal(event.event_id,roomEventId(room.room_id,message.message_id));assert.equal(event.from_actor_id,'human:maintainer');assert.equal(event.to_actor_id,t.life(1));
    assert.equal(event.occurred_at_utc,message.timestamp);assert.equal(snapshot.batch.delivered_at_utc,t.utc());assert.notEqual(event.occurred_at_utc,snapshot.batch.delivered_at_utc);
    const block=renderEventBlock({lifeId:t.life(1),event});assert.match(block,/From: 用户/u);assert.match(block,/To: 我/u);assert.match(block,/北京 2026-10-06 10:00:00/u);
    const result=completed(snapshot.batch);t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result});
    assert.equal(t.item(1,message.message_id).status,'handled');assert.equal(t.inspect(1).state.batch_status[snapshot.batch.batch_id].turn_status,'running');assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1);
    t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result});
    const handled=t.item(1,message.message_id);assert.equal(handled.status,'handled');assert.equal(handled.disposition,'silent');assert.equal(t.inspect(1).state.batch_status[snapshot.batch.batch_id].turn_status,'ok');
    assert.equal(t.inspect(1).state.handled[event.event_id].source,'central-inbox');assert.equal(t.inspect(1).state.handled[event.event_id].explicit,true);assert.equal(t.gateway.inbox(t.handles[1]).items.length,0,'handled Inbox rows are terminal');
    assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1,'silent produces no public speech');assert.equal(original.message.body,'TEST ONLY human event');
  }finally{await t.close();}
});

test('missing ACK, provider failure, and interrupted turn retain unhandled input without inventing silence',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]});
    for(const [turn,status] of [[1,'failed'],[2,'interrupted']]) {
      const message=t.post(0,room,'TEST ONLY failed source '+turn),snapshot=t.prepare(1,turn,[t.admit(1,[message.message_id])]);
      assert.throws(()=>t.call(1,'ack',{batch_id:snapshot.batch.batch_id}),error=>error.code==='ACTION_RESULT_ACK_MISSING');
      t.call(1,'fail',{batch_id:snapshot.batch.batch_id,turn_status:status,error_code:'TEST_PROVIDER_FAILURE'});
      const state=t.inspect(1).state;assert.equal(state.batch_status[snapshot.batch.batch_id].turn_status,status);assert.equal(state.batch_status[snapshot.batch.batch_id].disposition,null);assert.equal(state.handled[snapshot.batch.event_ids[0]],undefined);
      assert.notEqual(t.item(1,message.message_id).status,'handled');
      assert.throws(()=>t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result:silent}),/FAILED_BATCH_REQUIRES_NEW_WAKE/u);
      assert.notEqual(t.item(1,message.message_id).status,'handled','late completion cannot mutate Inbox before rejecting a failed batch');
    }
    assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,2);
  }finally{await t.close();}
});

test('native Room sends can target other conversations and semantic ACK retries never send',async()=>{
 const t=await setup();try{
  const source=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),target=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),message=t.post(0,source,'TEST ONLY semantic input'),snapshot=t.prepare(1,1,[t.admit(1,[message.message_id])]);
  const sent=t.post(1,target,'TEST ONLY sole native tool send',{message_id:'TEST-native-target-send'}),result=completed(snapshot.batch);
  t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result});t.cold();t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result});t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result});
  assert.equal(t.gateway.read(t.handles[1],{room_id:target.room_id}).messages.length,1);assert.equal(sent.message_id,'TEST-native-target-send');assert.equal(t.item(1,message.message_id).status,'handled');assert.deepEqual(t.inspect(1).state.batch_status[snapshot.batch.batch_id].result,result);
 }finally{await t.close();}
});

test('invalid action result and invalid future defer are rejected before any public action',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY untouched after invalid ACK'),snapshot=t.prepare(1,1,[t.admit(1,[message.message_id])]);
    assert.throws(()=>t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result:{...silent,actions:[{type:'send_message',conversation_id:room.room_id,body:'TEST ONLY forbidden silent action'}]}}),error=>error.code==='ACTION_RESULT_ACK_INVALID');
    const actions=[{type:'defer',event_id:snapshot.batch.event_ids[0],until:new Date(t.now-1000).toISOString()}];
    assert.throws(()=>t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result:{status:'ok',disposition:'acted',actions}}),/DEFER_REQUIRES_FUTURE_TIME/u);
    assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1);assert.deepEqual(t.inspect(1).state.handled,{});
  }finally{await t.close();}
});

test('Host actor and public-area resolution remains available independently of the ACK protocol',async()=>{
 const t=await setup();try{
  const target=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),publicArea=t.rooms.defineRoom({participants:[t.life(0),t.life(1),t.life(2)],room_type:'group',visibility:'shared'}),owner={lifeId:t.life(1),sessionId:t.authority(1)};
  assert.equal(t.rooms.resolveRecentActionTarget({...owner,action:{to_actor_id:t.life(2)}}),target.room_id);assert.equal(t.rooms.resolveRecentActionTarget({...owner,action:{public_area_id:publicArea.room_id}}),publicArea.room_id);
  const direct=t.post(1,target,'TEST ONLY addressed to C',{message_id:'TEST-native-direct'}),publicMessage=t.post(1,publicArea,'TEST ONLY addressed to public area',{message_id:'TEST-native-public'}),snapshot=t.prepare(1,1);
  t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result:silent});const next=t.prepare(1,2),directEvent=next.events.find(event=>event.payload?.message_id===direct.message_id),publicEvent=next.events.find(event=>event.payload?.message_id===publicMessage.message_id);
  assert.equal(directEvent.to_actor_id,t.life(2));assert.match(renderEventBlock({lifeId:t.life(1),event:directEvent}),/From: 我\nTo: TEST ONLY C/u);assert.equal(publicEvent.to_actor_id,undefined);assert.match(renderEventBlock({lifeId:t.life(1),event:publicEvent}),/\nTo: everyone/u);assert.deepEqual(t.inspect(1).state.batch_status[snapshot.batch.batch_id].result,silent);
 }finally{await t.close();}
});

test('Host target lookup rejects ambiguous actors, inaccessible routes, non-public areas and invalid replies without sending',async()=>{
 const t=await setup();try{
  const first=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),second=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),valid=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),privateGroup=t.rooms.defineRoom({participants:[t.life(0),t.life(1),t.life(2)],room_type:'group'}),owner={lifeId:t.life(1),sessionId:t.authority(1)};
  for(const [action,code] of [[{to_actor_id:t.life(0)},'RECENT_ACTION_TARGET_AMBIGUOUS'],[{to_actor_id:'life-not-accessible'},'RECENT_ACTION_TARGET_NOT_AVAILABLE'],[{to_actor_id:t.life(1)},'RECENT_ACTION_TARGET_NOT_AVAILABLE'],[{public_area_id:valid.room_id},'PUBLIC_AREA_REQUIRES_SHARED_GROUP'],[{public_area_id:privateGroup.room_id},'PUBLIC_AREA_REQUIRES_SHARED_GROUP'],[{conversation_id:valid.room_id,reply_to:'not-visible-message'},'REPLY_TARGET_NOT_VISIBLE']])assert.throws(()=>t.rooms.resolveRecentActionTarget({...owner,action}),error=>error.code===code);
  for(const room of [first,second,valid,privateGroup])assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,0);
 }finally{await t.close();}
});

test('activity-bound Host route lookup cannot escape into authority Rooms',async()=>{
 const t=await setup();try{
  const sessionId=randomUUID(),manifest=t.fixture.manifests[1];t.gateway.registerSession(t.handles[1],{role:'activity',presetId:manifest.deployment.presetId,header:{version:4,id:sessionId,cwd:manifest.deployment.workspace,createdAt:20,agentPreset:manifest.deployment.presetId,isSeeded:false}});
  const activity=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),authority=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),authorityC=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]});t.rooms.bindReceiver({lifeId:t.life(1),room_id:activity.room_id,sessionId});
  assert.equal(t.rooms.resolveRecentActionTarget({lifeId:t.life(1),sessionId,action:{to_actor_id:t.life(0)}}),activity.room_id);
  for(const [action,code] of [[{conversation_id:authority.room_id},'DELIVERY_ACTION_SESSION_MISMATCH'],[{to_actor_id:t.life(2)},'RECENT_ACTION_TARGET_NOT_AVAILABLE']])assert.throws(()=>t.rooms.resolveRecentActionTarget({lifeId:t.life(1),sessionId,action}),error=>error.code===code);
  for(const room of [activity,authority,authorityC])assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,0);
 }finally{await t.close();}
});

test('historical outward receipts use their saved route even after actor lookup becomes ambiguous',async()=>{
 const t=await setup();try{
  const target=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),snapshot=t.prepare(1,1),old={status:'ok',disposition:'acted',actions:[{type:'send_message',to_actor_id:t.life(2),body:'TEST ONLY fixed route'}]};t.legacy(1,snapshot.batch,old,[0]);
  const other=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]});t.cold();assert.throws(()=>t.rooms.resolveRecentActionTarget({lifeId:t.life(1),sessionId:t.authority(1),action:old.actions[0]}),/RECENT_ACTION_TARGET_AMBIGUOUS/);
  assert.equal(t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result:old}).effect_results[0].status,'confirmed_success');assert.equal(t.gateway.read(t.handles[1],{room_id:target.room_id}).messages.length,1);assert.equal(t.gateway.read(t.handles[1],{room_id:other.room_id}).messages.length,0);
 }finally{await t.close();}
});

test('unjoined and revoked routes cannot receive actions and legacy evidence never reroutes',async()=>{
 const t=await setup();try{
  const source=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),hidden=t.rooms.defineRoom({participants:[t.life(0),t.life(2)]}),owner={lifeId:t.life(1),sessionId:t.authority(1)};
  for(const [action,code] of [[{to_actor_id:t.life(2)},'RECENT_ACTION_TARGET_NOT_AVAILABLE'],[{conversation_id:hidden.room_id},'CONVERSATION_NOT_VISIBLE']])assert.throws(()=>t.rooms.resolveRecentActionTarget({...owner,action}),error=>error.code===code);
  const target=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),snapshot=t.prepare(1,1),old={status:'ok',disposition:'acted',actions:[{type:'send_message',to_actor_id:t.life(2),body:'TEST ONLY durable before revocation'}]};t.legacy(1,snapshot.batch,old,[0]);t.rooms.setMembership({room_id:target.room_id,principalId:t.life(1),present:false,expectedRevision:1});
  const replacement=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]});t.cold();const receipt=t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result:old});assert.equal(receipt.effect_results[0].status,'unknown');assert.equal(t.gateway.read(t.handles[1],{room_id:replacement.room_id}).messages.length,0);assert.equal(t.gateway.read(t.handles[1],{room_id:source.room_id}).messages.length,0);
 }finally{await t.close();}
});

test('legacy partial outward completion reports unknown instead of blindly executing the missing action',async()=>{
 const t=await setup();try{
  const source=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),target=t.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),message=t.post(0,source,'TEST ONLY retry trigger'),snapshot=t.prepare(1,1,[t.admit(1,[message.message_id])]),old={status:'ok',disposition:'acted',actions:[{type:'send_message',conversation_id:target.room_id,body:'TEST ONLY first durable send'},{type:'send_message',conversation_id:target.room_id,body:'TEST ONLY second unknown send'}]};
  t.legacy(1,snapshot.batch,old,[0]);t.cold();const receipt=t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result:old});assert.deepEqual(receipt.effect_results.map(effect=>effect.status),['confirmed_success','unknown']);assert.equal(t.gateway.read(t.handles[1],{room_id:target.room_id}).messages.length,1);assert.equal(t.item(1,message.message_id).status,'pending');assert.deepEqual(t.inspect(1).state.handled,{});
 }finally{await t.close();}
});

test('a confirmed native send and empty ACK survive later turn failure without semantic completion or replay',async()=>{
 const t=await setup();try{
  const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY turn may fail after ACK'),snapshot=t.prepare(1,1,[t.admit(1,[message.message_id])]);
  const sent=t.post(1,room,'TEST ONLY confirmed native action',{message_id:'TEST-native-before-failure'});t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result:silent});t.call(1,'fail',{batch_id:snapshot.batch.batch_id,turn_status:'interrupted'});
  assert.equal(t.rooms.actionResultForLife({lifeId:t.life(1),sessionId:t.authority(1),room_id:room.room_id,message_id:sent.message_id}).status,'confirmed_success');assert.equal(t.item(1,message.message_id).status,'pending');assert.deepEqual(t.inspect(1).state.handled,{});
  t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result:silent});t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result:silent});assert.equal(t.inspect(1).state.batch_status[snapshot.batch.batch_id].turn_status,'interrupted');assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,2);
 }finally{await t.close();}
});

test('single delivery compatibility uses the native batch seam and reply remains independent of semantic completion',async()=>{
 const t=await setup();try{
  const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY old single API'),item=t.item(1,message.message_id),sessionId=t.authority(1),selected=t.gateway.selectDelivery(t.handles[1],{sessionId,inbox_id:item.inbox_id,expectedRevision:item.revision});
  t.gateway.acknowledgeDelivery(t.handles[1],{sessionId,inbox_id:item.inbox_id,attempt_id:selected.attempt.attempt_id,native_state:'pending'});assert.equal(selected.native_message.source.kind,'room-inbox-batch');assert.deepEqual(selected.native_message.source.inboxIds,[item.inbox_id]);
  const snapshot=t.prepare(1,1,[selected.native_message]);t.post(1,room,'TEST ONLY one reply',{reply_to:message.message_id,message_id:'TEST-native-reply-1'});t.post(1,room,'TEST ONLY one reply',{reply_to:message.message_id,message_id:'TEST-native-reply-2'});assert.equal(t.item(1,message.message_id).status,'pending');
  const result=completed(snapshot.batch);t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result});t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result});t.cold();t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result});
  assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.filter(row=>row.reply_to===message.message_id).length,1);assert.equal(t.item(1,message.message_id).status,'handled');assert.equal(t.inspect(1).state.handled[snapshot.batch.event_ids[0]].source,'central-inbox');
 }finally{await t.close();}
});

test('owner Session binding and private visibility prevent another life from learning private event existence',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY PRIVATE EVENT CANARY'),snapshot=t.prepare(1,1,[t.admit(1,[message.message_id])]);
    const other=t.prepare(2,1);assert.deepEqual(other.batch.event_ids,[]);assert(!JSON.stringify(other).includes('PRIVATE EVENT CANARY'));assert(!JSON.stringify(t.inspect(2)).includes(snapshot.batch.event_ids[0]));
    assert.throws(()=>t.gateway.timeline(t.handles[2],{recent:{operation:'inspect',sessionId:t.authority(1)}}),/SESSION_OWNER_MISMATCH/u);
    assert.throws(()=>t.call(2,'ack',{batch_id:snapshot.batch.batch_id,result:silent}),/BATCH_NOT_FOUND|DELIVERY_BATCH_NOT_FOUND/u);
    assert.throws(()=>t.prepare(1,2,[],t.authority(0)),/SESSION_OWNER_MISMATCH/u);
  }finally{await t.close();}
});

test('public room members receive independent batches; broadcasts address everyone and first person is mechanical',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1),t.life(2)],room_type:'group',visibility:'shared'}),message=t.post(0,room,'TEST ONLY shared room event');
    const b=t.prepare(1,1,[t.admit(1,[message.message_id])]),c=t.prepare(2,1,[t.admit(2,[message.message_id])]);
    assert.equal(b.batch.event_ids[0],c.batch.event_ids[0]);assert.notEqual(b.batch.batch_id,c.batch.batch_id);
    for(const [index,snapshot] of [[1,b],[2,c]]) {const event=snapshot.batch.events[0];assert.equal(event.conversation_type,'group');assert(!Object.hasOwn(event,'to_actor_id'));assert.match(renderEventBlock({lifeId:t.life(index),event}),/\nTo: everyone/u);}
    t.call(1,'complete',{batch_id:b.batch.batch_id,result:completed(b.batch)});assert.equal(t.item(1,message.message_id).status,'handled');assert.equal(t.item(2,message.message_id).status,'pending');
    const response=t.post(1,room,'TEST ONLY own public action'),own=t.prepare(1,2).events.find(event=>event.payload?.message_id===response.message_id);assert.match(renderEventBlock({lifeId:t.life(1),event:own}),/From: 我/u);
    const incoming=t.prepare(2,2,[t.admit(2,[response.message_id])]).batch.events[0];assert.match(renderEventBlock({lifeId:t.life(2),event:incoming}),/From: TEST ONLY B/u);
  }finally{await t.close();}
});

test('membership removal invalidates a prepared delivery and rejoins do not reveal old membership history',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),old=t.post(0,room,'TEST ONLY revoked membership body'),snapshot=t.prepare(1,1,[t.admit(1,[old.message_id])]);
    t.rooms.setMembership({room_id:room.room_id,principalId:t.life(1),present:false,expectedRevision:1});
    assert.throws(()=>t.call(1,'ack',{batch_id:snapshot.batch.batch_id,result:silent}),/DELIVERY_BATCH_VISIBILITY_REVOKED|DELIVERY_EVENT_NOT_VISIBLE/u);assert(!JSON.stringify(t.inspect(1).events).includes('revoked membership body'));
    t.rooms.setMembership({room_id:room.room_id,principalId:t.life(1),present:true,expectedRevision:2});
    const fresh=t.post(0,room,'TEST ONLY new membership body'),next=t.prepare(1,2,[t.admit(1,[fresh.message_id])]);assert.equal(next.batch.event_ids.length,1);assert.notEqual(next.batch.event_ids[0],snapshot.batch.event_ids[0]);assert(!JSON.stringify(next.events).includes('revoked membership body'));
  }finally{await t.close();}
});

test('activity-bound test Room stays outside authority context, including when another participant projects the same shared event',async()=>{
  const t=await setup();try {
    const sessionId=randomUUID(),manifest=t.fixture.manifests[1];t.gateway.registerSession(t.handles[1],{role:'activity',presetId:manifest.deployment.presetId,header:{version:4,id:sessionId,cwd:manifest.deployment.workspace,createdAt:20,agentPreset:manifest.deployment.presetId,isSeeded:false}});
    const activityRoom=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),mainRoom=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]});t.rooms.bindReceiver({lifeId:t.life(1),room_id:activityRoom.room_id,sessionId});
    const activity=t.post(0,activityRoom,'TEST ONLY INDEPENDENT ACTIVITY CANARY'),main=t.post(0,mainRoom,'TEST ONLY AUTHORITY CANARY');
    t.prepare(0,1); // A projects its own sent event before B views its activity.
    const mainSnapshot=t.prepare(1,1,[t.admit(1,[main.message_id])]);assert(!JSON.stringify(mainSnapshot.events).includes('INDEPENDENT ACTIVITY CANARY'));
    const activitySnapshot=t.prepare(1,1,[t.admit(1,[activity.message_id],sessionId)],sessionId);assert.equal(activitySnapshot.batch.events.length,1);assert(!JSON.stringify(activitySnapshot.events).includes('AUTHORITY CANARY'));
    assert.throws(()=>t.call(1,'complete',{batch_id:activitySnapshot.batch.batch_id,result:silent}),/DELIVERY_BATCH_SESSION_MISMATCH/u);
    t.call(1,'complete',{batch_id:activitySnapshot.batch.batch_id,result:completed(activitySnapshot.batch)},sessionId);assert.equal(t.item(1,activity.message_id).status,'handled');assert.equal(t.item(1,main.message_id).status,'pending');
  }finally{await t.close();}
});

test('repeated wake freezes all scoped pending inputs at cutoff and later arrivals wait for a new real wake',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),a=t.post(0,room,'TEST ONLY pending A'),b=t.post(0,room,'TEST ONLY pending B');
    const source=t.admit(1,[a.message_id]),first=t.prepare(1,1,[source]);assert.equal(first.batch.event_ids.length,2);assert(first.batch.events.some(event=>event.payload.message_id===b.message_id));
    t.advance(1000);const c=t.post(0,room,'TEST ONLY arrived while snapshot running'),repeated=t.prepare(1,1,[source]);assert.deepEqual(repeated.batch,first.batch);assert.deepEqual(repeated.events,first.events);assert(!JSON.stringify(repeated.events).includes(c.body));
    t.call(1,'complete',{batch_id:first.batch.batch_id,result:completed(first.batch)});const next=t.prepare(1,2);assert.deepEqual(next.batch.event_ids,[roomEventId(room.room_id,c.message_id)]);assert.equal(t.item(1,a.message_id).status,'handled');assert.equal(t.item(1,b.message_id).status,'handled');assert.equal(t.item(1,c.message_id).status,'pending');
  }finally{await t.close();}
});

test('delivery history comes from exact visible Session batches and an older repeated snapshot excludes later delivery metadata',async()=>{
  const t=await setup();try {
    const sessionId=randomUUID(),manifest=t.fixture.manifests[1];t.gateway.registerSession(t.handles[1],{role:'activity',presetId:manifest.deployment.presetId,header:{version:4,id:sessionId,cwd:manifest.deployment.workspace,createdAt:20,agentPreset:manifest.deployment.presetId,isSeeded:false}});
    const main=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),activityRoom=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]});t.rooms.bindReceiver({lifeId:t.life(1),room_id:activityRoom.room_id,sessionId});
    const old=t.post(0,main,'TEST ONLY historical delivery'),activity=t.post(0,activityRoom,'TEST ONLY other activity delivery');
    const first=t.prepare(1,1,[t.admit(1,[old.message_id])]);t.call(1,'complete',{batch_id:first.batch.batch_id,result:completed(first.batch)});
    assert.deepEqual(first.delivery_history,[{event_id:first.batch.event_ids[0],batch_id:first.batch.batch_id,delivered_at_utc:first.batch.delivered_at_utc}]);
    t.advance(1000);const privateDelivery=t.prepare(1,1,[t.admit(1,[activity.message_id],sessionId)],sessionId);t.call(1,'complete',{batch_id:privateDelivery.batch.batch_id,result:completed(privateDelivery.batch)},sessionId);
    t.advance(1000);const latest=t.post(0,main,'TEST ONLY latest delivery'),second=t.prepare(1,2,[t.admit(1,[latest.message_id])]);
    assert.deepEqual(second.delivery_history,[...first.delivery_history,{event_id:second.batch.event_ids[0],batch_id:second.batch.batch_id,delivered_at_utc:second.batch.delivered_at_utc}]);
    assert(!JSON.stringify(second.delivery_history).includes(privateDelivery.batch.batch_id));assert(privateDelivery.delivery_history.every(row=>row.batch_id===privateDelivery.batch.batch_id));
    const repeat=t.prepare(1,1);assert.deepEqual(repeat.delivery_history,first.delivery_history);assert(!JSON.stringify(repeat.delivery_history).includes(second.batch.batch_id));
    assert.deepEqual(t.prepare(2,1).delivery_history,[]);
  }finally{await t.close();}
});

test('an earlier prepared batch delivered after the current snapshot cannot inject future delivery history on cold replay',async()=>{
  for(const preparationGap of [0,2000]) {
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY old preparation with delayed formal delivery'),source=t.admit(1,[message.message_id]);
    const store=t.rooms.recentEvents.store,deliver=store.deliverBatch.bind(store);let interrupted=false;
    store.deliverBatch=input=>{if(!interrupted){interrupted=true;throw Object.assign(Error('TEST_OLD_BATCH_WITHOUT_DELIVERY'),{code:'TEST_OLD_BATCH_WITHOUT_DELIVERY'});}return deliver(input);};
    assert.throws(()=>t.prepare(1,1,[source]),/TEST_OLD_BATCH_WITHOUT_DELIVERY/u);
    const unstamped=Object.values(t.inspect(1).state.batches)[0];assert.equal(unstamped.delivered_at_utc,null);
    t.advance(preparationGap);const current=t.prepare(1,2,[source]);
    const expected=[{event_id:current.batch.event_ids[0],batch_id:current.batch.batch_id,delivered_at_utc:current.batch.delivered_at_utc}];
    assert.deepEqual(current.delivery_history,expected,'the initial current batch keeps its own stamped first delivery');
    t.advance(10000);t.cold();const recovered=t.prepare(1,1,[source]);assert(Date.parse(recovered.batch.delivered_at_utc)>Date.parse(current.batch.delivered_at_utc));
    assert.deepEqual(recovered.delivery_history.find(row=>row.batch_id===recovered.batch.batch_id),{event_id:recovered.batch.event_ids[0],batch_id:recovered.batch.batch_id,delivered_at_utc:recovered.batch.delivered_at_utc});
    const replay=t.prepare(1,2,[source]);assert.deepEqual(replay.delivery_history,expected);assert.deepEqual(replay.batch,current.batch);assert.deepEqual(replay.events,current.events);
    const owner={lifeId:t.life(1),sessionId:t.authority(1)};
    assert.deepEqual(t.rooms.recentEvents.deliveryHistory(owner,unstamped,replay.events),preparationGap===0?expected:[],'an unstamped batch uses preparation time as its conservative history cutoff');
  }finally{await t.close();}
  }
});

test('defer expiry reconsiders the same immutable event with a distinct later delivery batch',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY defer once'),first=t.prepare(1,1,[t.admit(1,[message.message_id])]);
    const eventId=first.batch.event_ids[0],until=new Date(t.now+5000).toISOString(),result={status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:eventId,until}]};
    t.call(1,'ack',{batch_id:first.batch.batch_id,result});assert.equal(t.item(1,message.message_id).status,'deferred');assert.equal(t.inspect(1).state.handled[eventId],undefined);
    t.call(1,'complete',{batch_id:first.batch.batch_id,result});assert.equal(t.inspect(1).state.deferred[eventId].until_utc,until);assert.equal(t.inspect(1).state.handled[eventId],undefined);
    t.advance(6000);assert.equal(t.item(1,message.message_id).status,'pending');const second=t.prepare(1,2,[t.admit(1,[message.message_id])]);assert.deepEqual(second.batch.event_ids,[eventId]);assert.deepEqual(second.batch.redelivery_event_ids,[eventId]);assert.deepEqual(second.batch.first_delivery_event_ids,[]);assert.notEqual(first.batch.delivered_at_utc,second.batch.delivered_at_utc);assert.deepEqual(first.batch.events,second.batch.events);
    t.call(1,'complete',{batch_id:second.batch.batch_id,result:completed(second.batch)});assert.equal(t.item(1,message.message_id).status,'handled');
  }finally{await t.close();}
});

test('semantic native stimuli and own actions share one life timeline without granting user-role human identity',async()=>{
  const t=await setup();try {
    const action=t.call(1,'emit',{event:{source_key:'native-tool-call-1',event_type:'tool_action',occurred_at_utc:t.utc(),body:'TEST ONLY I edited a local file',payload:{tool_name:'edit'}}});
    const wake={id:'TEST-schedule-input',source:{kind:'schedule',rpcId:'TEST-schedule-rpc'},content:[{type:'text',text:'TEST ONLY scheduled check'}]},snapshot=t.prepare(1,1,[wake]);
    assert(snapshot.events.some(event=>event.event_id===action.event_id));assert.equal(snapshot.batch.events.length,1);assert.equal(snapshot.batch.events[0].event_type,'scheduler');assert.notEqual(snapshot.batch.events[0].from_actor_id,'human:maintainer');
    assert.equal(t.inspect(0).events.length,0);const repeated=t.prepare(1,1,[wake]);assert.deepEqual(repeated.batch,snapshot.batch);
    t.call(1,'complete',{batch_id:snapshot.batch.batch_id,result:completed(snapshot.batch)});
    const native=t.prepare(1,2,[{id:'TEST-unknown-input',source:{kind:'user',rpcId:'TEST-unknown-rpc'},content:[{type:'text',text:'TEST ONLY unknown native source'}]}]);assert.equal(native.batch.events[0].event_type,'system');assert.equal(native.batch.events[0].from_actor_id,'host:system');
  }finally{await t.close();}
});

test('a past external occurrence arriving after native cutoff stays outside the current fixed snapshot',async()=>{
  const t=await setup();try {
    const cutoff=t.utc(),occurred=new Date(t.now-19*60*1000).toISOString();t.advance(1000);
    const incoming=t.call(1,'emit',{event:{source_key:'TEST-late-observed-external',event_type:'external_stimulus',occurred_at_utc:occurred,body:'TEST ONLY happened earlier but arrived after cutoff'}});
    assert.equal(incoming.occurred_at_utc,occurred);assert.equal(incoming.observed_at_utc,t.utc());assert.equal(incoming.payload.available_at_utc,t.utc());assert(Date.parse(incoming.payload.available_at_utc)>Date.parse(cutoff));
    const first=t.call(1,'prepare',{wake_id:t.authority(1)+':1',cutoff_at_utc:cutoff,trigger_messages:[]});
    assert.deepEqual(first.batch.event_ids,[]);assert(!JSON.stringify(first.events).includes(incoming.event_id));assert(!JSON.stringify(first).includes(incoming.body));
    t.call(1,'complete',{batch_id:first.batch.batch_id,result:silent});t.advance(1000);
    const next=t.prepare(1,2);assert.deepEqual(next.batch.event_ids,[incoming.event_id]);assert.deepEqual(next.batch.events[0],incoming);assert.equal(next.batch.first_delivery_event_ids[0],incoming.event_id);
    assert.deepEqual(t.call(1,'prepare',{wake_id:t.authority(1)+':1',cutoff_at_utc:cutoff,trigger_messages:[]}).events,first.events,'a repeated old wake still excludes the later observed event');
  }finally{await t.close();}
});

test('cold prepare retries a persisted unstamped batch with one formal delivery timestamp and unchanged snapshot',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY persisted before delivery stamp'),source=t.admit(1,[message.message_id]);
    const store=t.rooms.recentEvents.store,deliver=store.deliverBatch.bind(store);let stopped=false;
    store.deliverBatch=input=>{if(!stopped){stopped=true;throw Object.assign(Error('TEST_ONLY_BEFORE_DELIVERY_STAMP'),{code:'TEST_BEFORE_DELIVERY_STAMP'});}return deliver(input);};
    assert.throws(()=>t.prepare(1,1,[source]),/TEST_ONLY_BEFORE_DELIVERY_STAMP/u);
    const state=t.inspect(1).state,prepared=Object.values(state.batches)[0];assert.equal(prepared.delivered_at_utc,null);assert.equal(state.batch_status[prepared.batch_id].turn_status,'prepared');assert.equal(prepared.event_ids.length,1);
    t.advance(5000);const later=t.post(0,room,'TEST ONLY later queued after prepared snapshot');t.rooms.recentEvents.sync(t.life(0),t.authority(0));t.cold();
    const retried=t.prepare(1,1,[source]);assert.equal(retried.batch.batch_id,prepared.batch_id);assert.equal(retried.batch.prepared_at_utc,prepared.prepared_at_utc);assert.equal(retried.batch.delivered_at_utc,t.utc());assert.deepEqual(retried.batch.events,prepared.events);assert.deepEqual(retried.batch.event_ids,prepared.event_ids);assert.equal(retried.batch.snapshot_cutoff_seq,prepared.snapshot_cutoff_seq);assert(!JSON.stringify(retried.events).includes(later.body));
    t.advance(5000);const repeated=t.prepare(1,1,[source]);assert.deepEqual(repeated.batch,retried.batch);assert.deepEqual(repeated.events,retried.events);assert.equal(Object.keys(t.inspect(1).state.batches).length,1);
    t.call(1,'complete',{batch_id:retried.batch.batch_id,result:completed(retried.batch)});assert.equal(t.item(1,message.message_id).status,'handled');assert.equal(t.item(1,later.message_id).status,'pending');
  }finally{await t.close();}
});

test('a successful defer batch complete replay after its deadline does not execute again or swallow reconsideration',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY successful defer must remain reconsiderable'),first=t.prepare(1,1,[t.admit(1,[message.message_id])]);
    const id=first.batch.event_ids[0],until=new Date(t.now+5000).toISOString(),result={status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:id,until}]};
    const ack=t.call(1,'ack',{batch_id:first.batch.batch_id,result});t.call(1,'complete',{batch_id:first.batch.batch_id,result});
    const originalStatus=t.inspect(1).state.batch_status[first.batch.batch_id];assert.equal(originalStatus.turn_status,'ok');assert.equal(t.item(1,message.message_id).status,'deferred');
    t.advance(6000);const due=t.item(1,message.message_id);assert.equal(due.status,'pending');assert.equal(t.rooms.recentEvents.store.pending(t.life(1)).some(event=>event.event_id===id),true);t.cold();
    assert.deepEqual(t.call(1,'ack',{batch_id:first.batch.batch_id,result}),ack,'an identical dispatched ACK is valid after the original defer deadline');
    assert.deepEqual(t.call(1,'complete',{batch_id:first.batch.batch_id,result}),ack);assert.deepEqual(t.call(1,'complete',{batch_id:first.batch.batch_id,result}),ack);
    const after=t.item(1,message.message_id);assert.equal(after.status,'pending');assert.equal(after.revision,due.revision,'replaying the old completion must not decide the newly due Inbox item');assert.deepEqual(t.inspect(1).state.batch_status[first.batch.batch_id],originalStatus);assert.equal(t.inspect(1).state.handled[id],undefined);assert.equal(t.rooms.recentEvents.store.pending(t.life(1)).some(event=>event.event_id===id),true);
    assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1,'deferral produces no public speech');
  }finally{await t.close();}
});

test('revoked old batches expose only their own recovery metadata and can still be failed without leaking bodies',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY REVOKED RECOVERY BODY CANARY'),first=t.prepare(1,1,[t.admit(1,[message.message_id])]);
    t.rooms.setMembership({room_id:room.room_id,principalId:t.life(1),present:false,expectedRevision:1});
    const before=t.inspect(1),redacted=before.state.batches[first.batch.batch_id];assert.equal(redacted.batch_id,first.batch.batch_id);assert.equal(redacted.authority_session_id,t.authority(1));assert.equal(redacted.visibility_revoked,true);assert.deepEqual(redacted.events,[]);assert.equal(before.state.batch_status[first.batch.batch_id].turn_status,'running');assert(!JSON.stringify(before).includes(message.body));assert.deepEqual(before.events,[]);
    assert.throws(()=>t.call(1,'ack',{batch_id:first.batch.batch_id,result:silent}),/DELIVERY_BATCH_VISIBILITY_REVOKED/u);
    const failed=t.call(1,'fail',{batch_id:first.batch.batch_id,turn_status:'interrupted',error_code:'TEST_REVOKED_DURING_RECOVERY'});assert.equal(failed.turn_status,'interrupted');assert.equal(failed.disposition,null);assert.equal(t.inspect(1).state.handled[first.batch.event_ids[0]],undefined);
    t.cold();const cold=t.inspect(1);assert.deepEqual(cold.state.batches[first.batch.batch_id].events,[]);assert.equal(cold.state.batch_status[first.batch.batch_id].turn_status,'interrupted');assert(!JSON.stringify(cold).includes(message.body));assert(!JSON.stringify(t.inspect(2)).includes(first.batch.batch_id));assert(!JSON.stringify(t.inspect(2)).includes(first.batch.event_ids[0]));
  }finally{await t.close();}
});

test('an indefinite deferred Room event stays withheld on unrelated wakes and only explicit process admits redelivery',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY indefinite defer can be reconsidered explicitly'),first=t.prepare(1,1,[t.admit(1,[message.message_id])]),id=first.batch.event_ids[0];
    const deferred={status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:id,until:null}]};t.call(1,'ack',{batch_id:first.batch.batch_id,result:deferred});t.call(1,'complete',{batch_id:first.batch.batch_id,result:deferred});
    assert.equal(t.item(1,message.message_id).status,'deferred');assert.equal(t.inspect(1).state.deferred[id].until_utc,null);assert.equal(t.rooms.recentEvents.store.pending(t.life(1)).some(event=>event.event_id===id),false);
    t.advance(1000);const unrelated=t.prepare(1,2);assert.deepEqual(unrelated.batch.event_ids,[]);assert.equal(t.inspect(1).state.deferred[id].until_utc,null);assert.equal(t.item(1,message.message_id).status,'deferred');t.call(1,'complete',{batch_id:unrelated.batch.batch_id,result:silent});
    const previous=t.item(1,message.message_id);t.rooms.reconcileWorkerDelivery({lifeId:t.life(1),sessionId:t.authority(1),inbox_id:previous.inbox_id,attempt_id:previous.attempt.attempt_id,evidence:{state:'completed',turn:1,effect_results:[],retryable:false}});const current=t.item(1,message.message_id);t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:current.inbox_id,expectedRevision:current.revision,action:'process'}});assert.equal(t.item(1,message.message_id).status,'pending');
    const next=t.prepare(1,3,[t.admit(1,[message.message_id])]);assert.deepEqual(next.batch.event_ids,[id]);assert.deepEqual(next.batch.redelivery_event_ids,[id]);assert.deepEqual(next.batch.first_delivery_event_ids,[]);assert.deepEqual(next.batch.events,first.batch.events);assert.notEqual(next.batch.batch_id,first.batch.batch_id);assert.equal(t.inspect(1).state.deferred[id],undefined);
    t.call(1,'complete',{batch_id:next.batch.batch_id,result:completed(next.batch)});assert.equal(t.item(1,message.message_id).status,'handled');assert.equal(t.inspect(1).state.deferred[id],undefined);assert.equal(t.inspect(1).state.handled[id].source,'central-inbox');assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1);
  }finally{await t.close();}
});

test('first cold completion after dispatched defer expires preserves queued reconsideration and immutable redelivery',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY initial completion arrives after defer deadline'),first=t.prepare(1,1,[t.admit(1,[message.message_id])]),id=first.batch.event_ids[0],until=new Date(t.now+5000).toISOString();
    const result={status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:id,until}]},ack=t.call(1,'ack',{batch_id:first.batch.batch_id,result});
    assert.equal(t.inspect(1).state.batch_status[first.batch.batch_id].turn_status,'running');assert.deepEqual(t.rooms.recentEvents.state.drafts[first.batch.batch_id].receiver_deferred,[{event_id:id,until}]);
    t.advance(6000);const due=t.item(1,message.message_id);assert.equal(due.status,'pending');assert.equal(due.attempt.state,'pending');t.cold();
    assert.deepEqual(t.call(1,'complete',{batch_id:first.batch.batch_id,result}),ack);const after=t.item(1,message.message_id);assert.equal(after.status,'pending');assert.equal(after.revision,due.revision);assert.equal(t.inspect(1).state.handled[id],undefined);assert.equal(t.inspect(1).state.deferred[id],undefined);assert.deepEqual(t.inspect(1).state.batch_status[first.batch.batch_id].result,result);assert.equal(t.rooms.recentEvents.store.pending(t.life(1)).some(event=>event.event_id===id),true);
    const next=t.prepare(1,2,[t.admit(1,[message.message_id])]);assert.deepEqual(next.batch.event_ids,[id]);assert.deepEqual(next.batch.redelivery_event_ids,[id]);assert.deepEqual(next.batch.events,first.batch.events);t.call(1,'complete',{batch_id:next.batch.batch_id,result:completed(next.batch)});assert.equal(t.item(1,message.message_id).status,'handled');assert.equal(t.inspect(1).state.deferred[id],undefined);
  }finally{await t.close();}
});

test('direct Room defer remains separate from silent machine ACK and commits atomically after its deadline',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY direct decision with exact silent machine ACK'),first=t.prepare(1,1,[t.admit(1,[message.message_id])]),id=first.batch.event_ids[0],until=new Date(t.now+5000).toISOString(),item=t.item(1,message.message_id);
    t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:item.inbox_id,expectedRevision:item.revision,action:'defer',until}});const ack=t.call(1,'ack',{batch_id:first.batch.batch_id,result:silent});
    assert.deepEqual(ack.result,silent);assert.deepEqual(t.rooms.recentEvents.state.drafts[first.batch.batch_id].receiver_deferred,[{event_id:id,until}]);assert.equal(t.inspect(1).state.handled[id],undefined);
    t.advance(6000);const due=t.item(1,message.message_id);assert.equal(due.status,'pending');t.cold();assert.deepEqual(t.call(1,'complete',{batch_id:first.batch.batch_id,result:silent}),ack);
    const state=t.inspect(1).state;assert.deepEqual(state.batch_status[first.batch.batch_id].result,silent);assert.equal(state.batch_status[first.batch.batch_id].disposition,'silent');assert.equal(state.handled[id],undefined);assert.equal(state.deferred[id],undefined);assert.equal(t.item(1,message.message_id).revision,due.revision);assert.equal(t.item(1,message.message_id).status,'pending');assert.equal(t.rooms.recentEvents.store.pending(t.life(1)).some(event=>event.event_id===id),true);assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,1);
  }finally{await t.close();}
});

test('cold ACK recovery preserves a later receiver defer after the durable semantic checkpoint marker gap',async()=>{
  const t=await setup();try {
    const room=t.rooms.defineRoom({participants:[t.life(0),t.life(1)]}),message=t.post(0,room,'TEST ONLY checkpoint gap'),first=t.prepare(1,1,[t.admit(1,[message.message_id])]),id=first.batch.event_ids[0],item=t.item(1,message.message_id);
    t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:item.inbox_id,expectedRevision:item.revision,action:'defer',until:null}});
    const world=t.rooms.recentEvents,commit=world.commit.bind(world);world.commit=next=>{if(next.drafts?.[first.batch.batch_id]?.semantic_applied===true)throw Error('TEST_ONLY_AFTER_DURABLE_ACK');return commit(next);};
    assert.throws(()=>t.call(1,'ack',{batch_id:first.batch.batch_id,result:silent}),/TEST_ONLY_AFTER_DURABLE_ACK/);assert.equal(t.inspect(1).state.batch_status[first.batch.batch_id].turn_status,'running');assert.equal(world.state.drafts[first.batch.batch_id].state,'acknowledged');assert.equal(world.state.drafts[first.batch.batch_id].semantic_applied,false);
    t.cold();const laterUntil=new Date(t.now+20000).toISOString(),current=t.item(1,message.message_id);t.gateway.decide(t.handles[1],{sessionId:t.authority(1),args:{inbox_id:current.inbox_id,expectedRevision:current.revision,action:'defer',until:laterUntil}});const revision=t.item(1,message.message_id).revision;
    t.call(1,'complete',{batch_id:first.batch.batch_id,result:silent});assert.equal(t.rooms.recentEvents.state.drafts[first.batch.batch_id].semantic_applied,true);assert.equal(t.inspect(1).state.deferred[id].until_utc,laterUntil);assert.equal(t.inspect(1).state.deferred[id].source,'central-inbox');assert.equal(t.item(1,message.message_id).revision,revision);assert.equal(t.inspect(1).state.handled[id],undefined);
  }finally{await t.close();}
});
