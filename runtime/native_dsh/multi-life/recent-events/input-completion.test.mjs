import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Conversations} from '../platform/conversations.mjs';
import {roomEventId} from './world.mjs';

// Actual canonical Room/Recent SQLite and ledger APIs; no provider or model.
const lives=[{lifeId:'life-TEST-A',authoritySessionId:'TEST-session-A',displayName:'TEST A'},
  {lifeId:'life-TEST-B',authoritySessionId:'TEST-session-B',displayName:'TEST B'}];
const contexts={require:c=>c,registry:{
  life(id){const value=lives.find(life=>life.lifeId===id);if(!value)throw Error('TEST_UNKNOWN_LIFE');return value;},
  assertTarget(lifeId,sessionId){const life=this.life(lifeId);if(sessionId!==life.authoritySessionId)throw Error('TEST_SESSION_OWNER_MISMATCH');return {lifeId,sessionId,role:'authority',status:'ready'};}
}};
const owner={lifeId:lives[1].lifeId,sessionId:lives[1].authoritySessionId},context={...owner,role:'authority'};
const ack=(completed_event_ids=[],extra={})=>({status:'ok',disposition:'silent',actions:[],records:[],completed_event_ids,...extra});
function setup(){
  const root=mkdtempSync(join(tmpdir(),'recent-input-completion-TEST-ONLY-'));let now=Date.parse('2026-10-07T05:00:00Z'),rooms;
  const open=()=>rooms=new Conversations({contexts,root,now:()=>now,tasks:{recentForSession:()=>[],forSession:()=>null}});open();
  const room=rooms.defineRoom({room_id:'TEST-room',participants:lives.map(life=>life.lifeId)});
  const t={root,room,get rooms(){return rooms;},get world(){return rooms.recentEvents;},advance:ms=>now+=ms,
    input:body=>rooms.postForLife({lifeId:lives[0].lifeId,sessionId:lives[0].authoritySessionId,args:{room_id:room.room_id,body}}),
    items:()=>rooms.inboxForLife({lifeId:owner.lifeId,includeTerminal:true,limit:100}).items,
    prepare:wake=>rooms.recentEvents.call(owner,{operation:'prepare',wake_id:owner.sessionId+':'+wake,cutoff_at_utc:new Date(now).toISOString(),trigger_messages:[]}),
    call:(operation,batch,result)=>rooms.recentEvents.call(owner,{operation,batch_id:batch.batch_id,result}),
    fail:batch=>rooms.recentEvents.call(owner,{operation:'fail',batch_id:batch.batch_id,turn_status:'failed',error_code:'TEST_NATIVE_FAILURE'}),
    cold(){rooms.close();open();},close(){rooms.close();rmSync(root,{recursive:true,force:true});}};
  return t;
}

test('empty ACK and successful native finalization retain unfinished inputs across the next real wake',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY unfinished semantic input'),id=roomEventId(t.room.room_id,message.message_id),first=t.prepare('first');
    assert(first.batch.event_ids.includes(id));t.call('ack',first.batch,ack());
    assert.equal(t.items()[0].status,'pending');assert.equal(t.world.store.batchStatus(owner.lifeId,first.batch.batch_id).turn_status,'running');
    t.call('complete',first.batch,ack());assert.equal(t.items()[0].status,'pending');assert.equal(t.world.store.mark(owner.lifeId,id).handled,null);
    const next=t.prepare('next');assert(next.batch.event_ids.includes(id));assert(next.context_state.pending_event_ids.includes(id));
  }finally{t.close();}
});

