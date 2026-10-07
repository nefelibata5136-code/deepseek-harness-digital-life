import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Conversations} from './conversations.mjs';

// Direct storage/API tests. No provider, Agent wake, formal life, or transport.
const A={lifeId:'life-TEST-A',authoritySessionId:'session-TEST-A',displayName:'TEST A'};
const B={lifeId:'life-TEST-B',authoritySessionId:'session-TEST-B',displayName:'TEST B'};
const contexts={
  require:context=>context,
  registry:{
    life(id){const value=[A,B].find(life=>life.lifeId===id);if(!value)throw Error('UNKNOWN_LIFE');return value;},
    assertTarget(lifeId,sessionId){const life=this.life(lifeId);if(![life.authoritySessionId,life.authoritySessionId+'-activity'].includes(sessionId))throw Error('SESSION_OWNER_MISMATCH');return {lifeId,sessionId,status:'ready',role:sessionId.endsWith('-activity')?'activity':'authority'};}
  }
};
const context=life=>({lifeId:life.lifeId,sessionId:life.authoritySessionId,role:'authority'});
function setup() {
  const root=mkdtempSync(join(tmpdir(),'conversation-truth-unit-'));let now=Date.parse('2026-10-07T05:00:00Z'),rooms;
  const open=()=>rooms=new Conversations({contexts,root,now:()=>now});open();
  const room=rooms.defineRoom({room_id:'room-TEST',participants:[A.lifeId,B.lifeId]});
  return {root,room,get rooms(){return rooms;},open,setNow:value=>now=value,
    send:body=>rooms.postForLife({lifeId:A.lifeId,sessionId:A.authoritySessionId,args:{room_id:room.room_id,body}}),
    items:()=>rooms.inboxForLife({lifeId:B.lifeId,includeTerminal:true,limit:100}).items,
    select(items){return rooms.selectWorkerBatch({lifeId:B.lifeId,sessionId:B.authoritySessionId,items:items.map(item=>({inbox_id:item.inbox_id,expectedRevision:item.revision}))});},
    reconcile(item,batch,evidence){return rooms.reconcileWorkerDelivery({lifeId:B.lifeId,sessionId:B.authoritySessionId,inbox_id:item.inbox_id,attempt_id:batch.attempt.attempt_id,evidence});},
    reply(message,body='TEST reply'){return rooms.postForLife({lifeId:B.lifeId,sessionId:B.authoritySessionId,args:{room_id:room.room_id,reply_to:message.message_id,body}});},
    close(){rooms.close();rmSync(root,{recursive:true,force:true});}
  };
}
function state(root) {const db=new DatabaseSync(join(root,'rooms.sqlite'),{readOnly:true});try{return JSON.parse(db.prepare('SELECT data FROM conversation_state').get().data);}finally{db.close();}}
const receipt=(t,args={})=>t.rooms.actionResultForLife({lifeId:B.lifeId,sessionId:B.authoritySessionId,room_id:t.room.room_id,...args});

test('send is the only reply action; send and semantic complete remain separate, including legacy reply lookup',()=>{
  const t=setup();try {
    const message=t.send('TEST input'),before=t.items()[0];
    assert.throws(()=>t.rooms.decide(context(B),{decision_token:before.decision_token,action:'reply',body:'TEST reply'}),/REPLY_USE_SEND_MESSAGE/);
    const sent=t.reply(message),after=t.items()[0];
    assert.equal(sent.effect_result.status,'confirmed_success');assert.equal(sent.inbox_status,'pending');
    assert.equal(after.status,'pending');assert.equal(after.effect_result.message_id,sent.message_id);assert.equal(after.effect_result.status,'confirmed_success');
    assert.equal(t.rooms.decide(context(B),{decision_token:before.decision_token,action:'reply',body:'TEST reply'}).status,'pending');
    assert.throws(()=>t.rooms.decide(context(B),{decision_token:after.decision_token,action:'reply',body:'TEST other reply'}),/REPLY_USE_SEND_MESSAGE/);
    const done=t.rooms.decide(context(B),{decision_token:before.decision_token,action:'complete'});
    assert.equal(done.status,'handled');assert.equal(done.last_decision,'complete');assert(done.decision_at);
    assert.equal(t.rooms.inboxForLife({lifeId:B.lifeId}).items.length,0);
    assert.equal(t.reply(message).message_id,sent.message_id);assert.equal(t.items()[0].status,'handled');
    assert.throws(()=>t.reply(message,'TEST changed reply'),/REPLY_ALREADY_COMMITTED/);
  }finally{t.close();}
});

