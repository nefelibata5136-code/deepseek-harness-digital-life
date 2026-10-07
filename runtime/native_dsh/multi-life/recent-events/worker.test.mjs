import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {mountRecentEventsWorker} from './worker.mjs';
import {findTurnActionResult} from './action-result.mjs';

const LIFE='life-147c2fff-ff1a-5d20-b057-cd3ec56745fa',SESSION='TEST ONLY recent worker authority';
const silent={status:'ok',disposition:'silent',completed_event_ids:[],records:[],actions:[]};
const at=Date.parse('2026-10-06T02:00:00.000Z');
const event=(id,seq,time=at-60000)=>({event_id:id,seq,occurred_at_utc:new Date(time).toISOString(),event_type:'message',
  from_actor_id:'human:maintainer',from_display_name:'TEST ONLY HUMAN',to_actor_id:LIFE,to_display_name:'TEST ONLY LIFE',
  conversation_id:'TEST ONLY private Room',conversation_type:'direct',conversation_display_name:'TEST ONLY PRIVATE',
  visibility:{members:[LIFE,'human:maintainer']},body:'TEST ONLY '+id,payload:null,originSessionId:null,originTaskId:null});

function fixture({role='authority',sessionId=SESSION,lifeId=LIFE,withJournal=true}={}) {
  let clock=at,flushes=0,concluded=0,ackFailure=false,completeFailure=false,failReceiptFailure=false,prepareFailure=false;
  const journal=[],listeners=new Map(),tools=new Map(),sections=new Map(),requests=[],external=[],pending=[],stepPending=[];
  const session={id:sessionId,header:{id:sessionId},surface:{nodes:[]},
    ownEvents:()=>journal.values(),eventAt:seq=>journal.find(event=>event.seq===seq),
    append(type,data,options={}) {
      const item={type,data:structuredClone(data),seq:journal.length,time:clock++,...structuredClone(options)};journal.push(item);
      if(options.surfaceOp?.op==='replace')session.surface.nodes=session.surface.nodes.filter(seq=>seq<options.surfaceOp.startSeq||seq>options.surfaceOp.endSeq);
      if(options.surfaceOp)session.surface.nodes.push(item.seq);
      for(const fn of listeners.get('session/event')??[])fn(session,item);return item;
    }};
  if(!withJournal)delete session.ownEvents;
  const agent={session,send(message,target,wakeup){assert.equal(target,'next-turn');assert.equal(wakeup,true);pending.push(message);},ctx:{tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},
    systemPrompt:{section(section){sections.set(section.name,section);return()=>sections.delete(section.name);}}}};
  agent.inbox={get nextTurn(){return pending;},get nextStep(){return stepPending;},
    claim(target){assert.equal(target,'next-turn');assert.equal(stepPending.length,0);const message=pending.shift();if(!message)return [];
      session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});return [message];},
    prepend(target,message){assert.equal(target,'next-turn');pending.unshift(message);session.append('agent/inbox/spliced',{target,start:0,inserted:[message]});}};
  const ctx={agents:{get:id=>id===sessionId?agent:null},sessions:{async flush(actual){assert.equal(actual,session);flushes++;}},
    on(name,fn){const callbacks=listeners.get(name)??new Set();callbacks.add(fn);listeners.set(name,callbacks);return()=>callbacks.delete(fn);}};
  const central=[event('TEST ONLY event-a',1)],batches=[],drafts=new Map(),statuses=new Map();
  const rpc=async(operation,input)=>{
    assert.equal(operation,'timeline');assert.equal(input.recent.sessionId,sessionId);requests.push(structuredClone(input.recent));
    const request=input.recent;
    if(request.operation==='prepare') {
      if(prepareFailure)throw Object.assign(new Error('TEST ONLY failed prepare'),{code:'TEST_PREPARE_FAILED'});
      const events=central.filter(e=>e.visibility.members.includes(lifeId)&&Date.parse(e.occurred_at_utc)<=Date.parse(request.cutoff_at_utc));
      const batch={batch_id:'TEST ONLY batch-'+batches.length,life_id:lifeId,authority_session_id:sessionId,wake_id:request.wake_id,
        delivered_at_utc:new Date(clock+5000).toISOString(),event_ids:events.map(e=>e.event_id),events:structuredClone(events),snapshot_cutoff_seq:central.at(-1)?.seq??0};
      batches.push(batch);statuses.set(batch.batch_id,{turn_status:'running'});return {batch:structuredClone(batch),events:structuredClone(events),char_budget:20000};
    }
    if(request.operation==='inspect')return {life_id:lifeId,state:{batches:Object.fromEntries(batches.map(batch=>[batch.batch_id,structuredClone(batch)])),batch_status:Object.fromEntries(statuses)}};
    if(request.operation==='validate_ack')return {valid:true};
    if(request.operation==='ack'||request.operation==='complete') {
      if(request.operation==='ack'&&ackFailure||request.operation==='complete'&&completeFailure)throw Object.assign(new Error('TEST ONLY failure'),{code:'TEST_ACK_DISPATCH_FAILED'});
      if(!drafts.has(request.batch_id)){drafts.set(request.batch_id,structuredClone(request.result));external.push(...request.result.actions);}
      if(request.operation==='complete')statuses.set(request.batch_id,{turn_status:'ok'});
      return {acknowledged:true,result:structuredClone(request.result),delivery_batch_id:request.batch_id};
    }
    if(request.operation==='fail'){if(failReceiptFailure)throw Object.assign(new Error('TEST ONLY failed fail receipt'),{code:'TEST_FAIL_RECEIPT_FAILED'});statuses.set(request.batch_id,{turn_status:request.turn_status});}
    if(request.operation==='finish_execution') {
      if(completeFailure)throw Object.assign(Error('TEST ONLY execution receipt lost'),{code:'TEST_ACK_DISPATCH_FAILED'});
      statuses.set(request.batch_id,{turn_status:'ok'});
      return {execution_finished:true,semantic_ack_received:drafts.has(request.batch_id),unresolved_event_ids:central.map(event=>event.event_id)};
    }
    return {saved:true};
  };
  const mount=()=>mountRecentEventsWorker({ctx,agent,lifeId,sessionId,role,rpc,verify:actual=>assert.equal(actual,agent)});
  let worker=mount();
  return {agent,session,ctx,journal,central,batches,requests,external,pending,stepPending,tools,sections,
    get worker(){return worker;},get flushes(){return flushes;},get concluded(){return concluded;},setAckFailure(value){ackFailure=value;},setCompleteFailure(value){completeFailure=value;},
    setPrepareFailure(value){prepareFailure=value;},setFailReceiptFailure(value){failReceiptFailure=value;},setClock(value){clock=value;},setBatchStatus(id,turn_status){statuses.set(id,{turn_status});},remount(){worker.dispose();worker=mount();return worker;},
    async preStep(turn,{messages=[],addedMessages=[],step=1,actual=agent}={}) {
      let next=async()=>({kind:'enter',messages:[...messages,...addedMessages]});
      for(const callback of [...listeners.get('agent/pre-step')??[]].reverse()){const prior=next;next=()=>callback({agent:actual,turn,step,messages,signal:new AbortController().signal},prior);}
      return next();
    },
    accept(decision){for(const message of decision.messages)session.append('user/message',message,{surfaceOp:{op:'append'}});},
    async stopping(turn) {for(const fn of listeners.get('agent/turn-stopping')??[])await fn({agent,turn,signal:new AbortController().signal});},
    async ack(turn,result=silent,{before=[],after=[]}={}) {
      const callId='TEST ONLY ack-'+turn+'-'+journal.length;
      session.append('assistant/message',{turn,step:1,message:{role:'assistant',content:[...before,{type:'tool-call',id:callId,name:'life_turn_ack',arguments:JSON.stringify(result)},...after]}});
      const call=session.append('tool/call',{turn,step:1,callId,name:'life_turn_ack',arguments:JSON.stringify(result)});
      try {
        const value=await tools.get('life_turn_ack').execute(result,{agent,callId,signal:new AbortController().signal,concludeTurn(){concluded++;}});
        session.append('tool/result',{turn,step:1,message:{role:'tool',source:{kind:'tool',callId},toolCallId:callId,isError:false,content:[{type:'text',text:JSON.stringify(value)}]}},{surfaceOp:{op:'append'},sourceEventSeqs:[call.seq]});return value;
      }catch(error) {
        session.append('tool/result',{turn,step:1,message:{role:'tool',source:{kind:'tool',callId},toolCallId:callId,isError:true,content:[{type:'text',text:error.code??error.message}]},error:{code:error.code??'TEST_ERROR'}},{surfaceOp:{op:'append'},sourceEventSeqs:[call.seq]});throw error;
      }
    },
    tool(turn,name,{isError=false,args={}}={}) {
      const callId='TEST ONLY call-'+journal.length,call=session.append('tool/call',{turn,step:1,callId,name,arguments:JSON.stringify(args)});
      return session.append('tool/result',{turn,step:1,message:{role:'tool',source:{kind:'tool',callId},toolCallId:callId,isError,content:[{type:'text',text:'TEST ONLY result'}]}},{surfaceOp:{op:'append'},sourceEventSeqs:[call.seq]});
    },
  };
}