test('cross-batch explicit completion closes Room and Recent together without rewriting the delivery batch',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY previous input'),id=roomEventId(t.room.room_id,message.message_id),first=t.prepare('first');
    t.call('ack',first.batch,ack());t.advance(1000);
    // An old formally delivered event need not be in the current window/batch.
    let batch=t.world.store.createBatch({life_id:owner.lifeId,authority_session_id:owner.sessionId,wake_id:owner.sessionId+':second',event_ids:[]});
    batch=t.world.store.deliverBatch({life_id:owner.lifeId,batch_id:batch.batch_id,wake_id:batch.wake_id});
    assert.equal(t.world.call(owner,{operation:'validate_ack',batch_id:batch.batch_id,result:ack([id])}).valid,true);
    t.call('ack',batch,ack([id]));assert.equal(t.items()[0].status,'handled');assert(t.world.store.mark(owner.lifeId,id).handled);
    assert.deepEqual(t.world.store.getBatch(owner.lifeId,batch.batch_id).event_ids,[]);
    const revision=t.items()[0].decision_revision,mark=t.world.store.mark(owner.lifeId,id);
    t.cold();const next=t.prepare('third');t.call('ack',next.batch,ack([id]));
    assert.equal(t.items()[0].decision_revision,revision);assert.deepEqual(t.world.store.mark(owner.lifeId,id),mark);
    assert(!t.prepare('fourth').batch.event_ids.includes(id));
  }finally{t.close();}
});

test('read-only validation pinpoints the old ID and preserves every input and record on rejection',()=>{
  const t=setup();try {
    t.input('TEST ONLY pending');const first=t.prepare('first'),before=t.world.store.state;
    const invalid=ack(['TEST-NOT-DELIVERED'],{records:[{key:'TEST-NOT-SAVED',kind:'finding',summary:'TEST ONLY'}]});
    const receipt=t.world.call(owner,{operation:'validate_ack',batch_id:first.batch.batch_id,result:invalid});
    assert.equal(receipt.valid,false);assert.equal(receipt.error.details.field,'completed_event_ids[0]');
    assert.equal(receipt.error.details.event_id,'TEST-NOT-DELIVERED');assert.deepEqual(t.world.store.state,before);
    assert(!t.world.all(owner.lifeId).some(event=>event.payload?.record?.key==='TEST-NOT-SAVED'));
    const state=t.world.call(owner,{operation:'validate_ack',batch_id:first.batch.batch_id,result:ack([],{records:[{key:'TEST-state',kind:'state',summary:'TEST ONLY',state:'done'}]})});
    assert.equal(state.error.details.field,'records[0].state_key');
  }finally{t.close();}
});

test('cross-batch completion rejects unseen, future and foreign-session inputs',()=>{
  const t=setup();try {
    const first=t.prepare('first');
    const late=t.input('TEST ONLY after cutoff');t.world.sync(owner.lifeId,owner.sessionId);
    const future=roomEventId(t.room.room_id,late.message_id);
    const privateEvent=t.world.emit({lifeId:lives[0].lifeId,sessionId:lives[0].authoritySessionId},{source_key:'TEST-private',event_type:'system',body:'TEST ONLY PRIVATE'});
    for(const id of [future,privateEvent.event_id]) {
      const receipt=t.world.call(owner,{operation:'validate_ack',batch_id:first.batch.batch_id,result:ack([id])});assert.equal(receipt.valid,false);
      assert.throws(()=>t.call('ack',first.batch,ack([id])),error=>error.code==='COMPLETED_EVENT_NOT_IN_CURRENT_BATCH');
    }
    assert.equal(t.items()[0].status,'pending');
  }finally{t.close();}
});

test('cross-batch ACK respects a newer explicit continuation and reports its exact input',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY continue input'),id=roomEventId(t.room.room_id,message.message_id);t.prepare('first');t.advance(1000);
    let batch=t.world.store.createBatch({life_id:owner.lifeId,authority_session_id:owner.sessionId,wake_id:owner.sessionId+':second',event_ids:[]});
    batch=t.world.store.deliverBatch({life_id:owner.lifeId,batch_id:batch.batch_id,wake_id:batch.wake_id});
    t.rooms.decide(context,{decision_token:t.items()[0].decision_token,action:'continue'});
    const receipt=t.world.call(owner,{operation:'validate_ack',batch_id:batch.batch_id,result:ack([id])});
    assert.equal(receipt.valid,false);assert.equal(receipt.error.details.event_id,id);assert.equal(receipt.error.details.last_decision,'continue');
    assert.equal(t.items()[0].status,'pending');
  }finally{t.close();}
});