test('successful or empty ACK does not swallow inputs; only explicit owned completed_event_ids do',()=>{
  const t=setup();try {
    const messages=[t.send('TEST first'),t.send('TEST second')],items=t.items(),batch=t.select(items);
    const events=messages.map((message,index)=>({event_id:'event-TEST-'+index,event_type:'communication',conversation_id:t.room.room_id,payload:{message_id:message.message_id}}));
    const recent={batch_id:'batch-TEST',events};
    t.rooms.completeRecentBatch({lifeId:B.lifeId,sessionId:B.authoritySessionId,batch:recent,result:{status:'ok',disposition:'acted',actions:[]}});
    assert(t.items().every(item=>item.status==='pending'));
    for(const item of items)t.reconcile(item,batch,{state:'completed',machine_ack:true,action_result:{status:'ok',disposition:'acted'}});
    assert(t.items().every(item=>item.status==='pending'));
    t.rooms.completeRecentBatch({lifeId:B.lifeId,sessionId:B.authoritySessionId,batch:recent,result:{status:'ok',disposition:'acted',completed_event_ids:['event-TEST-0','not-owned']}});
    assert.deepEqual(t.items().map(item=>item.status),['handled','pending']);
    const closed=t.items()[0];t.rooms.acknowledgeWorkerBatchDelivery({lifeId:B.lifeId,sessionId:B.authoritySessionId,inbox_ids:[closed.inbox_id],attempt_id:batch.attempt.attempt_id});
    assert.equal(t.items()[0].attempt.state,'completed');assert.equal(t.items()[0].status,'handled');
  }finally{t.close();}
});

test('atomic SQLite failure leaves both Room message and reply receipt unchanged in memory and on disk',()=>{
  const t=setup();let fault;try {
    const message=t.send('TEST input'),before=t.items()[0],snapshot=state(t.root);
    fault=new DatabaseSync(join(t.root,'rooms.sqlite'));
    fault.exec("CREATE TRIGGER TEST_write_failure BEFORE UPDATE ON conversation_state BEGIN SELECT RAISE(ABORT,'TEST_ATOMIC_FAILURE'); END;");
    assert.throws(()=>t.reply(message),error=>error.code==='ROOM_ACTION_NOT_COMMITTED'&&error.effect_result.status==='confirmed_failure'&&error.effect_result.committed===false&&/TEST_ATOMIC_FAILURE/.test(error.cause.message));
    assert.deepEqual(t.items()[0],before);assert.deepEqual(state(t.root),snapshot);
    assert.equal(t.rooms.readForPrincipal(B.lifeId,{room_id:t.room.room_id}).messages.length,1);
    fault.exec('DROP TRIGGER TEST_write_failure;');fault.close();fault=null;
    const sent=t.reply(message);assert.equal(sent.effect_result.status,'confirmed_success');assert.equal(t.items()[0].status,'pending');
    assert.equal(t.rooms.readForPrincipal(B.lifeId,{room_id:t.room.room_id}).messages.length,2);
  }finally{fault?.close();t.close();}
});

test('lost send ACK is recovered by actual Room readback and identical send is a zero-write replay after reopen',()=>{
  const t=setup();try {
    const message=t.send('TEST input'),before=t.items()[0],sent=t.reply(message);
    t.rooms.close();t.open();
    const result=receipt(t,{inbox_id:before.inbox_id});assert.equal(result.status,'confirmed_success');assert.equal(result.message_id,sent.message_id);
    const revision=state(t.root).inbox[before.inbox_id].revision;
    assert.equal(t.reply(message).message_id,sent.message_id);
    assert.equal(state(t.root).inbox[before.inbox_id].revision,revision);
    assert.equal(t.rooms.readForPrincipal(B.lifeId,{room_id:t.room.room_id}).messages.filter(message=>message.reply_to).length,1);
    assert(!Object.hasOwn(result,'body'));assert(!Object.hasOwn(result,'message'));
  }finally{t.close();}
});