test('startup explains an old artificial ACK-gate failure without changing its native history or waking a model',async()=>{
 const t=fixture();try{
  await t.worker.drain();t.session.append('turn/start',{turn:99});
  t.session.append('turn/end',{turn:99,reason:{kind:'error',error:{code:'UNKNOWN',message:'ACTION_RESULT_ACK_REQUIRED'}}});
  const original=JSON.stringify(t.journal);t.remount();await t.worker.drain();
  const notice=t.requests.find(row=>row.operation==='emit').event;
  assert.equal(notice.payload.code,'LEGACY_ACK_GATE_FAILURE');assert.equal(notice.payload.native_turn,99);
  assert.equal(JSON.stringify(t.journal),original);assert.deepEqual(t.pending,[]);assert.equal(t.requests.filter(row=>row.operation==='prepare').length,0);
 }finally{t.worker.dispose();}
});

test('each turn admits a fixed visible recent snapshot and preserves the prior surface prefix',async()=>{
  const t=fixture();try {
    t.central.push({...event('TEST ONLY invisible event',2),visibility:{members:['TEST ONLY OTHER LIFE']}});
    t.session.append('turn/start',{turn:1});const first=await t.preStep(1);t.accept(first);
    const envelope=first.messages.at(-1),text=envelope.content[0].text;
    assert.equal(envelope.source.kind,'life-recent-events');assert(text.includes('TEST ONLY event-a'));assert(!text.includes('invisible event'));
    assert(text.includes('To: 我'));assert(text.includes('【本次唤醒 · Host Delta】'));assert(text.indexOf('【本次唤醒 · Host Delta】')>text.indexOf('TEST ONLY event-a'));
    assert(text.includes('北京 2026-10-06'));assert.notEqual(t.batches[0].delivered_at_utc,t.central[0].occurred_at_utc);
    t.central.push(event('TEST ONLY event-b',3,at+1000));
    assert.deepEqual((await t.preStep(1,{step:2})).messages,[]);assert.equal(t.requests.filter(r=>r.operation==='prepare').length,1);
    assert(!text.includes('event-b'));
    t.setClock(at+2000);t.session.append('turn/start',{turn:2});const second=await t.preStep(2);t.accept(second);
    assert(second.messages.at(-1).content[0].text.includes('event-b'));
    const surface=t.session.surface.nodes.map(seq=>t.session.eventAt(seq));assert.equal(surface.filter(e=>e.data.source?.kind==='life-recent-events').length,2);
    assert.equal(surface.find(e=>e.data.source?.kind==='life-recent-events').data.content[0].text,text);
    assert.equal(t.journal.filter(e=>e.type==='user/message'&&e.data.source?.kind==='life-recent-events').length,2);
    assert.equal(t.journal.filter(e=>e.data.source?.kind==='life-recent-events-retired').length,0);
  }finally{t.worker.dispose();}
});