test('redelivery reports its count, prior explicit choice and confirmed reply without consuming input',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY reply input'),id=roomEventId(t.room.room_id,message.message_id),first=t.prepare('first');
    t.rooms.postForLife({...owner,args:{room_id:t.room.room_id,reply_to:message.message_id,body:'TEST ONLY replied'}});
    t.call('ack',first.batch,ack([],{disposition:'acted',records:[{key:'TEST-finding',kind:'finding',summary:'TEST ONLY fact',evidence_event_ids:[id]}]}));
    t.advance(1000);const next=t.prepare('next'),info=next.context_state.delivery_state.find(row=>row.event_id===id);
    assert.equal(info.delivery_count,2);assert.equal(info.last_ack.explicitly_completed,false);assert.deepEqual(info.last_ack.record_keys,['TEST-finding']);
    assert.equal(info.effect_result.status,'confirmed_success');assert.equal(info.input_decision.status,'pending');
    t.rooms.decide(context,{message_ref:{room_id:t.room.room_id,message_id:message.message_id},expectedRevision:t.items()[0].revision,action:'complete'});
    assert(!t.prepare('after-decision').batch.event_ids.includes(id));
  }finally{t.close();}
});

test('explicit ACK completes immediately, while a later native failure remains execution history',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY explicit completion'),id=roomEventId(t.room.room_id,message.message_id),first=t.prepare('first');
    t.call('ack',first.batch,ack([id]));assert.equal(t.items()[0].status,'handled');
    assert.equal(t.world.store.batchStatus(owner.lifeId,first.batch.batch_id).turn_status,'running');t.fail(first.batch);
    const status=t.world.store.batchStatus(owner.lifeId,first.batch.batch_id);assert.equal(status.turn_status,'failed');assert.equal(status.acknowledged,true);assert.deepEqual(status.result.completed_event_ids,[id]);
    assert.equal(t.items()[0].status,'handled');assert.equal(t.world.store.mark(owner.lifeId,id).handled.explicit,true);
    assert(!t.prepare('next').batch.event_ids.includes(id));
  }finally{t.close();}
});

test('ACK validates explicit IDs and defer conflicts before committing any record or decision',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY strict input'),id=roomEventId(t.room.room_id,message.message_id),first=t.prepare('first');
    const records=[{key:'TEST-invalid-ack',kind:'decision',summary:'TEST ONLY must not save'}];
    for(const result of [ack(['TEST-foreign'],{records}),ack([id,id],{records}),
      ack([id],{records,disposition:'deferred',actions:[{type:'defer',event_id:id,until:null}]})])assert.throws(()=>t.call('ack',first.batch,result));
    assert.equal(t.items()[0].status,'pending');assert.equal(t.world.state.drafts[first.batch.batch_id],undefined);
    assert(!t.world.all(owner.lifeId).some(event=>event.payload?.record?.key==='TEST-invalid-ack'));
  }finally{t.close();}
});

test('legacy successful and unknown sends are read back without any effect replay or sticky next-wake choice',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY legacy input'),id=roomEventId(t.room.room_id,message.message_id),first=t.prepare('first');
    const old={status:'ok',disposition:'acted',actions:[{type:'send_message',conversation_id:t.room.room_id,body:'TEST ONLY old success'},
      {type:'send_message',conversation_id:t.room.room_id,body:'TEST ONLY unknown second action'}]};
    t.rooms.postForLife({...owner,args:{room_id:t.room.room_id,message_id:'batch-action:'+first.batch.batch_id+':0',body:old.actions[0].body}});
    t.world.updateDraft(first.batch.batch_id,{life_id:owner.lifeId,session_id:owner.sessionId,state:'prepared',result:old,resolved_targets:[t.room.room_id,t.room.room_id]});t.fail(first.batch);
    const before=t.rooms.readForPrincipal(owner.lifeId,{room_id:t.room.room_id}).messages.length;t.cold();
    const next=t.prepare('next');assert(next.batch.event_ids.includes(id));
    assert.deepEqual(next.context_state.outward_recovery[0].effects.map(effect=>effect.status),['confirmed_success','unknown']);
    const original=t.rooms.postForLife;t.rooms.postForLife=()=>{throw Error('TEST_FORBIDDEN_REPLAY');};
    const result=t.call('complete',first.batch,old);assert.deepEqual(result.effect_results.map(effect=>effect.status),['confirmed_success','unknown']);
    assert.throws(()=>t.call('ack',next.batch,old),/SEND_MESSAGE_USE_NATIVE_TOOL/);
    t.call('ack',next.batch,ack([],{records:[{key:'TEST-independent-new-choice',kind:'decision',summary:'TEST ONLY choose to continue without sending'}]}));
    t.rooms.postForLife=original;assert.equal(t.items()[0].status,'pending');assert.equal(t.rooms.readForPrincipal(owner.lifeId,{room_id:t.room.room_id}).messages.length,before);
  }finally{t.close();}
});