test('native call identity makes ordinary sends idempotent; owner/scope protects action readback',()=>{
  const t=setup();try {
    const args={room_id:t.room.room_id,body:'TEST ordinary action'},send=()=>t.rooms.postForLife({lifeId:B.lifeId,sessionId:B.authoritySessionId,args,callId:'call-TEST-1'});
    const first=send(),second=send();assert.equal(first.message_id,'native-send:'+B.lifeId+':'+B.authoritySessionId+':call-TEST-1');assert.equal(second.message_id,first.message_id);
    assert.equal(receipt(t,{message_id:first.message_id}).status,'confirmed_success');
    assert.equal(t.rooms.readForPrincipal(A.lifeId,{room_id:t.room.room_id}).messages.length,1);
    assert.throws(()=>t.rooms.actionResultForLife({lifeId:A.lifeId,sessionId:B.authoritySessionId,room_id:t.room.room_id,message_id:first.message_id}),/SESSION_OWNER_MISMATCH/);
    assert.equal(t.rooms.actionResultForLife({lifeId:A.lifeId,sessionId:A.authoritySessionId,room_id:t.room.room_id,message_id:first.message_id}).status,'unknown');
    assert.throws(()=>t.rooms.actionResultForLife({lifeId:B.lifeId,room_id:'room-unowned'}),/CONVERSATION_NOT_VISIBLE/);
    const activity=B.authoritySessionId+'-activity',message=t.rooms.postForLife({lifeId:B.lifeId,sessionId:activity,args:{room_id:t.room.room_id,body:'TEST activity effect'},callId:'call-TEST-activity'});
    assert.equal(t.rooms.actionResultForLife({lifeId:B.lifeId,sessionId:activity,room_id:t.room.room_id,message_id:message.message_id}).status,'confirmed_success');
  }finally{t.close();}
});

test('no action is distinct from missing known reference; absent message is never assumed failure',()=>{
  const t=setup();try {
    const message=t.send('TEST no action'),item=t.items()[0];
    assert.equal(item.effect_result.status,'no_action');assert.equal(receipt(t,{inbox_id:item.inbox_id}).status,'no_action');
    assert.equal(receipt(t,{message_id:'effect-TEST-missing',reply_to:message.message_id}).status,'unknown');
    assert.throws(()=>receipt(t,{inbox_id:item.inbox_id,reply_to:'wrong-target'}),/ACTION_RESULT_REFERENCE_CONFLICT/);
  }finally{t.close();}
});

test('one stable native batch resumes after admission and explicit request provenance is retained accurately',()=>{
  const t=setup();try {
    t.send('TEST auto');t.send('TEST explicit');let items=t.items();
    t.rooms.decide(context(B),{decision_token:items[1].decision_token,action:'process'});items=t.items();
    const selected=t.select(items);assert.deepEqual(selected.attempt.requested_inbox_ids,[items[1].inbox_id]);assert.deepEqual(selected.native_message.source.requested_inbox_ids,[items[1].inbox_id]);
    assert(t.items().every(item=>item.requested===false&&item.status==='pending'));
    t.rooms.acknowledgeWorkerBatchDelivery({lifeId:B.lifeId,sessionId:B.authoritySessionId,inbox_ids:items.map(item=>item.inbox_id),attempt_id:selected.attempt.attempt_id});
    const resumed=t.select(t.items());assert.deepEqual(resumed.native_message,selected.native_message);assert.equal(resumed.attempt.request_id,selected.attempt.request_id);assert.equal(resumed.attempt.state,'pending');
    t.rooms.close();t.open();const cold=t.select(t.items());assert.equal(cold.native_message.id,selected.native_message.id);
    assert.deepEqual(cold.attempt.requested_inbox_ids,[items[1].inbox_id]);assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,0);
  }finally{t.close();}
});

