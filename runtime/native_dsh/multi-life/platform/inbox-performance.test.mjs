import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {mountRoomInbox,deliveryEvidenceUnchanged} from './legacy-room-inbox.mjs';
import {nativeInboxEvidence} from './inbox-recovery.mjs';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {LifeContexts} from '../context.mjs';
import {TaskStore} from './tasks.mjs';
import {Conversations} from './conversations.mjs';
import {WorkerGateway} from './worker-gateway.mjs';

// Isolated scheduling/transport fixture. No provider, production state or Host.
async function fixture(history=0){
  const lifeId='life-'+randomUUID(),sessionId=randomUUID(),root=mkdtempSync(join(tmpdir(),'inbox-perf-'));
  const events=[],rows=[],trace=[],nextTurn=[],nextStep=[],controllers=[];
  const append=(type,data)=>events.push({seq:events.length,time:Date.now(),type,data});
  let executions=0,loseAck=false;
  const makeRow=(n,attempt=null)=>({inbox_id:'TEST-'+n,inbox_seq:n+1,owner_life_id:lifeId,execution_session_id:sessionId,
    room_id:'TEST-room',message_id:'TEST-message-'+n,revision:1,status:'pending',requested:false,received_at:'2026-01-01T00:00:00Z',attempt,
    message:{sender_type:'human',sender_id:'human:test',message_id:'TEST-message-'+n,body:'TEST input '+n,
      body_hash:createHash('sha256').update('TEST input '+n).digest('hex')}});
  for(let n=0;n<history;n++){
    const rpc='TEST-rpc-'+n;append('turn/start',{turn:n+1});append('user/message',{source:{rpcId:rpc},id:randomUUID()});append('turn/end',{turn:n+1,reason:{kind:'completed'}});
    rows.push(makeRow(n,{attempt_id:randomUUID(),session_id:sessionId,request_id:rpc,state:'completed',inbox_ids:['TEST-'+n]}));
  }
  for(const row of rows)row.attempt.native_evidence=nativeInboxEvidence({events,pending:[],requestId:row.attempt.request_id,running:false});
  const tools={register:()=>()=>{}},systemPrompt={section:()=>()=>{}};
  const agent={status:'idle',session:{id:sessionId,header:{id:sessionId},ownEvents:()=>events.values()},ctx:{tools,systemPrompt},
    inbox:{nextTurn,nextStep,remove(id){const at=nextTurn.findIndex(m=>m.id===id);if(at>=0)nextTurn.splice(at,1);}},
    runMaintenance:fn=>fn(new AbortController().signal),
    send(message,target,wake){trace.push('send:'+wake);nextTurn.push(message);if(wake){executions++;nextTurn.splice(0);const turn=history+executions;
      append('turn/start',{turn});append('user/message',{...message});append('turn/end',{turn,reason:{kind:'completed'}});}}
  };
  const ctx={agents:{get:()=>agent},sessions:{flush:async()=>{trace.push('flush');}},on:()=>()=>{},effect:()=>{}};
  let remote=0,fullInspect=0;
  const bridge={status:()=>({ready:true,life_id:lifeId,registered_session_id:sessionId}),
    inspect:async()=>{fullInspect++;throw Error('full status/list must not be polled');},
    inspectInbox:async({after,limit})=>{const page=rows.filter(r=>r.inbox_seq>after).slice(0,limit);return {inbox:{owner_life_id:lifeId,items:structuredClone(page),hasMore:rows.some(r=>r.inbox_seq>(page.at(-1)?.inbox_seq??after)),nextAfter:page.at(-1)?.inbox_seq??after}};},
    reconcileDelivery:async({inbox_id,evidence})=>{remote++;const r=rows.find(r=>r.inbox_id===inbox_id);r.attempt.state=evidence.state;
      r.attempt.native_evidence=structuredClone(evidence);delete r.attempt.native_evidence.side_effects;r.revision++;return structuredClone(r);},
    selectBatch:async({items})=>{
      const selected=items.map(i=>rows.find(r=>r.inbox_id===i.inbox_id));let attempt=selected[0].attempt;
      if(!attempt){const key=randomUUID(),rpc='TEST-new-'+key;
        const native_message=createUserMessage({content:[{type:'text',text:JSON.stringify({kind:'social-events',items:selected.map(r=>({inbox_id:r.inbox_id,message:r.message}))})}],
          source:{kind:'room-inbox-batch',rpcId:rpc,inboxIds:selected.map(r=>r.inbox_id),receiverLifeId:lifeId}});
        attempt={attempt_id:key,session_id:sessionId,request_id:rpc,state:'prepared',native_message,inbox_ids:selected.map(r=>r.inbox_id),requested_inbox_ids:[]};
        for(const r of selected){r.attempt=structuredClone(attempt);r.revision++;}
      }
      return {attempt:structuredClone(attempt),native_message:structuredClone(attempt.native_message),items:structuredClone(selected)};
    },
    authorizeBatch:async({attempt_id})=>({authorized:true,attempt_id}),
    acknowledgeBatch:async({attempt_id})=>{trace.push('ack');for(const r of rows.filter(r=>r.attempt?.attempt_id===attempt_id)){r.attempt.state='pending';r.revision++;}
      if(loseAck){loseAck=false;throw Object.assign(Error('TEST lost receipt'),{code:'TEST_ACK_LOST'});}return {attempt_id};}
  };
  const t={rows,events,agent,trace,bridge,get executions(){return executions;},get remote(){return remote;},get fullInspect(){return fullInspect;},
    add(){const row=makeRow(rows.length);rows.push(row);return row;},loseAck(){loseAck=true;},
    async mount(){const c=await mountRoomInbox({ctx,bridge,lifeId,authoritySessionId:sessionId,root,intervalMs:60000,initialPolicy:{human_idle:true,peer_idle:true,rest:false}});controllers.push(c);return c;},
    async cleanup(){for(const c of controllers){c.dispose();await c.drain();}rmSync(root,{recursive:true,force:true});}
  };return t;
}

