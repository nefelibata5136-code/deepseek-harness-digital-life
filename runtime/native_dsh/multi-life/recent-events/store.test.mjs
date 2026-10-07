import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecentEventStore,stableJson} from './store.mjs';

function fixture(extra={}) {
  const root=mkdtempSync(join(tmpdir(),'dsh-recent-events-test-'));let at='2026-10-06T02:00:00.000Z';
  const store=new RecentEventStore({root,now:()=>at,...extra});
  return {root,store,setTime:value=>{at=value;},cleanup:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
function direct(overrides={}) {
  return {event_id:'event-1',source_key:'source-1',occurred_at_utc:'2026-10-06T01:10:00.000Z',event_type:'message',from_actor_id:'human',from_display_name:'用户',to_actor_id:'A',to_display_name:'人格',conversation_id:'direct-human-A',conversation_type:'direct',conversation_display_name:'用户与人格',visibility:{members:['human','A']},body:'完整私聊原文',originSessionId:'authority-A',...overrides};
}
const prepare=(store,id='event-1',wake='wake-1')=>store.createBatch({life_id:'A',authority_session_id:'authority-A',wake_id:wake,event_ids:[id]});

test('private visibility is mandatory, secondary membership gate is fail closed, pagination is complete',()=>{
  const f=fixture({canSeeEvent:(life,event)=>!(life==='A'&&event.conversation_id==='revoked')});
  try {
    f.store.emit(direct());f.store.emit(direct({event_id:'event-revoked',source_key:'source-revoked',conversation_id:'revoked'}));
    assert.deepEqual(f.store.listVisible('B'),[]);assert.equal(f.store.listVisible('A').length,1);
    assert.throws(()=>f.store.emit(direct({visibility:{members:['human','A','B']}})),/DIRECT_EVENT_MEMBERS/);
    assert.throws(()=>f.store.createBatch({life_id:'B',authority_session_id:'authority-B',wake_id:'w',event_ids:['event-1']}),/NOT_VISIBLE/);
    for(let index=2;index<=121;index++)f.store.emit(direct({event_id:'event-'+index,source_key:'source-'+index}));
    let after=0;const read=[];for(;;){const page=f.store.listVisible('A',{after,limit:17});if(!page.length)break;read.push(...page);after=page.at(-1).seq;}
    assert.equal(read.length,121);assert.equal(new Set(read.map(x=>x.event_id)).size,121);assert.equal(read.at(-1).seq,122);
  }finally{f.cleanup();}
});

test('event id/source dedup is stable and semantic conflicts fail; history bytes never change',()=>{
  const f=fixture();
  try {
    const input=direct(),first=f.store.emit(input),path=f.store.ledger.file(1),original=readFileSync(path);
    f.setTime('2026-10-06T03:00:00.000Z');input.visibility.members.reverse();
    assert.deepEqual(f.store.emit(input),first);assert.equal(first.observed_at_utc,'2026-10-06T02:00:00.000Z');
    assert.throws(()=>f.store.emit({...input,body:'不同的正文'}),/IDEMPOTENCE_CONFLICT/);
    assert.throws(()=>f.store.emit({...input,event_id:'different-id'}),/IDEMPOTENCE_CONFLICT/);
    const withoutId={...input};delete withoutId.event_id;assert.equal(f.store.emit(withoutId).event_id,first.event_id);
    const batch=prepare(f.store);f.store.deliverBatch({life_id:'A',batch_id:batch.batch_id,wake_id:'wake-1'});f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:{status:'ok',disposition:'silent',actions:[]}});
    assert.deepEqual(readFileSync(path),original);assert.throws(()=>{first.body='mutated';},TypeError);assert.throws(()=>first.visibility.members.push('B'),TypeError);
  }finally{f.cleanup();}
});