test('failed native execution remains history while an actual successful effect stays successful',()=>{
  const t=setup();try {
    const message=t.send('TEST input'),item=t.items()[0],batch=t.select([item]),sent=t.reply(message);
    const observed=t.reconcile(item,batch,{state:'failed',side_effects:false,assistant_committed:true,retryable:true,effect_results:[{call_id:'call-TEST',status:'confirmed_success'}],error_code:'TRANSPORT'});
    assert.equal(observed.status,'pending');assert.equal(observed.attempt.state,'failed');assert.equal(observed.attempt.retryable,false);
    assert(!Object.hasOwn(observed.attempt.native_evidence,'side_effects'));assert.equal(observed.effect_result.status,'confirmed_success');assert.equal(observed.effect_result.message_id,sent.message_id);
    assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,0);
    t.rooms.decide(context(B),{decision_token:observed.decision_token,action:'complete'});
    const finished=t.items()[0];t.reconcile(item,batch,{state:'pending'});
    assert.equal(t.items()[0].status,'handled');assert.equal(t.items()[0].attempt.state,'failed');assert.equal(t.items()[0].revision,finished.revision);
  }finally{t.close();}
});

test('unsettled terminal attempt can reconcile without reopening the semantic input',()=>{
  const t=setup();try {
    t.send('TEST input');const item=t.items()[0],batch=t.select([item]);
    t.rooms.decide(context(B),{decision_token:item.decision_token,action:'complete'});
    const view=t.rooms.inboxForLife({lifeId:B.lifeId,includeUnsettledTerminal:true});assert.equal(view.items.length,1);assert.equal(view.items[0].attempt.attempt_id,batch.attempt.attempt_id);
    t.reconcile(item,batch,{state:'failed',pre_input:true,error_code:'MODEL_PREPARATION_FAILED',retryable:false});
    assert.equal(t.items()[0].status,'handled');assert.equal(t.items()[0].attempt.state,'failed');
    assert.equal(t.rooms.inboxForLife({lifeId:B.lifeId,includeUnsettledTerminal:true}).items.length,0);
  }finally{t.close();}
});

test('safe no-dispatch failure retries at most three times with stable backoff; completed turns stay pending',()=>{
  const t=setup();try {
    t.send('TEST input');let item=t.items()[0];
    for(let count=1;count<=4;count++) {
      const batch=t.select([item]),failure={state:'failed',no_effect_dispatch_proven:true,assistant_committed:false,retryable:true,error_code:'TRANSPORT'};
      item=t.reconcile(item,batch,failure);const revision=item.revision,backoff=item.attempt.retry_after;
      assert.equal(item.status,'pending');assert.equal(item.attempt.retry_count,count);assert.equal(item.attempt.retryable,count<=3);
      assert.equal(t.reconcile(item,batch,failure).revision,revision);assert.equal(t.items()[0].attempt.retry_after,backoff);
      if(count<=3){assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,0);t.setNow(Date.parse(backoff)+1);assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,1);}
    }
    assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,0);assert.equal(t.items()[0].previous_attempts.length,3);
    const continued=t.rooms.decide(context(B),{decision_token:item.decision_token,action:'continue'});assert.equal(continued.status,'pending');assert.equal(continued.requested,false);
    const requested=t.rooms.decide(context(B),{decision_token:continued.decision_token,action:'process'}),last=t.select([requested]);
    t.reconcile(requested,last,{state:'completed',machine_ack:true,action_result:{status:'ok'}});assert.equal(t.items()[0].status,'pending');assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,0);
  }finally{t.close();}
});

test('failure after dispatch is retained for reconciliation and never an automatic retry',()=>{
  const t=setup();try {
    t.send('TEST input');const item=t.items()[0],batch=t.select([item]);
    t.rooms.failWorkerDelivery({lifeId:B.lifeId,sessionId:B.authoritySessionId,inbox_id:item.inbox_id,attempt_id:batch.attempt.attempt_id,error_code:'LOST_ACK'});
    assert.equal(t.items()[0].status,'pending');assert.equal(t.items()[0].attempt.state,'ambiguous');assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,0);
    assert(t.items()[0].health_notes.some(note=>note.code==='RECOVERY_RECONCILE_BLOCKED'));
    assert.deepEqual(t.rooms.processRequested(),{accepted:false,reason:'NATIVE_INBOX_BATCH_REQUIRED'});
  }finally{t.close();}
});

