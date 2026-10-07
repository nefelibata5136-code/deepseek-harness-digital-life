import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActionLedger} from './bundle/ledger.mjs';
const lifeId='life-147c2fff-ff1a-5d20-b057-cd3ec56745fa';
test('durable at-most-once receipts: concurrent calls, unknown restart, changed id and private body minimization',async()=>{
 const root=mkdtempSync(join(tmpdir(),'moltbook-test-')),a=new ActionLedger(root,lifeId),b=new ActionLedger(root,lifeId);let sent=0;
 try{
  const spec={actionId:'dm-1',type:'dm_send',payload:{message:'PRIVATE_FIXTURE_BODY'}};
  const first=a.run(spec,async()=>{sent++;await new Promise(r=>setTimeout(r,20));return {ok:true,outcome:'succeeded',data:{id:'remote-1',message:'PRIVATE_FIXTURE_BODY'}};});
  const dup=await b.run(spec,()=>{sent++;});assert.equal(dup.duplicate_prevented,true);assert.equal(dup.outcome,'unknown');
  assert.equal((await first).ok,true);assert.equal(sent,1);assert.equal(b.read('dm-1').remote_object_id,'remote-1');
  await assert.rejects(b.run({...spec,actionId:'dm-2'},()=>{}),/IDENTICAL_ACTION/);
  await assert.rejects(b.run({...spec,payload:{message:'changed'}},()=>{}),/CONTENT_CONFLICT/);
  const lost={actionId:'lost',type:'comment',payload:{content:'LOST'}};
  assert.equal((await a.run(lost,()=>{throw Error('network fixture');})).outcome,'unknown');
  assert.equal((await b.run(lost,()=>{sent++;})).outcome,'unknown');assert.equal(sent,1);
  assert(!readFileSync(join(root,'actions.sqlite')).includes(Buffer.from('PRIVATE_FIXTURE_BODY')));
 }finally{a.close();b.close();}
 const reopened=new ActionLedger(root,lifeId);try{assert.equal(reopened.read('lost').outcome,'unknown');assert.equal(reopened.read('dm-1').ok,true);}finally{reopened.close();}
});

test('new decisions can reverse settled social state without bypassing unknown or duplicating published content',async()=>{
 const root=mkdtempSync(join(tmpdir(),'moltbook-state-test-')),ledger=new ActionLedger(root,lifeId);let sends=0;
 const perform=(actionId,type,payload,outcome='succeeded')=>ledger.run({actionId,type,payload},async()=>{sends++;return {ok:outcome==='succeeded',outcome};});
 try{
  await perform('follow-1','follow',{name:'fixture-agent'});
  await assert.rejects(perform('follow-dupe','follow',{name:'fixture-agent'}),/IDENTICAL_ACTION/);
  await perform('unfollow-1','unfollow',{name:'fixture-agent'});
  assert.equal((await perform('follow-2','follow',{name:'fixture-agent'})).ok,true);
  await assert.rejects(perform('follow-other-id','follow',{name:'fixture-agent'}),/IDENTICAL_ACTION/);
  await perform('up-1','vote',{target_type:'post',target_id:'post-a',direction:'up'});
  await perform('down-other','vote',{target_type:'post',target_id:'post-b',direction:'down'});
  await assert.rejects(perform('up-no-reversal','vote',{target_type:'post',target_id:'post-a',direction:'up'}),/IDENTICAL_ACTION/);
  await perform('down-1','vote',{target_type:'post',target_id:'post-a',direction:'down'});
  assert.equal((await perform('up-2','vote',{target_type:'post',target_id:'post-a',direction:'up'})).ok,true);
  await perform('unknown-follow','follow',{name:'unsettled-agent'},'unknown');
  await perform('known-inverse','unfollow',{name:'unsettled-agent'});
  await assert.rejects(perform('unknown-bypass','follow',{name:'unsettled-agent'}),/IDENTICAL_ACTION/);
  await perform('post-1','create_post',{title:'fixture title'});
  await assert.rejects(perform('post-2','create_post',{title:'fixture title'}),/IDENTICAL_ACTION/);
  assert.equal(sends,10);
 }finally{ledger.close();}
});
