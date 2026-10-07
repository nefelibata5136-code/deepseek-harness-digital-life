import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {migrateInputTruth,roomEffectResult,inputHealth} from './input-truth.mjs';
const body='private reply';
const bodyHash=createHash('sha256').update(body).digest('hex');
const input=(status='admitted')=>({inbox_id:'input-1',owner_life_id:'life-a',room_id:'room-a',message_id:'source-1',membership_epoch:'epoch-1',status,
  received_at:'2026-10-07T00:00:00Z',updated_at:'2026-10-07T00:01:00Z',reply_message_id:null,attempt:{attempt_id:'attempt-1',state:'failed',native_evidence:{turn:1,side_effects:false}}});
const rooms={ 'room-a':{conversationId:'room-a',messages:[{messageId:'reply-1',conversationId:'room-a',senderPrincipalId:'life-a',replyTo:'source-1',body,bodyHash}]}};

test('migration keeps every input and execution history, and never calls a reply semantic completion',()=>{
  const statuses=['queued','requested','processing','admitted','needs_review','failed','replied','handled','ignored','deferred','revoked'];
  const source={schemaVersion:2,inbox:Object.fromEntries(statuses.map(status=>[status,{...input(status),inbox_id:status,reply_message_id:status==='replied'?'reply-1':null}]))};
  const before=structuredClone(source),result=migrateInputTruth(source);
  assert.deepEqual(source,before);assert.equal(Object.keys(result.state.inbox).length,statuses.length);
  for(const status of statuses){const value=result.state.inbox[status];assert.equal(value.status,['ignored','deferred','revoked'].includes(status)?status:'pending');
    assert.equal(value.membership_epoch,'epoch-1');assert.equal(value.attempt.state,'failed');assert.equal(Object.hasOwn(value.attempt.native_evidence,'side_effects'),false);}
  assert.equal(result.state.inbox.requested.requested,true);assert.equal(result.state.inbox.replied.reply_message_id,'reply-1');
  assert.equal(result.state.inbox.replied.migration.from_status,'replied');
  assert.equal(result.provenance.find(row=>row.inbox_id==='handled').reason,'implicit-old-ack');
  assert.deepEqual(migrateInputTruth(result.state).state,result.state);
});
test('a migrated old reply without an attempt retains its origin and does not invent native execution',()=>{
  const source={schemaVersion:2,inbox:{a:{...input('replied'),attempt:null,reply_message_id:'reply-1'}}};
  const first=migrateInputTruth(source);
  assert.equal(first.state.inbox.a.status,'pending');assert.equal(first.state.inbox.a.attempt,null);
  assert.deepEqual(first.state.inbox.a.migration,{from_status:'replied',reason:'reply-is-effect-not-completion'});
  assert.equal(first.state.inbox.a.requested,false);assert.deepEqual(migrateInputTruth(first.state).state,first.state);
});
test('only explicit Agent marks establish completion; repeat migration is idempotent',()=>{
  const source={schemaVersion:2,inbox:{a:input('handled'),b:{...input('replied'),inbox_id:'input-2',message_id:'source-2'}}};
  const first=migrateInputTruth(source,{marks:{'input-1':{explicit:true,decision:'complete'},'source-2':{explicit:true,decision:'defer',until:null}}});
  assert.equal(first.state.inbox.a.status,'handled');assert.equal(first.state.inbox.b.status,'deferred');
  // Schema 3's handled records already represent a completed semantic decision.
  const second=migrateInputTruth(first.state,{marks:{'input-1':{explicit:true,decision:'complete'},'source-2':{explicit:true,decision:'defer',until:null}}});
  assert.deepEqual(first.state,second.state);
});
test('a later successful reply is objective success even when the original delivery attempt failed',()=>{
  const i={...input('replied'),reply_message_id:'reply-1',reply_body_hash:bodyHash};
  const result=roomEffectResult(i,rooms);assert.equal(result.status,'confirmed_success');assert.equal(i.attempt.state,'failed');
  assert.equal(Object.hasOwn(result,'body'),false);
});
test('missing receipt and wrong hash stay unknown; only Host-confirmed rejection is failure',()=>{
  assert.equal(roomEffectResult(input('pending'),rooms),null);
  assert.equal(roomEffectResult({...input(),reply_receipt:{status:'confirmed_success',message_id:'missing',body_hash:bodyHash}},rooms).status,'unknown');
  assert.equal(roomEffectResult({...input(),reply_receipt:{message_id:'reply-1',body_hash:'wrong'}},rooms).status,'unknown');
  assert.equal(roomEffectResult({...input(),reply_receipt:{status:'confirmed_failure',committed:false,rejected:true,error_code:'EPERM'}},rooms).status,'confirmed_failure');
  assert.equal(roomEffectResult({...input(),reply_receipt:{status:'confirmed_failure',error_code:'EPERM'}},rooms).status,'unknown');
});
test('failed send plus empty ACK cannot make the input complete during migration',()=>{
  const old={...input('handled'),handled_batch_id:'empty-actions-ack',reply_receipt:{status:'confirmed_failure',committed:false,rejected:true,error_code:'EPERM'}};
  const result=migrateInputTruth({schemaVersion:2,inbox:{a:old}});assert.equal(result.state.inbox.a.status,'pending');
  assert.equal(roomEffectResult(result.state.inbox.a,rooms).status,'confirmed_failure');assert.equal(result.state.inbox.a.requested,false);
});
test('health notices expose stale inputs, contradictory receipts, unknown effects and duplicated outward intent without bodies',()=>{
  const now=Date.parse('2026-10-07T01:00:00Z');const items=[{...input('pending'),reply_receipt:{message_id:'missing',status:'confirmed_success'}},
    {...input('pending'),inbox_id:'input-2',last_decision:{action:'continue',at:'2026-10-07T00:59:00Z'},effect_receipts:[{message_id:'one',reply_to:'source-1'},{message_id:'two',reply_to:'source-1'}],attempt:{state:'ambiguous'}}];
  const notices=inputHealth(items,{rooms,now});const codes=new Set(notices.map(n=>n.code));
  for(const code of ['INPUT_PENDING_TOO_LONG','ACTION_RESULT_CONTRADICTION','SIDE_EFFECT_UNKNOWN','DUPLICATE_OUTWARD_INTENT','RECOVERY_RECONCILE_BLOCKED'])assert.ok(codes.has(code),code);
  assert.equal(notices.filter(n=>n.code==='INPUT_PENDING_TOO_LONG'&&n.inbox_id==='input-2').length,0);
  assert.equal(JSON.stringify(notices).includes(body),false);
});