test('defer remains an Agent decision and its expiry requests reconsideration without deleting execution history',()=>{
  const t=setup();try {
    t.send('TEST input');const item=t.items()[0],batch=t.select([item]);t.reconcile(item,batch,{state:'completed'});
    const current=t.items()[0],until='2026-10-07T05:01:00.000Z';t.rooms.decide(context(B),{decision_token:current.decision_token,action:'defer',until});
    assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,0);t.setNow(Date.parse(until)+1);assert.deepEqual(t.rooms.refreshDeferred({lifeId:B.lifeId}),{reopened:1});
    const reopened=t.items()[0];assert.equal(reopened.status,'pending');assert.equal(reopened.requested,true);assert.equal(reopened.attempt.state,'completed');
    const next=t.select([reopened]);assert.deepEqual(next.attempt.requested_inbox_ids,[reopened.inbox_id]);assert.equal(t.items()[0].previous_attempts[0].state,'completed');
  }finally{t.close();}
});

test('schema2 migration preserves every input ID, epoch, reply, attempt history and exact JSON bytes',()=>{
  const t=setup(),target=mkdtempSync(join(tmpdir(),'conversation-migrate-unit-'));let migrated;try {
    const statuses=['queued','requested','processing','admitted','needs_review','failed','replied','handled','ignored','deferred','revoked','handled'];
    for(const status of statuses)t.send('TEST old '+status);
    const items=t.items();t.reply(items[6].message);
    const old=state(t.root);old.schemaVersion=2;
    for(const [index,item] of Object.values(old.inbox).filter(item=>item.owner_life_id===B.lifeId).entries()) {
      item.status=statuses[index];delete item.requested;
      item.attempt={attempt_id:'old-attempt-'+index,session_id:B.authoritySessionId,state:'failed',native_evidence:{state:'failed',side_effects:false}};
      item.previous_attempts=[{attempt_id:'older-attempt-'+index,state:'completed',native_evidence:{side_effects:true}}];
    }
    const bytes=JSON.stringify(old,null,2)+'\n';writeFileSync(join(target,'rooms.json'),bytes);
    migrated=new Conversations({contexts,root:target,migrationMarks:{[items[11].inbox_id]:{explicit:true,decision:'complete'}}});
    const actual=state(target);
    assert.deepEqual(Object.keys(actual.inbox),Object.keys(old.inbox));
    for(const id of Object.keys(old.inbox)) {
      const before=old.inbox[id],after=actual.inbox[id];assert.equal(after.message_id,before.message_id);assert.equal(after.membership_epoch,before.membership_epoch);assert.equal(after.reply_message_id,before.reply_message_id);
      if(before.owner_life_id!==B.lifeId)continue;
      assert.equal(after.attempt.attempt_id,before.attempt.attempt_id);assert.equal(after.attempt.state,'failed');assert.equal(after.previous_attempts[0].attempt_id,before.previous_attempts[0].attempt_id);
      assert(!Object.hasOwn(after.attempt.native_evidence,'side_effects'));assert(!Object.hasOwn(after.previous_attempts[0].native_evidence,'side_effects'));
    }
    assert.deepEqual(Object.values(actual.inbox).filter(item=>item.owner_life_id===B.lifeId).map(item=>item.status),['pending','pending','pending','pending','pending','pending','pending','pending','ignored','deferred','revoked','handled']);
    assert.equal(actual.inbox[items[1].inbox_id].requested,true);assert.equal(actual.inbox[items[7].inbox_id].migration.reason,'implicit-old-ack');
    assert.equal(migrated.inboxForLife({lifeId:B.lifeId,includeTerminal:true,limit:100}).items.find(item=>item.inbox_id===items[6].inbox_id).effect_result.status,'confirmed_success');
    assert.equal(readFileSync(join(target,'rooms.json'),'utf8'),bytes);
    const archive=readdirSync(target).find(name=>name.startsWith('rooms-import-'));assert.equal(readFileSync(join(target,archive),'utf8'),bytes);
    assert(actual.input_truth_migration.changes.some(change=>change.execution_history?.some(history=>history.legacy_tool_call_heuristic===false)));
    const origin=actual.inbox[items[7].inbox_id].migration;
    migrated.close();writeFileSync(join(target,'rooms.json'),'untrusted later legacy bytes');migrated=new Conversations({contexts,root:target});
    assert.deepEqual(state(target).inbox[items[7].inbox_id].migration,origin);
  }finally{migrated?.close();rmSync(target,{recursive:true,force:true});t.close();}
});