test('UTC is canonical, historical unknown occurrence stays unknown, and observation is explicit',()=>{
  const f=fixture();
  try {
    assert.equal(f.store.emit(direct({occurred_at_utc:'2026-10-06T09:10:00+08:00'})).occurred_at_utc,'2026-10-06T01:10:00.000Z');
    const unknown=f.store.emit(direct({event_id:'unknown',source_key:'unknown',occurred_at_utc:null}));assert.equal(unknown.occurred_at_utc,null);assert.equal(unknown.observed_at_utc,'2026-10-06T02:00:00.000Z');
    assert.throws(()=>f.store.emit(direct({event_id:'bad',source_key:'bad',occurred_at_utc:'2026-02-30T00:00:00Z'})),/INVALID_UTC_TIME/);
    assert.throws(()=>f.store.emit(direct({event_id:'bad',source_key:'bad',occurred_at_utc:'2026-10-06 01:00:00'})),/INVALID_UTC_TIME/);
  }finally{f.cleanup();}
});

test('batch freezes cutoff and events, formal delivery stamps once, busy arrivals wait for a later batch',()=>{
  const f=fixture();
  try {
    f.store.emit(direct());const original=prepare(f.store);assert.equal(original.delivered_at_utc,null);assert.equal(original.delivery_batch_id,original.batch_id);assert.equal(original.snapshot_cutoff_seq,1);
    f.setTime('2026-10-06T02:29:41.000Z');const delivered=f.store.deliverBatch({life_id:'A',batch_id:original.batch_id,wake_id:'wake-1'});
    assert.equal(delivered.delivered_at_utc,'2026-10-06T02:29:41.000Z');assert.notEqual(delivered.events[0].occurred_at_utc,delivered.delivered_at_utc);assert.equal(original.delivered_at_utc,null);
    assert.throws(()=>f.store.deliverBatch({life_id:'A',batch_id:original.batch_id,wake_id:'wrong'}),/WAKE_ID_MISMATCH/);
    f.setTime('2026-10-06T02:30:00.000Z');assert.deepEqual(f.store.deliverBatch({life_id:'A',batch_id:original.batch_id,wake_id:'wake-1'}),delivered);
    for(let index=2;index<=5;index++)f.store.emit(direct({event_id:'event-'+index,source_key:'source-'+index}));
    assert.equal(delivered.events.length,1);assert.equal(delivered.snapshot_cutoff_seq,1);assert.throws(()=>delivered.events.push('new'),TypeError);
    f.store.acknowledgeBatch({life_id:'A',batch_id:original.batch_id,result:{status:'ok',disposition:'silent',actions:[],completed_event_ids:['event-1']}});
    assert.deepEqual(f.store.pending('A').map(x=>x.event_id),['event-2','event-3','event-4','event-5']);
    const next=f.store.createBatch({life_id:'A',authority_session_id:'authority-A',wake_id:'wake-2',event_ids:f.store.pending('A').map(x=>x.event_id)});assert.equal(next.events.length,4);assert.equal(next.snapshot_cutoff_seq,5);
  }finally{f.cleanup();}
});

test('missing/failed/invalid ACK never becomes silence or advances handling; failed delivered events retry',()=>{
  const f=fixture();
  try {
    f.store.emit(direct());const batch=prepare(f.store);
    assert.throws(()=>f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:{status:'ok',disposition:'silent',actions:[]}}),/NOT_DELIVERED/);
    f.store.deliverBatch({life_id:'A',batch_id:batch.batch_id,wake_id:'wake-1'});
    for(const result of [null,{}, {status:'failed',disposition:'silent',actions:[]},{status:'ok',disposition:'silent'}, {status:'ok',disposition:'silent',actions:[{type:'send_message'}]}])assert.throws(()=>f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result}),/INVALID_AUTHORITY/);
    assert.equal(f.store.pending('A').length,1);f.store.failBatch({life_id:'A',batch_id:batch.batch_id,status:'interrupted',error:'native request interrupted'});
    assert.equal(f.store.pending('A').length,1);assert.equal(f.store.inspectLife('A').batch_status[batch.batch_id].disposition,null);
    assert.throws(()=>f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:{status:'ok',disposition:'silent',actions:[]}}),/NEW_WAKE/);
    const retry=prepare(f.store,'event-1','retry-wake');f.store.deliverBatch({life_id:'A',batch_id:retry.batch_id,wake_id:'retry-wake'});
    const ack={status:'ok',disposition:'silent',actions:[],completed_event_ids:['event-1']};const result=f.store.acknowledgeBatch({life_id:'A',batch_id:retry.batch_id,result:ack});assert.equal(result.turn_status,'ok');assert.equal(f.store.pending('A').length,0);
    assert.deepEqual(f.store.acknowledgeBatch({life_id:'A',batch_id:retry.batch_id,result:ack}),result);
    assert.throws(()=>f.store.acknowledgeBatch({life_id:'A',batch_id:retry.batch_id,result:{status:'ok',disposition:'deferred',actions:[]}}),/ACK_IDEMPOTENCE/);
    assert.throws(()=>f.store.failBatch({life_id:'A',batch_id:retry.batch_id}),/CANNOT_FAIL/);
  }finally{f.cleanup();}
});