test('silent machine ACK concludes the native turn without a public message, then completion flushes its journal',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));
    t.tool(1,'read');await t.ack(1);assert.equal(t.concluded,1);assert.deepEqual(t.external,[]);
    assert.equal(t.requests.filter(r=>r.operation==='complete').length,0);
    await t.stopping(1);t.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await t.worker.drain();
    assert.equal(t.flushes,1);assert.equal(t.requests.filter(r=>r.operation==='complete').length,1);assert.equal(t.worker.status().completed,1);
    assert.equal(t.worker.status().failed,0);assert.deepEqual(t.worker.status().active_batches,[]);
  }finally{t.worker.dispose();}
});

test('missing, failed, and interrupted ACK paths never report completion or infer silence',async()=>{
  for(const mode of ['missing','dispatch-failed','interrupted']) {
    const t=fixture();try {
      t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));
      if(mode==='dispatch-failed'){t.setAckFailure(true);await assert.rejects(t.ack(1),/TEST ONLY failure/);}
      else if(mode==='interrupted')await t.ack(1);
      await t.stopping(1);
      t.session.append('turn/end',{turn:1,reason:{kind:mode==='interrupted'?'aborted':'error',error:{code:'TEST_FAILURE'}}});await t.worker.drain();
      assert.equal(t.requests.filter(r=>r.operation==='complete').length,0);assert.equal(t.requests.filter(r=>r.operation==='fail').length,1);
      assert.equal(t.worker.status().failed,1);assert.equal(t.requests.at(-1).turn_status,mode==='interrupted'?'interrupted':'failed');
    }finally{t.worker.dispose();}
  }
});

test('ACK cannot send and rejects silence after actual send or a nonfinal ACK',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));
    const forbidden={...silent,disposition:'acted',actions:[{type:'send_message',conversation_id:'TEST ONLY OTHER ROOM',body:'TEST ONLY forbidden ACK action'}]};
    await assert.rejects(t.ack(1,forbidden),error=>error.code==='OUTWARD_ACTION_USE_SEND_MESSAGE');assert.deepEqual(t.external,[]);
    t.tool(1,'life_send_message');
    await assert.rejects(t.ack(1),/ACTION_RESULT_SILENT_AFTER_PUBLIC_ACTION/);
    const result={...silent,disposition:'acted'};
    await assert.rejects(t.ack(1,result,{after:[{type:'tool-call',id:'TEST ONLY later',name:'write',arguments:'{}'}]}),/ACTION_RESULT_ACK_MUST_BE_LAST/);
    await t.ack(1,result);t.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await t.worker.drain();
    assert.equal(t.worker.status().completed,1);assert.deepEqual(t.external,[]);
  }finally{t.worker.dispose();}
});

test('tool hooks never decide what to record; native results stay in journal',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));
    const completed=t.tool(1,'write');t.tool(1,'read');t.tool(1,'web_search',{isError:true});t.tool(1,'life_send_message');t.tool(1,'private_write');t.tool(1,'edit');
    await t.worker.drain();assert.equal(t.requests.filter(r=>r.operation==='emit').length,0);
    assert(t.journal.includes(completed));
  }finally{t.worker.dispose();}
});

test('cold recovery exposes unknown mutation outcomes even before a Recent envelope existed',async()=>{
  const t=fixture();try {
    await t.worker.drain();
    t.session.append('turn/start',{turn:7});t.tool(7,'write',{isError:true,args:{path:'TEST ONLY PRIVATE PATH',content:'TEST ONLY PRIVATE BODY'}});
    t.session.append('turn/end',{turn:7,reason:{kind:'error'}});await t.worker.drain();
    assert.equal(t.requests.filter(row=>row.operation==='emit').length,0);
    t.remount();await t.worker.drain();
    const notice=t.requests.find(row=>row.operation==='emit').event;
    assert.equal(notice.source_key,'action-health:7');assert.equal(notice.payload.effect_results[0].status,'unknown');
    assert.equal(notice.payload.effect_results[0].tool_name,'write');assert(!JSON.stringify(notice).includes('PRIVATE'));
    t.session.append('turn/start',{turn:8});await t.preStep(8);
    assert.equal(t.requests.filter(row=>row.operation==='emit').length,1);
  }finally{t.worker.dispose();}
});

test('cold recovery exposes missing tool results despite an already terminal execution batch',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));
    t.session.append('tool/call',{turn:1,step:1,callId:'TEST ONLY LOST TOOL ACK',name:'schedule',arguments:'{}'});
    t.setBatchStatus(t.batches[0].batch_id,'failed');t.worker.dispose();
    t.session.append('turn/end',{turn:1,reason:{kind:'error'}});
    t.remount();await t.worker.drain();
    const notice=t.requests.find(row=>row.operation==='emit').event;
    assert.equal(notice.payload.effect_results[0].status,'unknown');assert.equal(notice.payload.effect_results[0].call_id,'TEST ONLY LOST TOOL ACK');
    assert.equal(t.requests.filter(row=>row.operation==='complete').length,0);
  }finally{t.worker.dispose();}
});

test('ACK waits for pending native internal context before dispatching or concluding',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));
    const internal=createUserMessage({source:{kind:'digital-life-state-reentry'},content:[{type:'text',text:'TEST ONLY pending internal context'}]});
    t.stepPending.push(internal);
    await assert.rejects(t.ack(1),error=>error.code==='ACTION_RESULT_ACK_PENDING_CONTEXT');
    assert.equal(t.concluded,0);assert.equal(t.requests.filter(row=>row.operation==='ack').length,0);assert.deepEqual(t.external,[]);
    const current=t.stepPending.splice(0);const decision=await t.preStep(1,{step:2,messages:current});t.accept(decision);
    assert.deepEqual(decision.messages,[internal]);assert.deepEqual(t.pending,[]);
    await t.ack(1);await t.stopping(1);t.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await t.worker.drain();
    assert.equal(t.concluded,1);assert.equal(t.worker.status().completed,1);
    assert.equal(t.requests.filter(row=>row.operation==='ack').length,1);assert.equal(t.requests.filter(row=>row.operation==='prepare').length,1);
  }finally{t.worker.dispose();}
});