test('180 settled records never cause remote reconciliation; warm polls do not recompute closed turns',async()=>{
  const t=await fixture(180);try{
    const c=await t.mount();assert.equal((await c.tick()).state,'idle');assert.equal(t.remote,0);assert.equal(t.fullInspect,0);
    let p=c.status().performance;assert.equal(p.evidence_computations,180);assert.equal(p.reconcile_skipped,180);assert.equal(p.inspect_calls,2);
    t.add();assert.equal((await c.tick()).state,'admitted');assert.equal(t.executions,1);assert.equal(t.remote,0);
    p=c.status().performance;assert.equal(p.evidence_computations,180);assert.equal(p.evidence_cache_hits,180);
    assert(t.trace.indexOf('flush')<t.trace.indexOf('ack'));assert(t.trace.indexOf('ack')<t.trace.indexOf('send:true'));
    assert.equal((await c.tick()).state,'idle');assert.equal(t.remote,1);assert.equal(t.executions,1);
    const previous=c.status().performance.evidence_computations;await c.tick();assert.equal(t.remote,1);assert.equal(c.status().performance.evidence_computations,previous);
    c.dispose();const cold=await t.mount();await cold.tick();assert.equal(t.remote,1);assert.equal(t.executions,1);assert.equal(cold.status().performance.evidence_computations,181);
  }finally{await t.cleanup();}
});

test('changed or missing central evidence is repaired once; pending ACK loss still resumes exactly one native envelope',async()=>{
  const t=await fixture(12);try{
    delete t.rows[3].attempt.native_evidence;const c=await t.mount();await c.tick();assert.equal(t.remote,1);await c.tick();assert.equal(t.remote,1);
    const input=t.add();t.loseAck();assert.equal((await c.tick()).state,'pending');assert.equal(t.executions,0);assert.equal(t.agent.inbox.nextTurn.length,1);
    const id=input.attempt.attempt_id,rpc=input.attempt.request_id;c.dispose();const cold=await t.mount();assert.equal((await cold.tick()).state,'admitted');
    assert.equal(input.attempt.attempt_id,id);assert.equal(input.attempt.request_id,rpc);assert.equal(t.executions,1);
    await cold.tick();await cold.tick();assert.equal(t.executions,1);
  }finally{await t.cleanup();}
});

test('comparison follows central evidence projection and rejects changed execution claims',()=>{
  const evidence={state:'completed',turn_end_seq:12,side_effects:['TEST']};
  assert(deliveryEvidenceUnchanged({state:'completed',native_evidence:{state:'completed',turn_end_seq:12}},evidence));
  assert(!deliveryEvidenceUnchanged({state:'completed',native_evidence:{state:'completed',turn_end_seq:11}},evidence));
  assert(!deliveryEvidenceUnchanged({state:'pending',native_evidence:{state:'completed',turn_end_seq:12}},evidence));
});

