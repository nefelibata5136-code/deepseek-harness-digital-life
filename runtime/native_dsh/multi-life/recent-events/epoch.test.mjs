import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Session,SessionStore} from '@deepseek-ai/dsh-session';
import {Context} from '@deepseek-ai/cordis';
import Invariants from '@deepseek-ai/dsh-invariants';
import * as sessionInvariant from '@deepseek-ai/dsh-session/invariant';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {advanceRecentEpoch,prepareStageMemory,commitStageMemory,recentContextState} from './epoch.mjs';
import {recentPolicy} from './policy.mjs';
const LIFE='TEST ONLY epoch owner';
const event=seq=>({event_id:'TEST-event-'+seq,seq,event_type:'system',from_actor_id:'host:test',conversation_id:'TEST',conversation_type:'activity',conversation_display_name:'TEST source',visibility:{members:[LIFE]},body:'TEST ONLY fact '+seq,payload:null,occurred_at_utc:null});
const append=(session,entries)=>session.append('user/message',createUserMessage({content:[{type:'text',text:entries.map(e=>'【事件开始 '+e.event_id+'】'+e.body+'【事件结束 '+e.event_id+'】').join('\n')}],source:{kind:'life-recent-events',lifeId:LIFE,recentEntries:entries,form:'snapshot'}}),{surfaceOp:'append'});
test('100 to 150 never rewrites; only author commit returns to 100 then restores append stability',async()=>{
 const session=Session.create('TEST ONLY epoch');append(session,Array.from({length:100},(_,i)=>event(i+1)));
 const raw=session.append('user/message',createUserMessage({content:[{type:'text',text:'TEST ONLY unrelated native conversation'}],source:{kind:'developer-test'}}),{surfaceOp:'append'});
 for(let seq=101;seq<=150;seq++){
  const prefix=JSON.stringify(session.deriveMessages());append(session,[event(seq)]);assert.equal(JSON.stringify(session.deriveMessages().slice(0,-1)),prefix);
  await advanceRecentEpoch({session,lifeId:LIFE});assert.equal(prepareStageMemory({session,lifeId:LIFE}).required,seq===150);
 }
 const before=[...session.ownEvents()],plan=prepareStageMemory({session,lifeId:LIFE});assert.deepEqual(plan.departing_events.map(e=>e.seq),Array.from({length:50},(_,i)=>i+1));
 const text='TEST ONLY author free prose. An arbitrary heading is allowed. I keep fact one because it matters.';
 const receipt=await commitStageMemory({session,lifeId:LIFE,checkpointId:plan.checkpoint_id,text});assert.equal(receipt.event_count,100);assert.equal(receipt.departed,50);
 assert.equal(recentContextState(session,LIFE).stageMemory,text);assert(session.surface.nodes.includes(raw.seq));assert.deepEqual([...session.ownEvents()].slice(0,before.length),before);
 const prefix=JSON.stringify(session.deriveMessages());append(session,[event(151)]);await advanceRecentEpoch({session,lifeId:LIFE});assert.equal(JSON.stringify(session.deriveMessages().slice(0,-1)),prefix);assert.equal(prepareStageMemory({session,lifeId:LIFE}).required,false);
 assert.deepEqual(Session.create(session.id,[...session.ownEvents()]).deriveMessages(),session.deriveMessages());
});
test('hard limit rejects rather than truncates, without a required normal length or format',async()=>{
 const session=Session.create('TEST ONLY budgets');append(session,Array.from({length:150},(_,i)=>event(i+1)));const plan=prepareStageMemory({session,lifeId:LIFE}),raw=[...session.ownEvents()];
 await assert.rejects(commitStageMemory({session,lifeId:LIFE,checkpointId:plan.checkpoint_id,text:'中'.repeat(recentPolicy.stageMemoryHardChars+1)}),/HARD_LIMIT/);assert.deepEqual([...session.ownEvents()],raw);
 await commitStageMemory({session,lifeId:LIFE,checkpointId:plan.checkpoint_id,text:''});assert.equal(recentContextState(session,LIFE).stageMemory,'');
});
test('crash after checkpoint intent repairs without a second memory version; retry is an exact receipt',async()=>{
 const ctx=new Context(),fibers=[];try{
  for(const plugin of [SessionStore,Invariants,sessionInvariant]){const fiber=ctx.plugin(plugin);fibers.push(fiber);await fiber;}
  const session=ctx.sessions.create('TEST ONLY invariant');append(session,Array.from({length:100},(_,i)=>event(i+1)));for(let n=101;n<=150;n++)append(session,[event(n)]);
  session.append('turn/start',{turn:1});const plan=prepareStageMemory({session,lifeId:LIFE});let crash=true;
  await assert.rejects(commitStageMemory({session,lifeId:LIFE,checkpointId:plan.checkpoint_id,text:'TEST ONLY exact author memory',flush:async()=>{if(crash){crash=false;throw Error('TEST ONLY checkpoint crash');}}}),/checkpoint crash/);
  const receipt=await commitStageMemory({session,lifeId:LIFE,checkpointId:plan.checkpoint_id,text:'TEST ONLY exact author memory'});assert(receipt.replayed);
  assert.equal([...session.ownEvents()].filter(e=>e.data.source?.kind==='life-recent-checkpoint').length,1);assert.equal(recentContextState(session,LIFE).entries.size,100);
  await assert.rejects(commitStageMemory({session,lifeId:LIFE,checkpointId:plan.checkpoint_id,text:'changed'}),/RETRY_CONFLICT/);
  session.append('step/start',{turn:1,step:1});session.append('step/end',{turn:1,step:1});session.append('turn/end',{turn:1});assert.deepEqual(Session.create(session.id,[...session.ownEvents()]).deriveMessages(),session.deriveMessages());
 }finally{for(const fiber of fibers.reverse())await fiber.dispose();}
});
test('legacy Host extraction is preserved as input evidence and never becomes author stage memory',async()=>{
 const session=Session.create('TEST ONLY migration');session.append('user/message',createUserMessage({content:[{type:'text',text:'TEST ONLY old Host extraction; preserve until author chooses'}],source:{kind:'life-recent-checkpoint',lifeId:LIFE,sessionId:session.id,epochId:'legacy',form:'checkpoint'}}),{surfaceOp:'append'});
 append(session,[event(1)]);await advanceRecentEpoch({session,lifeId:LIFE});const plan=prepareStageMemory({session,lifeId:LIFE});assert(plan.required);assert.equal(plan.current_stage_memory,'');assert(plan.legacy_context_material[0].includes('old Host extraction'));
 assert(session.deriveMessages().some(m=>m.content.some(b=>b.text?.includes('preserve until'))));await commitStageMemory({session,lifeId:LIFE,checkpointId:plan.checkpoint_id,text:'TEST ONLY independently chosen memory'});assert.equal(recentContextState(session,LIFE).stageMemory,'TEST ONLY independently chosen memory');
});
test('stage length warning stays soft after a valid author commit below the hard limit',async()=>{
 const session=Session.create('TEST ONLY soft warning');append(session,Array.from({length:150},(_,i)=>event(i+1)));
 const plan=prepareStageMemory({session,lifeId:LIFE}),text='中'.repeat(recentPolicy.stageMemoryWarnChars+1);
 await commitStageMemory({session,lifeId:LIFE,checkpointId:plan.checkpoint_id,text});
 const next=prepareStageMemory({session,lifeId:LIFE});assert.equal(next.required,false);assert.equal(next.stage_memory_warning,true);assert.equal(next.current_stage_memory,text);
 assert(next.checkpoint_id);await commitStageMemory({session,lifeId:LIFE,checkpointId:next.checkpoint_id,text:'TEST ONLY author chooses to shorten early'});
 assert.equal(prepareStageMemory({session,lifeId:LIFE}).stage_memory_warning,false);assert.equal(recentContextState(session,LIFE).entries.size,100);
});