test('native continuation after a saved ACK keeps semantic choices and can finish independently after receipt loss',async()=>{
  for(const mode of ['assistant','tool']) {
    const t=fixture();try {
      t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));await t.ack(1);
      if(mode==='assistant')t.session.append('assistant/message',{turn:1,step:2,message:{role:'assistant',content:[{type:'text',text:'TEST ONLY later work after ACK'}]}});
      else t.tool(1,'read');
      await t.stopping(1);
      t.setCompleteFailure(true);t.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await t.worker.drain();
      assert.equal(t.requests.filter(row=>row.operation==='complete').length,0);
      t.setCompleteFailure(false);t.remount();await t.worker.drain();
      assert.equal(t.worker.status().failed,0);assert.equal(t.worker.status().recovered,1);assert.equal(t.worker.status().completed,1);
      assert.equal(t.requests.filter(row=>row.operation==='complete').length,0);
      assert.equal(t.requests.filter(row=>row.operation==='fail').length,0);assert.equal(t.requests.filter(row=>row.operation==='finish_execution').length,2);
    }finally{t.worker.dispose();}
  }
});

test('trusted ACK removes only hook-added ambient snapshots and preserves claimed native continuations',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));await t.ack(1);
    const native=['digital-life-state-reentry','runtime-context','author-pressure-checkpoint'].map(kind=>createUserMessage({source:{kind},content:[{type:'text',text:'TEST ONLY claimed native '+kind}]}));
    const stimulus=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'TEST ONLY arrives after ACK'}]});
    const ambient=['time-context','runtime-context','life-current-state','persona-state'].map(kind=>createUserMessage({source:{kind,form:'snapshot'},content:[{type:'text',text:'TEST ONLY ambient '+kind}]}));
    const unknown=createUserMessage({source:{kind:'TEST_ONLY_INTERNAL_HOOK'},content:[{type:'text',text:'TEST ONLY unclassified internal contribution'}]});
    const decision=await t.preStep(1,{step:2,messages:[stimulus,...native],addedMessages:[...ambient,unknown]});
    assert.deepEqual(decision.messages,[...native,unknown]);assert.deepEqual(t.pending,[stimulus]);
    t.accept(decision);t.session.append('assistant/message',{turn:1,step:2,message:{role:'assistant',content:[{type:'text',text:'TEST ONLY later internal execution'}]}});
    await t.stopping(1);
    t.session.append('turn/end',{turn:1,reason:{kind:'error'}});await t.worker.drain();
    assert.equal(t.worker.status().completed,0);assert.equal(t.worker.status().failed,1);
  }finally{t.worker.dispose();}
});

test('cold native successful ACK reconciles its original batch without model or action replay',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));
    t.tool(1,'life_send_message');const result={...silent,disposition:'acted'};
    await t.ack(1,result);t.setCompleteFailure(true);t.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await t.worker.drain();
    assert.equal(t.external.length,0);assert.equal(t.worker.status().completed,0);assert.equal(t.worker.status().error_code,'TEST_ACK_DISPATCH_FAILED');
    const originalBatch=t.batches[0].batch_id;t.setCompleteFailure(false);t.remount();await t.worker.drain();
    assert.equal(t.external.length,0);assert.equal(t.worker.status().recovered,1);assert.equal(t.worker.status().completed,1);
    const completions=t.requests.filter(row=>row.operation==='complete');assert.equal(completions.length,2);assert(completions.every(row=>row.batch_id===originalBatch));
    assert.equal(t.requests.filter(row=>row.operation==='prepare').length,1);
    t.remount();await t.worker.drain();assert.equal(t.requests.filter(row=>row.operation==='complete').length,2);
  }finally{t.worker.dispose();}
});

test('cold native completed turn without ACK finishes execution, exposes unfinished inputs, and never invents Agent silence',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));t.setCompleteFailure(true);
    t.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await t.worker.drain();
    t.setCompleteFailure(false);t.remount();await t.worker.drain();
    assert.equal(t.worker.status().failed,0);assert.equal(t.worker.status().recovered,1);assert.equal(t.worker.status().completed,1);
    assert.equal(t.requests.filter(row=>row.operation==='complete').length,0);assert.equal(t.requests.filter(row=>row.operation==='ack').length,0);assert.deepEqual(t.external,[]);
    const finish=t.requests.filter(row=>row.operation==='finish_execution');assert.equal(finish.length,2);assert.equal(Object.hasOwn(finish[1],'result'),false);
    assert.equal(t.requests.filter(row=>row.operation==='emit').at(-1).event.payload.code,'INPUT_DECISION_NOT_RECORDED');
  }finally{t.worker.dispose();}
});

test('cold recovery preserves terminal central batches even when their native journal completed successfully',async()=>{
  for(const status of ['failed','interrupted','ok']) {
    const t=fixture();try {
      t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));await t.ack(1);
      t.setCompleteFailure(true);t.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await t.worker.drain();
      t.setCompleteFailure(false);t.setBatchStatus(t.batches[0].batch_id,status);
      t.batches[0].visibility_revoked=true;t.batches[0].events=[];
      const before=t.requests.filter(row=>['complete','fail'].includes(row.operation)).length;
      t.remount();await t.worker.drain();
      assert.equal(t.requests.filter(row=>['complete','fail'].includes(row.operation)).length,before);
      assert.equal(t.worker.status().recovered,0);assert.equal(t.worker.status().error_code,null);
      t.session.append('turn/start',{turn:2});t.accept(await t.preStep(2));assert.equal(t.batches.length,2);
    }finally{t.worker.dispose();}
  }
});

test('cold recovery fails revoked pending metadata without replaying success or blocking the next turn',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));await t.ack(1);
    t.setCompleteFailure(true);t.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await t.worker.drain();
    t.setCompleteFailure(false);t.batches[0].visibility_revoked=true;t.batches[0].events=[];
    t.remount();await t.worker.drain();
    assert.equal(t.worker.status().failed,1);assert.equal(t.worker.status().recovered,1);
    assert.equal(t.requests.filter(row=>row.operation==='complete').length,1);
    const receipt=t.requests.filter(row=>row.operation==='fail').at(-1);
    assert.equal(receipt.batch_id,t.batches[0].batch_id);assert.equal(receipt.error_code,'DELIVERY_BATCH_VISIBILITY_REVOKED');assert(!('events' in receipt));
    t.session.append('turn/start',{turn:2});t.accept(await t.preStep(2));assert.equal(t.batches.length,2);
    assert.equal(t.worker.status().error_code,null);
  }finally{t.worker.dispose();}
});