test('authenticated scheduling view isolates Sessions and retains the complete semantic Inbox and retry evidence',async()=>{
  const f=await createFixture(['A','B']);let registry,rooms;
  try{
    registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});for(const m of f.manifests)registry.register(m);
    const contexts=new LifeContexts(registry),tasks=new TaskStore({contexts,root:join(f.root,'TEST-tasks')});
    rooms=new Conversations({contexts,tasks,root:join(f.root,'TEST-rooms')});
    const [A,B]=f.manifests,token='TEST ONLY worker token '+randomUUID();
    const gateway=new WorkerGateway({registry,rooms,tasks,workerBindings:new Map([[A.lifeId,{token,allowedPresetId:A.deployment.presetId}]])});
    const handle=gateway.authenticate({lifeId:A.lifeId,token}),register=(id,role)=>gateway.registerSession(handle,{presetId:A.deployment.presetId,role,
      header:{version:4,id,cwd:A.deployment.workspace,createdAt:Date.now(),agentPreset:A.deployment.presetId}});
    register(A.authoritySessionId,'authority');const activity=randomUUID();register(activity,'activity');
    rooms.registerHuman({sender_id:'human:test',display_name:'TEST ONLY'});
    const main=rooms.defineRoom({participants:['human:test',A.lifeId]}),other=rooms.defineRoom({participants:['human:test',A.lifeId]});
    rooms.bindReceiver({lifeId:A.lifeId,room_id:other.room_id,sessionId:activity});
    rooms.postHuman('human:test',{room_id:main.room_id,body:'TEST settled input'});
    rooms.postHuman('human:test',{room_id:other.room_id,body:'TEST activity input'});
    let row=gateway.inbox(handle).items.find(r=>r.room_id===main.room_id);
    const batch=gateway.selectBatch(handle,{sessionId:A.authoritySessionId,items:[{inbox_id:row.inbox_id,expectedRevision:row.revision}]});
    gateway.reconcileDelivery(handle,{sessionId:A.authoritySessionId,inbox_id:row.inbox_id,attempt_id:batch.attempt.attempt_id,
      evidence:{state:'completed',turn_end_seq:3,turn_start_seq:0,user_message_seq:1,retryable:false}});
    assert.equal(gateway.inbox(handle).items.length,2);assert.equal(gateway.inbox(handle).items.find(r=>r.inbox_id===row.inbox_id).status,'pending');
    assert.equal(gateway.inbox(handle,{sessionId:A.authoritySessionId,executionOnly:true,includeTerminal:true}).items.length,0);
    assert.deepEqual(gateway.inbox(handle,{sessionId:activity,executionOnly:true}).items.map(r=>r.room_id),[other.room_id]);
    assert.throws(()=>gateway.inbox(handle,{sessionId:B.authoritySessionId,executionOnly:true}),/SESSION_OWNER_MISMATCH|UNKNOWN_SESSION/);
    assert.throws(()=>gateway.inbox(handle,{executionOnly:true}),/SCHEDULER_SESSION_REQUIRED/);
    row=gateway.inbox(handle).items.find(r=>r.room_id===main.room_id);
    gateway.decide(handle,{sessionId:A.authoritySessionId,args:{inbox_id:row.inbox_id,action:'process',expectedRevision:row.revision}});
    assert.equal(gateway.inbox(handle,{sessionId:A.authoritySessionId,executionOnly:true}).items.length,1);
    // Metadata admission does not erase semantic history or make an execution
    // successful. A safe retry with closed failed evidence remains schedulable.
    const third=rooms.defineRoom({participants:['human:test',A.lifeId]});rooms.postHuman('human:test',{room_id:third.room_id,body:'TEST retry'});
    row=gateway.inbox(handle).items.find(r=>r.room_id===third.room_id);
    const retry=gateway.selectBatch(handle,{sessionId:A.authoritySessionId,items:[{inbox_id:row.inbox_id,expectedRevision:row.revision}]});
    gateway.reconcileDelivery(handle,{sessionId:A.authoritySessionId,inbox_id:row.inbox_id,attempt_id:retry.attempt.attempt_id,
      evidence:{state:'failed',turn_end_seq:8,no_effect_dispatch_proven:true,assistant_committed:false,retryable:true}});
    assert(gateway.inbox(handle,{sessionId:A.authoritySessionId,executionOnly:true}).items.some(r=>r.inbox_id===row.inbox_id));
    assert.equal(gateway.inbox(handle).items.length,3);
  }finally{rooms?.close();registry?.close();await f.cleanup();}
});