test('group events have no To, each life handles independently, and own sent actions do not self-wake',()=>{
  const f=fixture();
  try {
    const event={event_id:'group',source_key:'group',occurred_at_utc:'2026-10-06T02:00:00Z',event_type:'message',from_actor_id:'human',conversation_id:'living-room',conversation_type:'group',conversation_display_name:'客厅',visibility:{members:['human','A','B']},body:'大家好'};
    f.store.emit(event);assert.throws(()=>f.store.emit({...event,to_actor_id:'A'}),/CANNOT_HAVE_TO/);
    assert.equal(f.store.pending('A').length,1);assert.equal(f.store.pending('B').length,1);
    const a=prepare(f.store,'group');f.store.deliverBatch({life_id:'A',batch_id:a.batch_id,wake_id:'wake-1'});f.store.acknowledgeBatch({life_id:'A',batch_id:a.batch_id,result:{status:'ok',disposition:'silent',actions:[],completed_event_ids:['group']}});
    assert.equal(f.store.pending('A').length,0);assert.equal(f.store.pending('B').length,1);
    f.store.emit({...event,event_id:'own-action',source_key:'own-action',from_actor_id:'A'});assert.equal(f.store.pending('A').length,0);assert.equal(f.store.pending('A',{includeOwn:true}).length,1);assert.equal(f.store.pending('B').length,2);assert.equal(f.store.listVisible('A').length,2);
  }finally{f.cleanup();}
});

test('cold reopen preserves events, batches, delivery time, and successful handling',()=>{
  const f=fixture();let reopened;
  try {
    f.store.emit(direct());const batch=prepare(f.store);f.store.deliverBatch({life_id:'A',batch_id:batch.batch_id,wake_id:'wake-1'});f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:{status:'ok',disposition:'deferred',actions:[]}});
    f.store.close();reopened=new RecentEventStore({root:f.root});assert.equal(reopened.listVisible('A').length,1);assert.equal(reopened.pending('A').length,0);assert.equal(reopened.getBatch('A',batch.batch_id).delivered_at_utc,'2026-10-06T02:00:00.000Z');assert.equal(reopened.inspectLife('A').batch_status[batch.batch_id].disposition,'deferred');
  }finally{reopened?.close();f.cleanup();}
});

test('CAS rejects stale writers and externally changed state/history, explicit refresh recovers valid updates',()=>{
  const f=fixture();let other;
  try {
    other=new RecentEventStore({root:f.root});f.store.emit(direct());assert.throws(()=>other.emit(direct({event_id:'second',source_key:'second'})),/STALE_WRITE/);other.refresh();other.emit(direct({event_id:'second',source_key:'second'}));
    assert.throws(()=>prepare(f.store),/STALE_WRITE/);f.store.refresh();const batch=prepare(f.store);other.refresh();
    f.store.deliverBatch({life_id:'A',batch_id:batch.batch_id,wake_id:'wake-1'});assert.throws(()=>other.failBatch({life_id:'A',batch_id:batch.batch_id}),/STALE_WRITE/);
    const eventPath=f.store.ledger.file(1);const altered=JSON.parse(readFileSync(eventPath,'utf8').split('\n')[0]);altered.body='external valid modification';writeFileSync(eventPath,JSON.stringify(altered)+'\n');assert.throws(()=>f.store.emit(direct({event_id:'third',source_key:'third'})),/STALE_WRITE/);
  }finally{other?.close();f.cleanup();}
});