test('claimed direct inputs and asynchronous stimuli wait for the next turn while tool continuations stay current',async()=>{
  const t=fixture();try {
    t.session.append('turn/start',{turn:1});t.accept(await t.preStep(1));
    const incoming=['user','schedule','subagent-settled','tool-jobs'].map((kind,index)=>({id:'TEST ONLY delayed '+index,role:'user',source:{kind},content:[{type:'text',text:'TEST ONLY new '+kind}]}));
    const continuation={id:'TEST ONLY tool continuation',role:'user',source:{kind:'digital-life-state-reentry'},content:[{type:'text',text:'TEST ONLY existing tool continuation'}]};
    const checkpoint={id:'TEST ONLY native checkpoint',role:'user',source:{kind:'author-pressure-checkpoint',rpcId:'TEST ONLY internal RPC'},content:[{type:'text',text:'TEST ONLY internal checkpoint'}]};
    const toolReply={id:'TEST ONLY tool reply',role:'tool',source:{kind:'user'},content:[{type:'text',text:'TEST ONLY tool result remains'}]};
    const decision=await t.preStep(1,{step:2,messages:[...incoming,continuation,checkpoint,toolReply]});
    assert.deepEqual(decision.messages,[continuation,checkpoint,toolReply]);assert.deepEqual(t.pending,incoming);
    assert(t.pending.every((message,index)=>message===incoming[index]));assert.equal(t.flushes,1);assert.equal(t.worker.status().postponed,4);
    assert.equal(t.requests.filter(row=>row.operation==='prepare').length,1);
    await t.ack(1);t.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await t.worker.drain();
    t.session.append('turn/start',{turn:2});t.accept(await t.preStep(2,{messages:[t.pending.shift()]}));
    const preparation=t.requests.filter(row=>row.operation==='prepare').at(-1);
    assert.deepEqual(preparation.trigger_messages,[{id:incoming[0].id,source:incoming[0].source,content:incoming[0].content}]);
  }finally{t.worker.dispose();}
});

test('initial raw input coalesces only the existing raw queue prefix through native claims without canceled work',async()=>{
  const t=fixture();try {
    const first=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'TEST ONLY first raw input'}]});
    const backlog=['user','developer-test','external-stimulus'].map(kind=>createUserMessage({source:{kind},content:[{type:'text',text:'TEST ONLY raw '+kind}]}));
    const room=createUserMessage({source:{kind:'room-inbox-batch'},content:[{type:'text',text:'TEST ONLY Room stays in its path'}]});
    const tail=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'TEST ONLY after Room'}]});
    t.pending.push(...backlog,room,tail);t.session.append('turn/start',{turn:1});const decision=await t.preStep(1,{messages:[first]});t.accept(decision);
    assert.deepEqual(decision.messages.slice(0,-1),[first,...backlog]);assert.deepEqual(t.pending,[room,tail]);
    assert.equal(t.worker.status().coalesced,3);assert.equal(t.flushes,1);
    assert.deepEqual(t.requests.find(row=>row.operation==='prepare').trigger_messages.map(message=>message.id),[first,...backlog].map(message=>message.id));
    assert.equal(t.journal.filter(item=>item.type==='agent/inbox/spliced'&&item.data.removedCount===1).length,3);
    assert(!t.journal.some(item=>item.type==='agent/inbox/spliced'&&item.data.outcome==='canceled'));
    assert(t.journal.filter(item=>item.type==='user/message'&&backlog.some(message=>message.id===item.data.id)).length===3);
  }finally{t.worker.dispose();}
});

test('raw coalescing preserves pending next-step continuations and restores extra exact messages if prepare fails',async()=>{
  for(const mode of ['continuation','prepare-failure']) {
    const t=fixture();try {
      const first=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'TEST ONLY claimed first'}]});
      const backlog=Array.from({length:3},(_,index)=>createUserMessage({source:{kind:'user'},content:[{type:'text',text:'TEST ONLY backlog '+index}]}));
      t.pending.push(...backlog);t.session.append('turn/start',{turn:1});
      if(mode==='continuation') {
        const internal=createUserMessage({source:{kind:'digital-life-state-reentry'},content:[{type:'text',text:'TEST ONLY pending internal'}]});t.stepPending.push(internal);
        const decision=await t.preStep(1,{messages:[first]});assert.deepEqual(decision.messages.slice(0,-1),[first]);assert.deepEqual(t.stepPending,[internal]);
      }else {t.setPrepareFailure(true);await assert.rejects(t.preStep(1,{messages:[first]}),/TEST ONLY failed prepare/);assert.equal(t.flushes,2);}
      assert.deepEqual(t.pending,backlog);assert(t.pending.every((message,index)=>message===backlog[index]));assert.equal(t.worker.status().coalesced,0);
      assert(!t.journal.some(item=>item.type==='agent/inbox/spliced'&&item.data.outcome==='canceled'));
    }finally{t.worker.dispose();}
  }
});

test('scope requires the exact owner Agent and static mock sessions stay read-only',async()=>{
  const t=fixture({role:'activity',sessionId:'TEST ONLY activity'});try {
    t.session.append('turn/start',{turn:1});const decision=await t.preStep(1,{actual:{...t.agent}});assert.deepEqual(decision.messages,[]);
    await assert.rejects(t.tools.get('life_turn_ack').execute(silent,{agent:{...t.agent},signal:new AbortController().signal}),/RECENT_EVENTS_SESSION_REQUIRED/);
    assert.equal(t.requests.length,0);assert(t.sections.get('life:recent-events-protocol').text().includes('事件正文和 payload'));
  }finally{t.worker.dispose();}assert.equal(t.tools.size,0);assert.equal(t.sections.size,0);
  const mock=fixture({withJournal:false});try {assert.deepEqual((await mock.preStep(1)).messages,[]);assert.equal(mock.requests.length,0);}finally{mock.worker.dispose();}
});

