import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentRouter,selectRoute} from './router.mjs';
const makeParent=life=>{const events=[];return {session:{id:life+'-parent',header:{id:life+'-parent',cwd:tmpdir()},append:(type,data)=>events.push({type,data:structuredClone(data)}),ownEvents:()=>events},followup:()=>{}};};
test('default route, explicit model/provider, unrelated extensible provider',()=>{
 const s={defaultProvider:'codex',defaultModel:'gpt-5.6-luna'};
 assert.deepEqual(selectRoute(s),{provider:'codex',model:'gpt-5.6-luna'});
 assert.deepEqual(selectRoute(s,{provider:'deepseek'}),{provider:'spawn',model:undefined});
 assert.deepEqual(selectRoute(s,{model:'gpt-5.6-sol'}),{provider:'codex',model:'gpt-5.6-sol'});
 assert.deepEqual(selectRoute(s,{provider:'future-provider',model:'future-model'}),{provider:'future-provider',model:'future-model'});
});
test('bounded shared slots, queued background, abort/never-settle release, owner visibility and cold read',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luna-router-'));
 const settings={defaultProvider:'codex',defaultModel:'gpt-5.6-luna',protectedRoot:root,maxConcurrency:2,queueTimeoutMs:3000,runTimeoutMs:120};
 const ctx={get:()=>undefined,sessions:{flush:async()=>{}},agents:{get:()=>undefined}};
 const ownerFor=p=>({lifeId:p.session.id.split('-')[0],sessionId:p.session.id});
 const router=new AgentRouter(ctx,settings,{ownerFor,notify:false});
 let active=0,peak=0,disposed=0;
 router.provider=async()=>({start:async request=>{active++;peak=Math.max(peak,active);return {id:'mock-'+Math.random(),
   result:request.prompt[0].text==='never'?new Promise(()=>{}):delay(35).then(()=>({stopReason:'completed',output:request.prompt})),
   dispose:async()=>{disposed++;active--;}};}});
 const A=makeParent('A'),B=makeParent('B');
 try {
  const receipt=await router.start(A,{prompt:'never'});assert.equal(receipt.status,'queued');
  const rest=await Promise.all(['b','c','d'].map(prompt=>router.start(A,{prompt})));
  await Promise.all([...router.pending]);assert.equal(peak,2);assert.equal(active,0);assert.equal(disposed,4);
  assert.equal((await router.results(A,{child_id:receipt.child_id})).status,'cancelled');
  for(const r of rest)assert.equal((await router.results(A,{child_id:r.child_id})).status,'completed');
  await assert.rejects(router.results(B,{child_id:receipt.child_id}),/NOT_VISIBLE/);
  const cold=new AgentRouter(ctx,settings,{ownerFor});assert.equal((await cold.results(A,{child_id:rest[0].child_id})).status,'completed');
  assert.equal((await router.results(A)).agents.length,4);
  assert.deepEqual(A.session.ownEvents(),[],'router must not append unknown Harness event types');
  await assert.rejects(router.start(A,{prompt:'explicit DS',provider:'deepseek'}),/DEEPSEEK_SUBAGENTS_DISABLED/);
  await assert.rejects(router.start(A,{prompt:'explicit spawn',provider:'spawn'}),/DEEPSEEK_SUBAGENTS_DISABLED/);
  let dsCalls=0;router.deepseekStart=async()=>{dsCalls++;return {provider:'deepseek-official'};};
  router.settings.deepseekEnabled=true;
  assert.equal((await router.start(A,{prompt:'explicit DS',provider:'deepseek'})).provider,'deepseek-official');
  assert.equal(dsCalls,1);
 }finally{await router.dispose();await rm(root,{recursive:true,force:true});}
});
test('legacy foreground request returns before settlement, survives parent abort and notifies its own parent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luna-background-'));
 const parent=makeParent('A'),notices=[];parent.followup=notice=>notices.push(notice);
 const ctx={get:()=>undefined,agents:{get:id=>id===parent.session.id?parent:undefined}};
 const settings={defaultProvider:'codex',defaultModel:'gpt-5.6-luna',protectedRoot:root,maxConcurrency:1,queueTimeoutMs:1000,runTimeoutMs:5000};
 const router=new AgentRouter(ctx,settings,{ownerFor:p=>({lifeId:'A',sessionId:p.session.id})});
 let settle,started;const running=new Promise(resolve=>started=resolve),result=new Promise(resolve=>settle=resolve);
 router.provider=async()=>({start:async request=>{started(request.signal);return {id:'background-child',result,dispose:async()=>{}};}});
 const parentSignal=new AbortController();
 try {
  const receipt=await Promise.race([router.start(parent,{task:'isolated fixture task',run_in_background:false},parentSignal.signal),delay(1000).then(()=>{throw new Error('parent waited for child result');})]);
  assert.equal(receipt.background,true);assert.equal(receipt.wait_requested,true);assert.notEqual(receipt.status,'completed');
  const childSignal=await running;parentSignal.abort();assert.equal(childSignal.aborted,false,'submitted work belongs to explicit task cancellation');
  settle({stopReason:'completed',output:[{type:'text',text:'fixture completed'}]});await Promise.all([...router.pending]);
  const finished=await router.results(parent,{child_id:receipt.child_id});assert.equal(finished.status,'completed');
  assert.equal(notices.length,1);assert.equal(notices[0].source.kind,'subagent-settled');assert.equal(notices[0].source.parentSessionId,parent.session.id);
  assert.equal(notices[0].source.ownerLifeId,'A');assert.equal(notices[0].source.senderSessionId,receipt.child_id);
  const cold=new AgentRouter(ctx,settings,{ownerFor:p=>({lifeId:'A',sessionId:p.session.id})});
  assert.equal((await cold.results(parent,{child_id:receipt.child_id})).status,'completed');
 }finally{settle({stopReason:'completed',output:[]});await router.dispose();await rm(root,{recursive:true,force:true});}
});