test('abandoned internal writer lease is recovered without replacing a live lease',()=>{
  const f=fixture();let reopened;
  try {
    writeFileSync(join(f.root,'.writer-lock'),JSON.stringify({pid:2147483647}));reopened=new RecentEventStore({root:f.root});assert.equal(reopened.listVisible('A').length,0);reopened.close();
    writeFileSync(join(f.root,'.writer-lock'),JSON.stringify({pid:process.pid}));assert.throws(()=>new RecentEventStore({root:f.root}),/WRITER_ACTIVE/);
  }finally{reopened?.close();f.cleanup();}
});

test('deferred events retain originals, become pending exactly at due time, and retry is explicit',()=>{
  const f=fixture();let cold;
  try {
    const one=f.store.emit(direct());f.store.emit(direct({event_id:'event-2',source_key:'source-2'}));
    const batch=f.store.createBatch({life_id:'A',authority_session_id:'authority-A',wake_id:'wake-1',event_ids:['event-1','event-2']});f.store.deliverBatch({life_id:'A',batch_id:batch.batch_id,wake_id:'wake-1'});
    f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:{status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:'event-1',until:'2026-10-06T03:00:00.000Z'}],completed_event_ids:['event-2']}});
    const state=f.store.inspectLife('A');assert.equal(state.handled['event-1'],undefined);assert.equal(state.handled['event-2'].batch_id,batch.batch_id);assert.equal(state.deferred['event-1'].until_utc,'2026-10-06T03:00:00.000Z');assert.equal(f.store.pending('A').length,0);
    assert.throws(()=>prepare(f.store,'event-1','early-wake'),/DELIVERY_EVENT_DEFERRED/);
    f.setTime('2026-10-06T03:00:00.000Z');assert.deepEqual(f.store.pending('A'),[one]);
    const due=prepare(f.store,'event-1','due-wake');assert.deepEqual(due.first_delivery_event_ids,[]);assert.deepEqual(due.redelivery_event_ids,['event-1']);f.store.deliverBatch({life_id:'A',batch_id:due.batch_id,wake_id:'due-wake'});f.store.acknowledgeBatch({life_id:'A',batch_id:due.batch_id,result:{status:'ok',disposition:'silent',actions:[],completed_event_ids:['event-1']}});assert.equal(f.store.inspectLife('A').deferred['event-1'],undefined);
    f.store.setDeferred({life_id:'A',event_id:'event-1',until_utc:null,reason:'现有 Room defer'});assert.equal(f.store.pending('A').length,0);assert.equal(f.store.inspectLife('A').handled['event-1'],undefined);
    f.store.close();cold=new RecentEventStore({root:f.root,now:()=>new Date('2026-10-07T00:00:00Z')});assert.equal(cold.pending('A').length,0);assert.equal(cold.inspectLife('A').deferred['event-1'].until_utc,null);
  }finally{cold?.close();f.cleanup();}
});

test('deferred with no action defers entire batch and invalid per-event defer never handles',()=>{
  const f=fixture();
  try {
    f.store.emit(direct());const prepared=prepare(f.store);assert.deepEqual(prepared.first_delivery_event_ids,['event-1']);assert.deepEqual(prepared.redelivery_event_ids,[]);f.store.deliverBatch({life_id:'A',batch_id:prepared.batch_id,wake_id:'wake-1'});
    assert.throws(()=>f.store.acknowledgeBatch({life_id:'A',batch_id:prepared.batch_id,result:{status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:'different',until:null}]}}),/NOT_IN_BATCH/);assert.equal(f.store.pending('A').length,1);
    f.store.acknowledgeBatch({life_id:'A',batch_id:prepared.batch_id,result:{status:'ok',disposition:'deferred',actions:[]}});assert.equal(f.store.pending('A').length,0);assert.equal(f.store.inspectLife('A').deferred['event-1'].until_utc,null);assert.deepEqual(f.store.inspectLife('A').handled,{});
  }finally{f.cleanup();}
});

