import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {LifeContexts} from '../context.mjs';
import {TaskStore} from './tasks.mjs';

async function setup(labels=['A','B']) {
  const fixture=await createFixture(labels),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),contexts=new LifeContexts(registry),agents=new Map();
  for(const life of fixture.manifests) {
    registry.register(life);
    const header={id:life.authoritySessionId,cwd:life.deployment.workspace,createdAt:1,agentPreset:life.deployment.presetId};
    registry.reserve({lifeId:life.lifeId,sessionId:header.id,role:'authority'});registry.complete(header.id,header);
    const agent={session:{id:header.id,header}};contexts.bind(agent);agents.set(life.lifeId,agent);
  }
  const root=resolve(fixture.root,'TEST-ONLY-task-inboxes');let clock=Date.parse('2026-10-06T17:00:00+08:00');
  const now=()=>clock++,store=new TaskStore({contexts,root,now});
  const context=life=>contexts.execution(agents.get(life.lifeId));
  const ensureRoot=(life,extra={})=>store.ensureSession({lifeId:life.lifeId,sessionId:life.authoritySessionId,role:'authority',...extra});
  function reserve(life,{role='delegate',nativeParent=life.authoritySessionId,ready=true}={}) {
    const sessionId=randomUUID(),header={id:sessionId,cwd:life.deployment.workspace,createdAt:2,agentPreset:life.deployment.presetId,
      ...(role==='delegate'?{parentSession:nativeParent,delegationDepth:1,origin:'subagent'}:{})};
    registry.reserve({lifeId:life.lifeId,sessionId,role,parentSessionId:role==='delegate'?nativeParent:null});
    if(ready)registry.complete(sessionId,header);return {sessionId,header};
  }
  return {fixture,registry,contexts,root,now,store,context,ensureRoot,reserve,async cleanup(){registry.close();await fixture.cleanup();}};
}

test('two owners get stable session tasks and private child results; root Sessions remain active',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.fixture.manifests,ar=s.ensureRoot(A),br=s.ensureRoot(B),ac=s.reserve(A),bc=s.reserve(B);
    const at=s.store.ensureSession({lifeId:A.lifeId,sessionId:ac.sessionId,role:'delegate',parentTaskId:ar.task_id});
    const bt=s.store.ensureSession({lifeId:B.lifeId,sessionId:bc.sessionId,role:'delegate',parentTaskId:br.task_id});
    assert.equal(at.root_task_id,ar.task_id);assert.equal(at.result_scope,'owner');assert.equal(at.shared,false);
    assert.equal(s.store.complete({taskId:at.task_id,result:'TEST ONLY A PRIVATE TASK CANARY',nativeEvidence:{sessionId:ac.sessionId,seq:30,type:'turn/end'}}).duplicate,false);
    s.store.complete({taskId:bt.task_id,result:'TEST ONLY B PRIVATE TASK CANARY',nativeEvidence:{session_id:bc.sessionId,seq:30,type:'turn/end'}});
    const a=s.store.readResults(s.context(A)),b=s.store.readResults(s.context(B));
    assert.equal(a.results.length,1);assert.equal(b.results.length,1);assert.ok(JSON.stringify(a).includes('TEST ONLY A PRIVATE TASK CANARY'));assert.ok(!JSON.stringify(a).includes('TEST ONLY B PRIVATE TASK CANARY'));
    assert.equal(a.results[0].seq,1);assert.equal(b.results[0].seq,1);
    assert.equal(s.store.get(s.context(A),{taskId:ar.task_id}).status,'active');
    assert.equal(s.store.list(s.context(A)).length,2);assert.ok(s.store.list(s.context(A)).every(row=>row.owner_life_id===A.lifeId));
    assert.throws(()=>s.store.get(s.context(B),{taskId:at.task_id}),/TASK_NOT_VISIBLE/);
    assert.throws(()=>s.store.acknowledgeResult(s.context(B),{taskId:at.task_id}),/TASK_NOT_VISIBLE/);
    assert.throws(()=>s.store.list({...s.context(A)}),/TRUSTED_EXECUTION_CONTEXT_REQUIRED/);
    assert.equal(s.store.forSession(ac.sessionId).task_id,at.task_id);assert.equal(s.store.forSession('TEST unknown'),null);
  }finally{await s.cleanup();}
});