test('migrated received replies without attempts remain visible pending and never selected as new paid work',()=>{
  const t=setup(),target=mkdtempSync(join(tmpdir(),'conversation-no-loop-unit-'));let migrated;try {
    const message=t.send('TEST old reply');t.reply(message);const old=state(t.root),item=Object.values(old.inbox).find(item=>item.owner_life_id===B.lifeId);
    old.schemaVersion=2;item.status='replied';item.attempt=null;writeFileSync(join(target,'rooms.json'),JSON.stringify(old));
    migrated=new Conversations({contexts,root:target});const current=migrated.inboxForLife({lifeId:B.lifeId}).items[0];
    assert.equal(current.status,'pending');assert.equal(current.effect_result.status,'confirmed_success');assert.equal(migrated.deliveryCandidates({lifeId:B.lifeId}).length,0);
    migrated.decide(context(B),{decision_token:current.decision_token,action:'process'});assert.equal(migrated.deliveryCandidates({lifeId:B.lifeId}).length,1);
  }finally{migrated?.close();rmSync(target,{recursive:true,force:true});t.close();}
});

test('migrated old delivery states without native attempt evidence are not new inputs for paid auto delivery',()=>{
  const t=setup(),target=mkdtempSync(join(tmpdir(),'conversation-unproven-delivery-unit-'));let migrated;try {
    const statuses=['admitted','processing','needs_review','failed','handled','queued'];
    statuses.forEach(status=>t.send('TEST old '+status));const old=state(t.root);old.schemaVersion=2;
    Object.values(old.inbox).forEach((item,index)=>{item.status=statuses[index];item.attempt=null;});writeFileSync(join(target,'rooms.json'),JSON.stringify(old));
    migrated=new Conversations({contexts,root:target});const items=migrated.inboxForLife({lifeId:B.lifeId}).items;
    assert.equal(items.length,6);assert(items.every(item=>item.status==='pending'));
    assert.deepEqual(migrated.deliveryCandidates({lifeId:B.lifeId}).map(item=>item.inbox_id),[items[5].inbox_id]);
    const requested=migrated.decide(context(B),{decision_token:items[0].decision_token,action:'process'});
    assert.equal(requested.requested,true);assert(migrated.deliveryCandidates({lifeId:B.lifeId}).some(item=>item.inbox_id===requested.inbox_id));
  }finally{migrated?.close();rmSync(target,{recursive:true,force:true});t.close();}
});

test('known missing receipt cannot be blindly resent and contradiction/unknown notices carry only metadata',()=>{
  const t=setup(),target=mkdtempSync(join(tmpdir(),'conversation-unknown-unit-'));let migrated;try {
    const message=t.send('TEST input'),old=state(t.root),item=Object.values(old.inbox)[0];old.schemaVersion=2;item.status='replied';item.reply_message_id='missing-known-effect';
    item.reply_body_hash=createHash('sha256').update('TEST reply').digest('hex');item.updated_at='2026-10-07T04:00:00Z';
    item.reply_receipt={status:'confirmed_success',message_id:item.reply_message_id,body_hash:item.reply_body_hash,room_id:t.room.room_id,observed_at:item.updated_at};
    writeFileSync(join(target,'rooms.json'),JSON.stringify(old));migrated=new Conversations({contexts,root:target,now:()=>Date.parse('2026-10-07T05:00:00Z')});
    const current=migrated.inboxForLife({lifeId:B.lifeId}).items[0];assert.equal(current.effect_result.status,'unknown');
    assert(current.health_notes.some(note=>note.code==='ACTION_RESULT_CONTRADICTION'));assert(current.health_notes.some(note=>note.code==='SIDE_EFFECT_UNKNOWN'));
    assert(current.health_notes.every(note=>!Object.hasOwn(note,'body')));
    assert.throws(()=>migrated.postForLife({lifeId:B.lifeId,sessionId:B.authoritySessionId,args:{room_id:t.room.room_id,reply_to:message.message_id,body:'TEST reply'}}),/REPLY_OUTCOME_UNKNOWN/);
  }finally{migrated?.close();rmSync(target,{recursive:true,force:true});t.close();}
});