test('real native kernel concludes a successful ACK and also permits natural completion without inventing an ACK',async()=>{
  const isolated=await createFixture(['RECENT WORKER']),registry=new LifeRegistry({root:isolated.registryRoot,mode:'fixture'});
  let host,worker,delayedNative,internalNative,mode='silent',lateStage=0,backlogStage=0,reentryStage=0,active=0,maxActive=0;const receipts=[],modelRequests=[],queued=[];
  const held=Promise.withResolvers(),release=Promise.withResolvers();
  class Stub extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000}};}
    async *stream(options) {
      active++;maxActive=Math.max(maxActive,active);try {
      assert(Object.isFrozen(options)&&Object.isFrozen(options.messages));modelRequests.push(options);
      assert(options.tools.some(tool=>tool.name==='life_turn_ack'));
      assert(options.messages.some(message=>message.source?.kind==='life-recent-events'&&message.content[0].text.includes('【本次唤醒 · Host Delta】')));
      let block=mode==='missing'?{type:'text',text:'TEST ONLY absent machine ACK'}:{type:'tool-call',id:randomUUID(),name:'life_turn_ack',arguments:JSON.stringify(silent)};
      if(mode==='late') {
        lateStage++;
        if(lateStage===1)block={type:'tool-call',id:randomUUID(),name:'test_step_continue',arguments:'{}'};
        if(lateStage===2)assert(!options.messages.some(message=>message.id===delayedNative.id));
        if(lateStage===3)assert(options.messages.some(message=>message.id===delayedNative.id));
      }
      if(mode==='backlog') {
        backlogStage++;
        if(backlogStage===1)block={type:'tool-call',id:randomUUID(),name:'test_hold_batch',arguments:'{}'};
        if(backlogStage===2)assert(queued.every(input=>!options.messages.some(message=>message.id===input.id)));
        if(backlogStage===3)assert(queued.every(input=>options.messages.some(message=>message.id===input.id)));
      }
      let blocks=[block];
      if(mode==='reentry') {
        reentryStage++;
        if(reentryStage===1)blocks=[{type:'tool-call',id:randomUUID(),name:'test_internal_continue',arguments:'{}'},block];
        if(reentryStage===2) {
          assert(options.messages.some(message=>message.id===internalNative.id));
          assert(options.messages.some(message=>message.role==='tool'&&message.isError===true&&message.content.some(part=>part.type==='text'&&part.text.includes('ACTION_RESULT_ACK_PENDING_CONTEXT'))));
        }
        assert(reentryStage<=2);
      }
      for(const [index,output] of blocks.entries()) {
        yield {type:'block-start',index,blockType:output.type};
        if(output.type==='tool-call')yield {type:'tool-call-delta',index,id:output.id,name:output.name,argumentsDelta:output.arguments};
        else yield {type:'text-delta',index,text:output.text};
        yield {type:'block-end',index,block:output};
      }
      yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:blocks.some(output=>output.type==='tool-call')?'tool-calls':'stop'}};
      }finally{active--;}
    }
  }
  try {
    const manifest=isolated.manifests[0];registry.register(manifest);
    host=await bootScoped({registry,root:isolated.nativeRoot,fixtureRoot:isolated.root,adapter:new Stub(),providerRoutes:[manifest.deployment.provider]});
    const agent=await host.runtime.create({lifeId:manifest.lifeId,sessionId:manifest.authoritySessionId,role:'authority'});
    agent.ctx.tools.register(defineTool({name:'test_step_continue',description:'TEST ONLY local fixed-batch continuation',parameters:{},output:{schema:{type:'json'}},
      execute(){delayedNative=createUserMessage({content:[{type:'text',text:'TEST ONLY arrived during ongoing native turn'}],source:{kind:'user'}});agent.steer(delayedNative);return {saved:true};}}));
    agent.ctx.tools.register(defineTool({name:'test_hold_batch',description:'TEST ONLY hold one native turn while four inputs arrive',parameters:{},output:{schema:{type:'json'}},
      async execute(){held.resolve();await release.promise;return {saved:true};}}));
    agent.ctx.tools.register(defineTool({name:'test_internal_continue',description:'TEST ONLY defer native internal context before an early ACK',parameters:{},output:{schema:{type:'json'}},isConcurrencySafe:()=>false,
      execute(_args,exec){internalNative=createUserMessage({source:{kind:'digital-life-state-reentry'},content:[{type:'text',text:'TEST ONLY mandatory internal continuation'}]});exec.deferContext(internalNative);return {saved:true};}}));
    worker=mountRecentEventsWorker({ctx:host.ctx,agent,lifeId:manifest.lifeId,sessionId:agent.session.id,role:'authority',verify:actual=>host.contexts.forAgent(actual),
      rpc:async(operation,{recent:request})=>{
        assert.equal(operation,'timeline');receipts.push(structuredClone(request));
        if(request.operation==='prepare')return {batch:{batch_id:'TEST ONLY native batch '+request.wake_id,life_id:manifest.lifeId,authority_session_id:agent.session.id,wake_id:request.wake_id,delivered_at_utc:new Date().toISOString(),event_ids:[],events:[],snapshot_cutoff_seq:0},events:[],char_budget:20000};
        if(request.operation==='ack')return {acknowledged:true,result:request.result,delivery_batch_id:request.batch_id};
        if(request.operation==='validate_ack')return {valid:true};
        return {saved:true};
      }});
    const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('TEST ONLY native worker deadline')),10000);})]);}finally{clearTimeout(timer);}};
    const prompt=()=>host.runtime.prompt({lifeId:manifest.lifeId,sessionId:agent.session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY explicit ACK flow'}]});
    await prompt();await bounded(agent.whenIdle());await worker.drain();
    assert.equal(modelRequests.length,1);assert.equal(receipts.filter(row=>row.operation==='complete').length,1);
    const first=[...agent.session.ownEvents()];assert.equal(first.findLast(item=>item.type==='turn/end').data.reason.kind,'completed');
    const ackCall=first.find(item=>item.type==='tool/call'&&item.data.name==='life_turn_ack');
    assert(first.some(item=>item.type==='tool/result'&&item.sourceEventSeqs?.includes(ackCall.seq)&&item.data.message.isError===false));
    assert(!first.some(item=>item.type==='assistant/message'&&item.data.message.content.some(block=>block.type==='text')));
    mode='missing';await prompt();await bounded(agent.whenIdle());await worker.drain();
    assert.equal(modelRequests.length,2);assert.equal(receipts.filter(row=>row.operation==='complete').length,1);assert.equal(receipts.filter(row=>row.operation==='fail').length,0);
    assert.equal(receipts.filter(row=>row.operation==='finish_execution').length,1);
    assert.equal([...agent.session.ownEvents()].findLast(item=>item.type==='turn/end').data.reason.kind,'completed');
    mode='late';await prompt();await bounded(agent.whenIdle());await worker.drain();
    assert.equal(lateStage,3);assert.equal(modelRequests.length,5);assert.equal(worker.status().postponed,1);
    const lateEvents=[...agent.session.ownEvents()],lateMessage=lateEvents.find(item=>item.type==='user/message'&&item.data.id===delayedNative.id);
    assert.equal(lateEvents.findLast(item=>item.type==='turn/start'&&item.seq<lateMessage.seq).data.turn,4);
    assert(lateEvents.some(item=>item.type==='agent/inbox/spliced'&&item.data.target==='next-turn'&&item.data.inserted.some(message=>message.id===delayedNative.id)));
    assert.equal(receipts.filter(row=>row.operation==='complete').length,3);assert.equal(receipts.filter(row=>row.operation==='fail').length,0);
    mode='backlog';await prompt();await bounded(held.promise);
    for(let index=0;index<4;index++) {
      const message=createUserMessage({source:{kind:'user',rpcId:'TEST ONLY raw backlog '+index},content:[{type:'text',text:'TEST ONLY queued while busy '+index}]});queued.push(message);
      if(index%2===0)agent.steer(message);else agent.followup(message);
    }
    assert.equal(agent.status,'running');assert.equal([...agent.session.ownEvents()].findLast(item=>item.type==='turn/start').data.turn,5);
    release.resolve();await bounded(agent.whenIdle());await worker.drain();
    assert.equal(backlogStage,3);assert.equal(maxActive,1);assert.equal(active,0);assert.equal(modelRequests.length,8);assert.equal(worker.status().coalesced,3);
    const finalEvents=[...agent.session.ownEvents()],admitted=finalEvents.filter(item=>item.type==='user/message'&&queued.some(message=>message.id===item.data.id));
    assert.equal(admitted.length,4);assert(admitted.every(item=>finalEvents.findLast(start=>start.type==='turn/start'&&start.seq<item.seq).data.turn===6));
    assert(admitted.every(item=>JSON.stringify(item.data.source)===JSON.stringify(queued.find(message=>message.id===item.data.id).source)));
    assert(!finalEvents.some(item=>item.type==='agent/inbox/spliced'&&item.data.outcome==='canceled'));
    const lastPrepare=receipts.filter(row=>row.operation==='prepare').at(-1);assert.equal(lastPrepare.wake_id,agent.session.id+':6');
    assert.deepEqual(new Set(lastPrepare.trigger_messages.map(message=>message.id)),new Set(queued.map(message=>message.id)));
    assert.equal(receipts.filter(row=>row.operation==='complete').length,5);assert.equal(receipts.filter(row=>row.operation==='fail').length,0);
    const ackReceiptsBefore=receipts.filter(row=>row.operation==='ack').length;
    mode='reentry';await prompt();await bounded(agent.whenIdle());await worker.drain();
    assert.equal(reentryStage,2);assert.equal(modelRequests.length,10);assert.equal(maxActive,1);assert.equal(active,0);
    const reentryEvents=[...agent.session.ownEvents()].filter(item=>item.data.turn===7);
    const attempts=reentryEvents.filter(item=>item.type==='tool/call'&&item.data.name==='life_turn_ack');assert.equal(attempts.length,2);
    const results=attempts.map(call=>reentryEvents.find(item=>item.type==='tool/result'&&item.sourceEventSeqs?.includes(call.seq)));
    assert.equal(results[0].data.message.isError,true);assert(results[0].data.message.content.some(part=>part.type==='text'&&part.text.includes('ACTION_RESULT_ACK_PENDING_CONTEXT')));
    assert.equal(results[1].data.message.isError,false);assert(results[1].seq>results[0].seq);
    assert.equal(reentryEvents.findLast(item=>item.type==='turn/end').data.reason.kind,'completed');
    assert.equal([...agent.session.ownEvents()].findLast(item=>item.type==='turn/start').data.turn,7);
    const internalEvent=[...agent.session.ownEvents()].find(item=>item.type==='user/message'&&item.data.id===internalNative.id);
    assert(internalEvent&&internalEvent.seq>results[0].seq&&internalEvent.seq<results[1].seq);
    assert(![...agent.inbox.nextStep,...agent.inbox.nextTurn].some(message=>message.id===internalNative.id));
    assert.equal(receipts.filter(row=>row.operation==='ack').length,ackReceiptsBefore+1);
    assert.equal(receipts.filter(row=>row.operation==='prepare').at(-1).wake_id,agent.session.id+':7');
    assert.equal(receipts.filter(row=>row.operation==='complete').length,6);assert.equal(receipts.filter(row=>row.operation==='fail').length,0);
  }finally{release.resolve();await worker?.drain();worker?.dispose();await host?.ctx.fiber.dispose();registry.close();await isolated.cleanup();}
});