test('delegate parents are real same-owner tasks; recursive root is independent from native parent Session',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.fixture.manifests,ar=s.ensureRoot(A),br=s.ensureRoot(B),child=s.reserve(A);
    assert.throws(()=>s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate'}),/DELEGATE_PARENT_TASK_REQUIRED/);
    assert.throws(()=>s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:'TEST not registered'}),/TASK_NOT_VISIBLE/);
    assert.throws(()=>s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:br.task_id}),/TASK_PARENT_OWNER_MISMATCH/);
    assert.throws(()=>s.store.ensureSession({lifeId:B.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:br.task_id}),/SESSION_OWNER_MISMATCH/);
    assert.throws(()=>s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'activity',parentTaskId:ar.task_id}),/TASK_ROLE_OWNER_MISMATCH/);
    const ct=s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:ar.task_id});
    const grandchild=s.reserve(A,{nativeParent:A.authoritySessionId});
    const gt=s.store.ensureSession({lifeId:A.lifeId,sessionId:grandchild.sessionId,role:'delegate',parentTaskId:ct.task_id});
    assert.equal(gt.parent_task_id,ct.task_id);assert.equal(gt.root_task_id,ar.task_id);assert.equal(gt.native_parent_session_id,A.authoritySessionId);
    assert.notEqual(gt.native_parent_session_id,ct.execution_session_id);
  }finally{await s.cleanup();}
});

test('room origin and shared intent are explicit immutable lineage; room results still enter owner inbox only',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.fixture.manifests,ar=s.ensureRoot(A,{originRoomId:'TEST-shared-room',shared:true}),br=s.ensureRoot(B),child=s.reserve(A);
    assert.equal(ar.result_scope,'room');assert.equal(ar.shared,true);
    assert.throws(()=>s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:ar.task_id}),/TASK_ORIGIN_LINEAGE_MISMATCH/);
    const ct=s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:ar.task_id,originRoomId:'TEST-shared-room',shared:true});
    assert.equal(ct.result_scope,'room');assert.equal(ct.root_task_id,ar.task_id);
    assert.deepEqual(s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate'}),ct,'omitted lineage returns the immutable existing task');
    assert.throws(()=>s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',originRoomId:null}),/TASK_BINDING_IMMUTABLE/);
    assert.throws(()=>s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:null}),/TASK_BINDING_IMMUTABLE/);
    assert.throws(()=>s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',shared:false}),/TASK_BINDING_IMMUTABLE/);
    const bchild=s.reserve(B);
    assert.throws(()=>s.store.ensureSession({lifeId:B.lifeId,sessionId:bchild.sessionId,role:'delegate',parentTaskId:br.task_id,shared:true}),/INVALID_TASK_ORIGIN/);
    s.store.complete({taskId:ct.task_id,result:'TEST ONLY ROOM INTENT, OWNER INBOX ONLY',nativeEvidence:{seq:50,sessionId:child.sessionId}});
    assert.equal(s.store.readResults(s.context(A)).results.length,1);assert.equal(s.store.readResults(s.context(B)).results.length,0);
  }finally{await s.cleanup();}
});

test('completion and acknowledgement deduplicate, contradictory result/evidence conflict, paging preserves history',async()=>{
  const s=await setup(['A']);
  try {
    const A=s.fixture.manifests[0],root=s.ensureRoot(A);let first;
    for(let i=0;i<3;i++) {
      const child=s.reserve(A),task=s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:root.task_id});
      const args={taskId:task.task_id,result:{text:'TEST result '+i,details:{count:i}},nativeEvidence:{seq:100+i,sessionId:child.sessionId}};
      const complete=s.store.complete(args);assert.equal(complete.result.seq,i+1);assert.equal(s.store.complete(args).duplicate,true);
      assert.equal(s.store.complete({...args,result:{details:{count:i},text:'TEST result '+i}}).duplicate,true,'JSON member order does not fabricate a second result');
      assert.throws(()=>s.store.complete({...args,result:'TEST contradictory result'}),/TASK_COMPLETION_CONFLICT/);
      assert.throws(()=>s.store.complete({...args,nativeEvidence:{...args.nativeEvidence,seq:999}}),/TASK_COMPLETION_CONFLICT/);
      if(i===0)first=task;
    }
    const c=s.context(A),page=s.store.readResults(c,{after:0,limit:2});assert.equal(page.results.length,2);assert.equal(page.nextAfter,2);assert.equal(page.hasMore,true);
    assert.equal(s.store.readResults(c,{after:page.nextAfter,limit:2}).results[0].seq,3);
    const ack=s.store.acknowledgeResult(c,{taskId:first.task_id});assert.equal(ack.duplicate,false);assert.equal(s.store.acknowledgeResult(c,{taskId:first.task_id}).duplicate,true);
    assert.equal(s.store.readResults(c).results.length,3);assert.equal(s.store.readResults(c).results[0].acknowledged_at,ack.acknowledged_at);
    assert.throws(()=>s.store.readResults(c,{limit:0}),/EXPLICIT_TASK_RESULT_PAGE_REQUIRED/);
  }finally{await s.cleanup();}
});