test('explicit audit rejects altered sealed history without making ordinary reads scan it',()=>{
  const f=fixture();
  try {
    f.store.emit(direct());const path=f.store.ledger.file(1),record=JSON.parse(readFileSync(path,'utf8'));record.body='改动历史';writeFileSync(path,JSON.stringify(record)+'\n');assert.throws(()=>f.store.ledger.audit(),/CORRUPT_EVENT_HASH/);
  }finally{f.cleanup();}
});

test('receiver defer override and exact silent ACK commit atomically without transient handled state',()=>{
  const f=fixture();let cold;
  try {
    f.store.emit(direct());f.store.emit(direct({event_id:'event-2',source_key:'source-2'}));const batch=f.store.createBatch({life_id:'A',authority_session_id:'authority-A',wake_id:'wake-1',event_ids:['event-1','event-2']});f.store.deliverBatch({life_id:'A',batch_id:batch.batch_id,wake_id:'wake-1'});
    const silent={status:'ok',disposition:'silent',actions:[],completed_event_ids:['event-2']},until='2026-10-06T03:00:00.000Z',before=f.store.state;
    const result=f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:silent,deferred_events:[{event_id:'event-1',until}]});
    const saved=f.store.state,life=saved.lives.A;assert.equal(saved.revision,before.revision+1);assert.deepEqual(result.result,silent);assert.equal(result.disposition,'silent');assert.equal(life.handled['event-1'],undefined);assert.equal(life.deferred['event-1'].until_utc,until);assert.equal(life.handled['event-2'].batch_id,batch.batch_id);assert.deepEqual(life.batch_status[batch.batch_id].result,silent);assert.deepEqual(result.deferred_events,[{event_id:'event-1',until}]);
    f.store.close();cold=new RecentEventStore({root:f.root,now:()=>new Date('2026-10-06T03:00:00Z')});assert.deepEqual(cold.pending('A').map(event=>event.event_id),['event-1']);
    cold.setDeferred({life_id:'A',event_id:'event-1',until_utc:null,reason:'later-receiver-choice'});const current=stableJson(cold.state);
    assert.deepEqual(cold.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:silent,deferred_events:[{event_id:'event-1',until}]}),result);assert.deepEqual(stableJson(cold.state),current);assert.equal(cold.inspectLife('A').deferred['event-1'].until_utc,null);assert.equal(cold.inspectLife('A').deferred['event-1'].reason,'later-receiver-choice');
  }finally{cold?.close();f.cleanup();}
});

test('invalid receiver override never commits handling or permits out-of-batch state edits',()=>{
  const f=fixture();
  try {
    f.store.emit(direct());const batch=prepare(f.store);f.store.deliverBatch({life_id:'A',batch_id:batch.batch_id,wake_id:'wake-1'});const silent={status:'ok',disposition:'silent',actions:[]},before=stableJson(f.store.state);
    for(const deferred_events of [null,{},[{event_id:'different-event',until:null}],[{event_id:'event-1'}],[{event_id:'event-1',until:'2026-10-06T10:00:00+08:00'}],[{event_id:'event-1',until:123}],[{event_id:'event-1',until:null},{event_id:'event-1',until:null}]]) {
      assert.throws(()=>f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:silent,deferred_events}),/DEFERRED_OVERRIDE_INVALID|DEFER_EVENT_NOT_IN_BATCH/);assert.deepEqual(stableJson(f.store.state),before);assert.deepEqual(f.store.inspectLife('A').handled,{});assert.deepEqual(f.store.inspectLife('A').deferred,{});
    }
    f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:silent,deferred_events:[{event_id:'event-1',until:null}]});assert.throws(()=>f.store.acknowledgeBatch({life_id:'A',batch_id:batch.batch_id,result:silent,deferred_events:[{event_id:'different-event',until:null}]}),/DEFER_EVENT_NOT_IN_BATCH/);
  }finally{f.cleanup();}
});