test('durable ACK reconciles its missing Room decision after cold reopen',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY interrupted semantic apply'),id=roomEventId(t.room.room_id,message.message_id),first=t.prepare('first');
    const complete=t.rooms.completeRecentBatch;t.rooms.completeRecentBatch=()=>{throw Error('TEST_ACK_APPLY_CRASH');};
    assert.throws(()=>t.call('ack',first.batch,ack([id])),/TEST_ACK_APPLY_CRASH/);
    assert.equal(t.world.state.drafts[first.batch.batch_id].state,'acknowledged');assert.equal(t.world.state.drafts[first.batch.batch_id].semantic_applied,false);assert.equal(t.items()[0].status,'pending');
    t.rooms.completeRecentBatch=complete;t.cold();const next=t.prepare('next');
    assert.equal(t.items()[0].status,'handled');assert.equal(t.world.state.drafts[first.batch.batch_id].semantic_applied,true);assert(!next.batch.event_ids.includes(id));
  }finally{t.close();}
});

test('recovery of a durable older ACK preserves a later explicit Agent continuation',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY newer continuation'),id=roomEventId(t.room.room_id,message.message_id),first=t.prepare('first');
    const complete=t.rooms.completeRecentBatch;t.rooms.completeRecentBatch=()=>{throw Error('TEST_ACK_APPLY_CRASH');};
    assert.throws(()=>t.call('ack',first.batch,ack([id])),/TEST_ACK_APPLY_CRASH/);t.rooms.completeRecentBatch=complete;
    t.rooms.decide(context,{decision_token:t.items()[0].decision_token,action:'continue'});t.cold();const next=t.prepare('next');
    assert.equal(t.items()[0].status,'pending');assert.equal(t.items()[0].last_decision,'continue');assert(next.batch.event_ids.includes(id));
    assert.equal(t.world.store.mark(owner.lifeId,id).handled,null);assert.equal(t.world.state.drafts[first.batch.batch_id].semantic_applied,true);
  }finally{t.close();}
});

test('central pending overrides implicit old marks; stable health notices preserve the immutable history prefix',()=>{
  const t=setup();try {
    const message=t.input('TEST ONLY PRIVATE source body'),id=roomEventId(t.room.room_id,message.message_id);t.world.sync(owner.lifeId,owner.sessionId);
    const prefix=readFileSync(t.world.store.ledger.file(1));
    t.world.store.control.prepare('INSERT OR REPLACE INTO marks VALUES(?,?,?,?,?)').run(owner.lifeId,id,JSON.stringify({batch_id:'TEST-implicit-old',disposition:'silent'}),null,null);
    t.world.store.control.prepare('DELETE FROM pending WHERE life=? AND event=?').run(owner.lifeId,id);
    t.advance(31*60*1000);const first=t.prepare('first');assert(first.batch.event_ids.includes(id));assert(first.context_state.pending_event_ids.includes(id));
    const notices=t.world.all(owner.lifeId).filter(event=>event.payload?.notice);assert.equal(notices.length,1);assert.equal(Object.hasOwn(notices[0].payload.notice,'age_ms'),false);
    assert.equal(notices[0].payload.scope_session_id,owner.sessionId);assert(!JSON.stringify(notices).includes(message.body));
    t.advance(1000);t.prepare('second');assert.equal(t.world.all(owner.lifeId).filter(event=>event.payload?.notice).length,1);
    assert(readFileSync(t.world.store.ledger.file(1)).subarray(0,prefix.length).equals(prefix));
    assert.equal(t.world.store.mark(owner.lifeId,id).handled,null);
  }finally{t.close();}
});