test('cold reopen validates task owner, lineage and result hashes, while stale writers cannot overwrite later commits',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.fixture.manifests,root=s.ensureRoot(A),stale=new TaskStore({contexts:s.contexts,root:s.root,now:s.now});
    const child=s.reserve(A),task=s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:root.task_id});
    assert.throws(()=>stale.ensureSession({lifeId:B.lifeId,sessionId:B.authoritySessionId,role:'authority'}),/TASK_STORE_STALE_WRITE/);
    s.store.complete({taskId:task.task_id,result:'TEST durable result',nativeEvidence:{seq:80,sessionId:child.sessionId}});
    const reopened=new TaskStore({contexts:s.contexts,root:s.root,now:s.now});assert.equal(reopened.forSession(child.sessionId).status,'completed');assert.equal(reopened.readResults(s.context(A)).results[0].result,'TEST durable result');
    const path=resolve(s.root,'tasks.json'),original=await readFile(path,'utf8'),data=JSON.parse(original);
    data.tasks[task.task_id].owner_life_id=B.lifeId;await writeFile(path,JSON.stringify(data));
    assert.throws(()=>new TaskStore({contexts:s.contexts,root:s.root}),/SESSION_OWNER_MISMATCH/);
    const lineage=JSON.parse(original);lineage.tasks[task.task_id].root_task_id=task.task_id;await writeFile(path,JSON.stringify(lineage));
    assert.throws(()=>new TaskStore({contexts:s.contexts,root:s.root}),/TASK_ROOT_LINEAGE_CHANGED/);
    const changed=JSON.parse(original);changed.inboxes[A.lifeId][0].result='TEST tampered';await writeFile(path,JSON.stringify(changed));
    assert.throws(()=>new TaskStore({contexts:s.contexts,root:s.root}),/TASK_RESULT_EVIDENCE_CHANGED/);
  }finally{await s.cleanup();}
});

test('task reservation precedes native creation but completion requires a ready native owner and matching Session evidence',async()=>{
  const s=await setup(['A']);
  try {
    const A=s.fixture.manifests[0],root=s.ensureRoot(A),child=s.reserve(A,{ready:false});
    const task=s.store.ensureSession({lifeId:A.lifeId,sessionId:child.sessionId,role:'delegate',parentTaskId:root.task_id});
    assert.throws(()=>s.store.complete({taskId:task.task_id,result:'TEST too early',nativeEvidence:{seq:1}}),/TASK_NATIVE_SESSION_NOT_READY/);
    s.registry.complete(child.sessionId,child.header);
    assert.throws(()=>s.store.complete({taskId:task.task_id,result:'TEST wrong evidence',nativeEvidence:{seq:1,sessionId:A.authoritySessionId}}),/TASK_COMPLETION_SESSION_MISMATCH/);
    assert.throws(()=>s.store.complete({taskId:task.task_id,result:'TEST missing sequence',nativeEvidence:{}}),/TASK_NATIVE_COMPLETION_EVIDENCE_REQUIRED/);
    assert.equal(s.store.complete({taskId:task.task_id,result:'TEST native ended',nativeEvidence:{seq:2,sessionId:child.sessionId}}).task.status,'completed');
  }finally{await s.cleanup();}
});