test('Recent Room index and cursor project only the appended authorized suffix; health stays read-only',()=>{
  const t=setup();try {
    const first=t.send('TEST first'),second=t.send('TEST second');
    assert.deepEqual(t.rooms.recentMessageSources(B.lifeId,B.authoritySessionId,{after:first.timeline_seq}).map(source=>source.message.message_id),[second.message_id]);
    t.rooms.recentEvents.sync(B.lifeId,B.authoritySessionId);
    const third=t.send('TEST third');
    assert.deepEqual(t.rooms.recentEvents.sync(B.lifeId,B.authoritySessionId).map(source=>source.message.message_id),[third.message_id]);
    assert.deepEqual(t.rooms.recentEvents.sync(B.lifeId,B.authoritySessionId),[]);
    const lookup=t.rooms.recentMessageById(B.lifeId,B.authoritySessionId,[third.message_id,first.message_id]);
    assert.deepEqual(lookup.map(source=>source.message.message_id),[third.message_id,first.message_id]);
    const before=state(t.root);t.setNow(Date.parse('2026-10-07T06:00:00Z'));
    const notes=t.rooms.healthForLife({lifeId:B.lifeId,sessionId:B.authoritySessionId});
    assert.equal(notes.filter(note=>note.code==='INPUT_PENDING_TOO_LONG').length,3);assert(notes.every(note=>note.owner_life_id===B.lifeId&&!Object.hasOwn(note,'body')));
    assert.deepEqual(state(t.root),before);
    const current=t.items()[0];t.rooms.decide(context(B),{decision_token:current.decision_token,action:'continue'});
    assert(!t.rooms.healthForLife({lifeId:B.lifeId}).some(note=>note.inbox_id===current.inbox_id&&note.code==='INPUT_PENDING_TOO_LONG'));
  }finally{t.close();}
});

test('native human save-before-prompt creates one stable pending input, retains ingress proof and does not auto wake it',()=>{
  const t=setup();try {
    t.rooms.registerHuman({sender_id:'human:TEST',display_name:'TEST HUMAN'});
    const room=t.rooms.defineRoom({room_id:'room-human-TEST',participants:['human:TEST',B.lifeId]}),args={room_id:room.room_id,message_id:'human-request-TEST-1',body:'TEST human input'};
    const record=()=>t.rooms.recordHumanTimeline({principalId:'human:TEST',lifeId:B.lifeId,sessionId:B.authoritySessionId,requestId:args.message_id,args,occurredAt:'2026-10-07T04:59:00.000Z'});
    const first=record(),item=t.items()[0];assert.equal(item.status,'pending');assert.equal(item.attempt,null);assert(item.inbox_id.startsWith('inbox-human:'));
    assert.deepEqual(item.native_ingress,{session_id:B.authoritySessionId,request_id:args.message_id});assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId,human_idle:true}).length,0);
    assert.equal(record().inbox_id,first.inbox_id);assert.equal(t.items().length,1);t.rooms.close();t.open();
    const pending=t.rooms.recentInboxItems(B.lifeId,B.authoritySessionId);assert.equal(pending.length,1);assert.equal(pending[0].inbox_id,item.inbox_id);assert.equal(pending[0].status,'pending');assert.equal(pending[0].attempt,null);
    assert.equal(t.rooms.readForPrincipal(B.lifeId,{room_id:room.room_id}).messages.length,1);
    assert.throws(()=>t.rooms.recordHumanTimeline({principalId:'human:TEST',lifeId:B.lifeId,sessionId:B.authoritySessionId,requestId:'different-request',args}),/NATIVE_HUMAN_REFERENCE_CONFLICT/);
  }finally{t.close();}
});