test('real native Loader with per-step ambient context ends a held ACK before processing late steer exactly once, including cold recovery',async()=>{
  const f=await createFixture(['ACK WINDOW']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'}),manifest=f.manifests[0];
  let host,agent,worker,late,active=0,maxActive=0,ambientCount=0,coldRecovery=false;
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),requests=[],receipts=[],batches=new Map();
  class Stub extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000}};}
    async *stream(options) {
      active++;maxActive=Math.max(maxActive,active);try {
        requests.push(options);assert(options.messages.some(message=>message.source?.kind==='time-context'));
        if(requests.length===2)assert(options.messages.some(message=>message.id===late.id));
        assert(requests.length<=2,'late steer must not create another model step in the completed batch');
        const block={type:'tool-call',id:randomUUID(),name:'life_turn_ack',arguments:JSON.stringify(silent)};
        yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};
        yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:'tool-calls'}};
      }finally{active--;}
    }
  }
  const bootOptions={registry,root:f.nativeRoot,fixtureRoot:f.root,adapter:new Stub(),providerRoutes:[manifest.deployment.provider]};
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST_ONLY_ACK_WINDOW_DEADLINE')),10000);})]);}finally{clearTimeout(timer);}};
  const rpc=async(operation,{recent:input})=>{
    assert.equal(operation,'timeline');receipts.push(structuredClone(input));
    if(input.operation==='inspect')return {life_id:manifest.lifeId,state:{batches:Object.fromEntries(batches),batch_status:Object.fromEntries([...batches].map(([id])=>[id,{turn_status:coldRecovery?'dispatched':'ok'}]))}};
    if(input.operation==='validate_ack')return {valid:true};
    if(input.operation==='prepare') {
      const batch={batch_id:'TEST ONLY ack window '+input.wake_id,life_id:manifest.lifeId,authority_session_id:agent.session.id,wake_id:input.wake_id,
        delivered_at_utc:new Date().toISOString(),event_ids:[],events:[],snapshot_cutoff_seq:0};batches.set(batch.batch_id,batch);return {batch,events:[],char_budget:20000};
    }
    if(input.operation==='ack') {
      if(receipts.filter(item=>item.operation==='ack').length===1){entered.resolve();await release.promise;}
      return {acknowledged:true,result:input.result,delivery_batch_id:input.batch_id};
    }
    return {saved:true};
  };
  const mount=()=>mountRecentEventsWorker({ctx:host.ctx,agent,lifeId:manifest.lifeId,sessionId:agent.session.id,role:'authority',verify:actual=>host.contexts.forAgent(actual),rpc});
  try {
    registry.register(manifest);host=await bootScoped(bootOptions);agent=await host.runtime.create({lifeId:manifest.lifeId,sessionId:manifest.authoritySessionId,role:'authority'});
    // This is the formal time-context seam: each pre-step adds fresh ambient
    // messages even when its claimed waking input is removed downstream.
    host.ctx.on('agent/pre-step',async({agent:actual,turn,step},next)=>{
      const decision=await next();if(actual!==agent||decision.kind==='reject')return decision;ambientCount++;
      return {...decision,messages:[...decision.messages,...['time-context','runtime-context'].map(kind=>createUserMessage({source:{kind,form:'snapshot'},
        content:[{type:'text',text:'TEST ONLY dynamic '+kind+' '+turn+':'+step+':'+ambientCount}]}))]};
    },{prepend:true});
    worker=mount();
    await host.runtime.prompt({lifeId:manifest.lifeId,sessionId:agent.session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY first ACK window turn'}]});await bounded(entered.promise);
    assert.equal(agent.status,'running');assert.equal(agent.inbox.nextStep.length,0);
    late=createUserMessage({source:{kind:'user',rpcId:'TEST ONLY late ACK window input'},content:[{type:'text',text:'TEST ONLY arrived during central ACK'}]});agent.steer(late);
    assert.equal(agent.inbox.nextStep[0].id,late.id);release.resolve();await bounded(agent.whenIdle());await worker.drain();await host.ctx.sessions.flush(agent.session);
    assert.equal(requests.length,2);assert.equal(maxActive,1);assert.equal(active,0);assert.equal(ambientCount,3);
    assert.equal(worker.status().postponed,1);assert.equal(worker.status().completed,2);assert.equal(worker.status().failed,0);
    assert.equal(receipts.filter(item=>item.operation==='ack').length,2);assert.equal(receipts.filter(item=>item.operation==='complete').length,2);
    const events=[...agent.session.ownEvents()];assert.equal(events.filter(item=>item.type==='step/start'&&item.data.turn===1).length,1);
    assert.equal(events.filter(item=>item.type==='assistant/message'&&item.data.turn===1).length,1);
    const admitted=events.filter(item=>item.type==='user/message'&&item.data.id===late.id);assert.equal(admitted.length,1);
    assert.deepEqual(admitted[0].data.source,late.source);assert.equal(events.findLast(item=>item.type==='turn/start'&&item.seq<admitted[0].seq).data.turn,2);
    assert(!events.some(item=>item.type==='agent/inbox/spliced'&&item.data.outcome==='canceled'));
    assert.deepEqual(receipts.filter(item=>item.operation==='prepare').at(-1).trigger_messages.map(message=>message.id),[late.id]);
    for(const turn of [1,2])assert.deepEqual(findTurnActionResult(events,{turn}).result,silent);
    worker.dispose();worker=undefined;await host.ctx.fiber.dispose();host=undefined;
    host=await bootScoped(bootOptions);assert.equal(host.ctx.sessions.get(manifest.authoritySessionId),undefined);
    const persisted=await host.ctx.sessionQuery.observeSession(manifest.authoritySessionId,{projectionMode:'all'});
    try {for(const turn of [1,2])assert.deepEqual(findTurnActionResult([...persisted.events],{turn}).result,silent);}finally{persisted[Symbol.dispose]();}
    agent=await host.runtime.resolve({lifeId:manifest.lifeId,sessionId:manifest.authoritySessionId});coldRecovery=true;worker=mount();await worker.drain();
    assert.equal(worker.status().completed,2);assert.equal(worker.status().recovered,2);assert.equal(worker.status().failed,0);
    assert.equal(requests.length,2);assert.equal(receipts.filter(item=>item.operation==='ack').length,2);
    assert(receipts.filter(item=>item.operation==='complete').every(item=>batches.has(item.batch_id)));
  }finally{release.resolve();await worker?.drain();worker?.dispose();await host?.ctx.fiber.dispose();registry.close();await f.cleanup();}
});
