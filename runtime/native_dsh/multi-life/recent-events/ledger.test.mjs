import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,renameSync,appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {RecentEventStore,stableJson} from './store.mjs';
const input=n=>({event_id:'TEST-event-'+n,source_key:'TEST-source-'+n,occurred_at_utc:null,event_type:'self_record',from_actor_id:'TEST-owner',conversation_id:'TEST-activity',conversation_type:'activity',visibility:{members:['TEST-owner']},body:'TEST ONLY '+n});
const fixture=extra=>{const root=mkdtempSync(join(tmpdir(),'recent-segments-'));return {root,store:new RecentEventStore({root,...extra})};};

test('segment rollover, constant-size recent read, immutable prefix and exact idempotence',()=>{
 const f=fixture({segmentEvents:3});try {
   f.store.emit(input(1));const prefix=readFileSync(f.store.ledger.file(1));
   for(let n=2;n<=11;n++)f.store.emit(input(n));
   assert(readFileSync(f.store.ledger.file(1)).subarray(0,prefix.length).equals(prefix));
   assert.equal(readdirSync(join(f.root,'ledger')).filter(n=>n.endsWith('.jsonl')).length,4);
   assert.deepEqual(f.store.recent('TEST-owner',{limit:5}).map(e=>e.seq),[7,8,9,10,11]);
   assert.equal(f.store.emit(input(11)).seq,11);assert.equal(f.store.lastSequence,11);
   assert.throws(()=>f.store.emit({...input(11),body:'changed'}),/IDEMPOTENCE/);
   assert.deepEqual(f.store.ledger.audit(),{verified:true,events:11,segments:4,lastSequence:11});
 }finally{f.store.close();}
});

test('raw append/index failures recover exact event and admission; truncated suffix is preserved',()=>{
 for(const point of ['after-append','after-index']) {
  let armed=false;const f=fixture({segmentEvents:3,fault:p=>{if(armed&&p===point){armed=false;throw Error('TEST crash');}}});
  f.store.emit(input(1));f.store.emit(input(2));f.store.emit(input(3));armed=true;assert.throws(()=>f.store.emit(input(4)),/TEST crash/);f.store.close();
  let cold=new RecentEventStore({root:f.root,segmentEvents:3});assert.equal(cold.emit(input(4)).seq,4);assert.equal(cold.lastSequence,4);
  const path=cold.ledger.file(2);cold.close();appendFileSync(path,'{"TEST partial":');
  cold=new RecentEventStore({root:f.root,segmentEvents:3});assert.equal(cold.lastSequence,4);assert(readdirSync(join(f.root,'ledger')).some(n=>n.includes('.partial-')));assert(cold.pending('TEST-owner',{includeOwn:true}).some(e=>e.seq===4));cold.emit(input(5));assert.equal(cold.lastSequence,5);cold.close();
 }
});

test('missing and corrupt index rebuild from source without loss, preserving handling and deferred choices',()=>{
 const f=fixture();for(let n=1;n<=13;n++)f.store.emit(input(n));
 f.store.setDeferred({life_id:'TEST-owner',event_id:'TEST-event-1',until_utc:null,reason:'TEST choice'});f.store.close();
 renameSync(join(f.root,'event-index.sqlite'),join(f.root,'saved-index.sqlite'));
 let cold=new RecentEventStore({root:f.root});assert.equal(cold.lastSequence,13);assert.equal(cold.mark('TEST-owner','TEST-event-1').deferred.reason,'TEST choice');assert.equal(cold.ledger.metrics.fullScans,1);cold.close();
 writeFileSync(join(f.root,'event-index.sqlite'),'TEST ONLY damaged index');cold=new RecentEventStore({root:f.root});assert.equal(cold.lastSequence,13);assert(cold.ledger.audit().verified);cold.close();
});

test('one-time old ledger migration preserves exact records and original evidence bytes',()=>{
 const root=mkdtempSync(join(tmpdir(),'recent-migration-'));mkdirSync(join(root,'events'));
 const event={seq:1,observed_at_utc:'2026-10-07T00:00:00.000Z',...input(1),from_display_name:'TEST-owner',conversation_display_name:'TEST-activity',payload:null,originSessionId:null,originTaskId:null};
 const sha=value=>createHash('sha256').update(value).digest('hex');event.record_hash=sha(stableJson(event));
 const path=join(root,'events','0000000000000001-'+sha(event.event_id)+'.json'),bytes=stableJson(event)+'\n';writeFileSync(path,bytes);
 const store=new RecentEventStore({root});assert.deepEqual(store.event(event.event_id),event);assert.equal(readFileSync(path,'utf8'),bytes);store.emit(input(2));assert.equal(store.lastSequence,2);store.close();
 const cold=new RecentEventStore({root});assert.equal(cold.ledger.metrics.fullScans,0);assert.equal(readFileSync(path,'utf8'),bytes);cold.close();
});