test('legacy real human messages missing central rows migrate only for authorized recipients, with stable IDs and no automatic delivery',()=>{
  const t=setup(),target=mkdtempSync(join(tmpdir(),'human-backfill-unit-'));let migrated;try {
    t.rooms.registerHuman({sender_id:'human:TEST',display_name:'TEST HUMAN'});
    const room=t.rooms.defineRoom({room_id:'room-human-TEST',participants:['human:TEST',B.lifeId]}),args={room_id:room.room_id,message_id:'human-request-TEST-2',body:'TEST legacy human input'};
    t.rooms.recordHumanTimeline({principalId:'human:TEST',lifeId:B.lifeId,args});
    const actual=t.rooms.postForLife({lifeId:B.lifeId,sessionId:B.authoritySessionId,args:{room_id:room.room_id,reply_to:args.message_id,body:'TEST existing historic reply'}});
    const item=t.items()[0],old=state(t.root);delete old.inbox[item.inbox_id];old.schemaVersion=2;
    // Current membership alone cannot widen the immutable original audience.
    old.rooms[room.room_id].members.push({principalId:A.lifeId,epoch:'TEST-later-membership',firstVisibleSeq:1,removedAt:null,joinedAt:'2026-10-07T05:00:00Z'});old.rooms[room.room_id].roomType='group';
    const bytes=JSON.stringify(old);writeFileSync(join(target,'rooms.json'),bytes);migrated=new Conversations({contexts,root:target});
    const restored=migrated.inboxForLife({lifeId:B.lifeId}).items[0];assert.equal(restored.inbox_id,item.inbox_id);assert.equal(restored.status,'pending');assert.equal(restored.attempt,null);
    assert.equal(restored.migration.from_status,'native-human-history');assert.equal(restored.migration.already_delivered,'unknown');assert.equal(restored.migration.auto_delivery,false);
    assert.equal(restored.effect_result.status,'confirmed_success');assert.equal(restored.effect_result.message_id,actual.message_id);
    assert.equal(migrated.deliveryCandidates({lifeId:B.lifeId,human_idle:true}).length,0);assert.equal(migrated.inboxForLife({lifeId:A.lifeId}).items.length,0);assert.equal(readFileSync(join(target,'rooms.json'),'utf8'),bytes);
    migrated.close();migrated=new Conversations({contexts,root:target});assert.equal(migrated.inboxForLife({lifeId:B.lifeId}).items[0].inbox_id,item.inbox_id);assert.equal(Object.keys(state(target).inbox).length,1);
  }finally{migrated?.close();rmSync(target,{recursive:true,force:true});t.close();}
});

test('existing schema3 missing-human repair is idempotent and does not fabricate a completed native attempt',()=>{
  const t=setup();let db;try {
    t.rooms.registerHuman({sender_id:'human:TEST',display_name:'TEST HUMAN'});const room=t.rooms.defineRoom({room_id:'room-human-TEST',participants:['human:TEST',B.lifeId]});
    t.rooms.recordHumanTimeline({principalId:'human:TEST',lifeId:B.lifeId,args:{room_id:room.room_id,message_id:'human-request-TEST-3',body:'TEST schema3 interrupted migration'}});
    const original=t.items()[0],old=state(t.root);delete old.inbox[original.inbox_id];t.rooms.close();db=new DatabaseSync(join(t.root,'rooms.sqlite'));db.prepare('UPDATE conversation_state SET revision=revision+1,data=?').run(JSON.stringify(old));db.close();db=null;t.open();
    const restored=t.items()[0];assert.equal(restored.inbox_id,original.inbox_id);assert.equal(restored.status,'pending');assert.equal(restored.attempt,null);assert.equal(restored.native_ingress,undefined);
    assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,0);const after=state(t.root);t.rooms.close();t.open();assert.deepEqual(state(t.root),after);
  }finally{db?.close();t.close();}
});

test('confirmed interrupted-before-effect execution retries under the same bounded policy while semantic input remains pending',()=>{
  const t=setup();try {
    t.send('TEST interrupted continuation');let item=t.items()[0];
    for(let count=1;count<=4;count++) {
      const batch=t.select([item]);item=t.reconcile(item,batch,{state:'interrupted',retryable:true,no_effect_dispatch_proven:true,assistant_committed:false,error_code:'NATIVE_TURN_INTERRUPTED_BEFORE_EFFECT'});
      assert.equal(item.status,'pending');assert.equal(item.attempt.retry_count,count);assert.equal(item.attempt.retryable,count<=3);
      if(count<=3)t.setNow(Date.parse(item.attempt.retry_after)+1);
    }
    assert.equal(t.rooms.deliveryCandidates({lifeId:B.lifeId}).length,0);assert.deepEqual(t.items()[0].previous_attempts.map(attempt=>attempt.state),['interrupted','interrupted','interrupted']);
  }finally{t.close();}
});
