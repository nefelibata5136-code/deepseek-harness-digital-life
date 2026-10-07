import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {LifeContexts} from '../context.mjs';
import {PublicActivityStore} from './public-activity.mjs';
import {WorkerGateway} from './worker-gateway.mjs';
import {TaskStore} from './tasks.mjs';
import {Conversations} from './conversations.mjs';

async function setup(labels=['A','B']) {
  const fixture=await createFixture(labels),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),contexts=new LifeContexts(registry),agents=new Map();
  for(const life of fixture.manifests) {
    registry.register(life);
    const header={id:life.authoritySessionId,cwd:life.deployment.workspace,createdAt:1,agentPreset:life.deployment.presetId};
    registry.reserve({lifeId:life.lifeId,sessionId:header.id,role:'authority'});registry.complete(header.id,header);
    const agent={session:{id:header.id,header}};contexts.bind(agent);agents.set(life.lifeId,agent);
  }
  const root=resolve(fixture.root,'TEST-ONLY-public-activity');let clock=Date.parse('2026-10-06T17:00:00+08:00');
  const now=()=>clock++,store=new PublicActivityStore({contexts,root,now});
  function session(life,role='activity') {
    const id=randomUUID(),header={id,cwd:life.deployment.workspace,createdAt:2,agentPreset:life.deployment.presetId,
      ...(role==='delegate'?{parentSession:life.authoritySessionId,delegationDepth:1,origin:'subagent'}:{})};
    registry.reserve({lifeId:life.lifeId,sessionId:id,role,parentSessionId:role==='delegate'?life.authoritySessionId:null});registry.complete(id,header);
    const agent={session:{id,header}};contexts.bind(agent);return {id,context:contexts.execution(agent)};
  }
  return {fixture,registry,contexts,root,now,store,session,context:life=>contexts.execution(agents.get(life.lifeId)),advance:ms=>{clock+=ms;},
    async cleanup(){registry.close();await fixture.cleanup();}};
}

test('public activity is the owner’s voluntary short statement; contexts cannot impersonate another owner',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.fixture.manifests;
    assert.equal(s.store.read(A.lifeId).phase,'idle');assert.equal(s.store.read(A.lifeId).updated_at,null);
    const publicView=s.store.publish(s.context(B),{text:'TEST ONLY B is reading shared documentation'});
    assert.equal(publicView.activity_text,'TEST ONLY B is reading shared documentation');assert.equal(publicView.summary_source,'self');
    assert.equal(s.store.read(A.lifeId).activity_text,null);
    assert.throws(()=>s.store.publish({...s.context(A)},{text:'TEST ONLY forged'}),/TRUSTED_EXECUTION_CONTEXT_REQUIRED/);
    assert.throws(()=>s.store.publish(s.context(A),{text:'TEST ONLY forged B',lifeId:B.lifeId}),/PUBLIC_ACTIVITY_ARGUMENTS_INVALID/);
    assert.throws(()=>s.store.publish(s.context(A),{text:'TEST ONLY forged B',owner_life_id:B.lifeId}),/PUBLIC_ACTIVITY_ARGUMENTS_INVALID/);
    assert.throws(()=>s.store.publish(s.session(A,'delegate').context,{text:'TEST ONLY engineering child claims parent'}),/PUBLIC_ACTIVITY_DELEGATE_PUBLICATION_DENIED/);
    assert.throws(()=>s.store.publish(s.context(A),{text:'界'.repeat(2001)}),/PUBLIC_ACTIVITY_ARGUMENTS_INVALID/);
    assert.throws(()=>s.store.publish(s.context(A),{text:'TEST ONLY bad expiry',expiresAt:'not-a-date'}),/PUBLIC_ACTIVITY_ARGUMENTS_INVALID/);
    const activity=s.session(A);s.store.publish(activity.context,{text:'TEST ONLY A’s own activity'});
    assert.equal(s.store.read(A.lifeId).activity_text,'TEST ONLY A’s own activity');
    // Everyone receives exactly the same public view; there is no privileged
    // cross-owner Memory/Vault/profile read behind this interface.
    assert.deepEqual(Object.keys(publicView).sort(),['life_id','phase','busy','updated_at','last_public_tool','activity_text','summary_source','visibility'].sort());
    assert(Object.isFrozen(publicView));
  }finally{await s.cleanup();}
});

test('four owners run independently; one owner’s turn-end cannot clear another’s private activity',async()=>{
  const s=await setup(['A','B','C','D']);
  try {
    const [A,B,C,D]=s.fixture.manifests;
    for(const life of [A,B,C,D])s.store.recordHost({lifeId:life.lifeId,sessionId:life.authoritySessionId,phase:'thinking'});
    s.store.recordHost({lifeId:B.lifeId,sessionId:B.authoritySessionId,phase:'tool',toolName:'private_read'});
    s.store.recordHost({lifeId:C.lifeId,sessionId:C.authoritySessionId,phase:'tool',toolName:'memory_search'});
    s.store.recordHost({lifeId:A.lifeId,sessionId:A.authoritySessionId,phase:'idle'});
    assert.equal(s.store.read(A.lifeId).busy,false);assert.equal(s.store.read(B.lifeId).phase,'private');assert.equal(s.store.read(B.lifeId).busy,true);
    assert.equal(s.store.read(B.lifeId).last_public_tool,null);assert.equal(s.store.read(C.lifeId).last_public_tool,'memory_search');assert.equal(s.store.read(D.lifeId).phase,'thinking');
    assert.throws(()=>s.store.recordHost({lifeId:A.lifeId,sessionId:B.authoritySessionId,phase:'idle'}),/SESSION_OWNER_MISMATCH/);
    assert.equal(s.store.read(B.lifeId).phase,'private');
    for(const key of ['args','body','filename','thought','path'])assert.throws(()=>s.store.recordHost({lifeId:B.lifeId,sessionId:B.authoritySessionId,phase:'tool',toolName:'read',[key]:'TEST ONLY PRIVATE CANARY'}),/PUBLIC_ACTIVITY_HOST_METADATA_INVALID/);
    assert.throws(()=>s.store.recordHost({lifeId:B.lifeId,sessionId:B.authoritySessionId,phase:'tool',toolName:'C:/TEST-private-file.txt'}),/PUBLIC_ACTIVITY_HOST_METADATA_INVALID/);
    const persisted=await readFile(resolve(s.root,'public-activity.json'),'utf8');assert(!persisted.includes('private_read'));assert(!persisted.includes('PRIVATE CANARY'));
  }finally{await s.cleanup();}
});

test('three sessions aggregate private busy and keep it until their own private turn ends',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.fixture.manifests,second=s.session(B),third=s.session(B);
    s.store.publish(s.context(B),{text:'TEST ONLY deliberately public summary'});
    s.store.recordHost({lifeId:B.lifeId,sessionId:B.authoritySessionId,phase:'thinking'});
    s.store.recordHost({lifeId:B.lifeId,sessionId:second.id,phase:'tool',toolName:'private_write'});
    s.store.recordHost({lifeId:B.lifeId,sessionId:third.id,phase:'tool',toolName:'read'});
    assert.equal(s.store.read(B.lifeId).phase,'private');assert.equal(s.store.read(B.lifeId).activity_text,null);
    s.store.recordHost({lifeId:B.lifeId,sessionId:second.id,phase:'tool',toolName:'edit'});
    s.store.recordHost({lifeId:B.lifeId,sessionId:B.authoritySessionId,phase:'idle'});
    s.store.recordHost({lifeId:A.lifeId,sessionId:A.authoritySessionId,phase:'idle'});
    assert.equal(s.store.read(B.lifeId).phase,'private');assert.equal(s.store.read(B.lifeId).last_public_tool,null);assert.equal(s.store.read(B.lifeId).busy,true);
    s.store.recordHost({lifeId:B.lifeId,sessionId:second.id,phase:'idle'});
    assert.equal(s.store.read(B.lifeId).phase,'tool');assert.equal(s.store.read(B.lifeId).last_public_tool,'read');assert.equal(s.store.read(B.lifeId).activity_text,'TEST ONLY deliberately public summary');
    s.store.recordHost({lifeId:B.lifeId,sessionId:third.id,phase:'idle'});assert.equal(s.store.read(B.lifeId).busy,false);
    assert.equal(s.store.read(B.lifeId).phase,'idle');
  }finally{await s.cleanup();}
});

test('private publication clears persistent text, public expiry hides text, cold reopening retains safe metadata',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.fixture.manifests;
    s.store.publish(s.context(A),{text:'TEST ONLY A PUBLIC TEXT'});
    s.store.publish(s.context(A),{text:'TEST ONLY A PRIVATE PUBLICATION CANARY',visibility:'private'});
    assert.equal(s.store.read(A.lifeId).activity_text,null);assert.equal(s.store.read(A.lifeId).visibility,'private');assert.equal(s.store.read(A.lifeId).summary_source,'host');
    s.store.publish(s.context(B),{text:'TEST ONLY B EXPIRING PUBLIC TEXT',expiresAt:new Date(s.now()+1000).toISOString()});
    assert.equal(s.store.read(B.lifeId).summary_source,'self');s.advance(2000);assert.equal(s.store.read(B.lifeId).activity_text,null);
    s.store.recordHost({lifeId:B.lifeId,sessionId:B.authoritySessionId,phase:'private',toolName:'private_search'});
    let bytes=await readFile(resolve(s.root,'public-activity.json'),'utf8');
    assert(!bytes.includes('A PUBLIC TEXT'));assert(!bytes.includes('PRIVATE PUBLICATION CANARY'));assert(!bytes.includes('private_search'));
    const cold=new PublicActivityStore({contexts:s.contexts,root:s.root,now:s.now});
    assert.deepEqual(cold.read(A.lifeId),s.store.read(A.lifeId));assert.deepEqual(cold.read(B.lifeId),s.store.read(B.lifeId));
    cold.recordHost({lifeId:B.lifeId,sessionId:B.authoritySessionId,phase:'idle'});assert.equal(cold.read(B.lifeId).busy,false);
    assert.throws(()=>s.store.publish(s.context(A),{text:'TEST ONLY stale writer'}),/PUBLIC_ACTIVITY_STORE_STALE_WRITE/);
    const tampered=JSON.parse(await readFile(resolve(s.root,'public-activity.json'),'utf8'));
    tampered.lives[B.lifeId].sessions[B.authoritySessionId].last_public_tool='private_write';
    await writeFile(resolve(s.root,'public-activity.json'),JSON.stringify(tampered));
    assert.throws(()=>new PublicActivityStore({contexts:s.contexts,root:s.root}),/INVALID_PUBLIC_ACTIVITY_SESSION/);
  }finally{await s.cleanup();}
});

test('ending an older public session preserves the latest actual public tool from another session',async()=>{
  const s=await setup(['A']);
  try {
    const [A]=s.fixture.manifests,second=s.session(A);
    s.store.recordHost({lifeId:A.lifeId,sessionId:A.authoritySessionId,phase:'tool',toolName:'read'});
    s.store.recordHost({lifeId:A.lifeId,sessionId:second.id,phase:'tool',toolName:'life_core_read'});
    s.store.recordHost({lifeId:A.lifeId,sessionId:A.authoritySessionId,phase:'idle'});
    assert.equal(s.store.read(A.lifeId).last_public_tool,'life_core_read');assert.equal(s.store.read(A.lifeId).busy,true);
    s.store.recordHost({lifeId:A.lifeId,sessionId:second.id,phase:'idle'});
    assert.equal(s.store.read(A.lifeId).last_public_tool,'life_core_read');assert.equal(s.store.read(A.lifeId).busy,false);
    const reopened=new PublicActivityStore({contexts:s.contexts,root:s.root,now:s.now});assert.equal(reopened.read(A.lifeId).last_public_tool,'life_core_read');
  }finally{await s.cleanup();}
});

test('authenticated WorkerGateway registrations can publish Host self-reports without fabricated execution contexts',async()=>{
  const fixture=await createFixture(['A','B']);let registry;
  try {
    registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});for(const life of fixture.manifests)registry.register(life);
    const contexts=new LifeContexts(registry),tasks=new TaskStore({contexts,root:resolve(fixture.root,'TEST-ONLY-report-tasks')}),
      rooms=new Conversations({contexts,tasks,root:resolve(fixture.root,'TEST-ONLY-report-rooms')});
    const tokens=fixture.manifests.map(()=> 'TEST ONLY AUTHENTICATED WORKER '+randomUUID()),workerBindings=new Map(fixture.manifests.map((life,index)=>
      [life.lifeId,{token:tokens[index],allowedPresetId:life.deployment.presetId}]));
    const gateway=new WorkerGateway({registry,rooms,tasks,workerBindings}),store=new PublicActivityStore({contexts,root:resolve(fixture.root,'TEST-ONLY-worker-public-reports')});
    const [A,B]=fixture.manifests,handles=fixture.manifests.map((life,index)=>gateway.authenticate({lifeId:life.lifeId,token:tokens[index]}));
    assert.throws(()=>gateway.authenticate({lifeId:A.lifeId,token:tokens[1]}),/WORKER_AUTHENTICATION_FAILED/);
    const register=(life,handle,sessionId,role='authority')=>gateway.registerSession(handle,{header:{version:4,id:sessionId,cwd:life.deployment.workspace,
      createdAt:1,agentPreset:life.deployment.presetId,...role==='delegate'?{parentSession:life.authoritySessionId,delegationDepth:1,origin:'subagent'}:{}},
      presetId:life.deployment.presetId,role,...role==='delegate'?{parentSessionId:life.authoritySessionId}:{}});
    const ar=register(A,handles[0],A.authoritySessionId),br=register(B,handles[1],B.authoritySessionId);
    // No agents were created or bound in this fixture. The reference is a real
    // gateway-authenticated, registry-ready native Header registration result.
    const report=store.publishForLife({lifeId:br.life_id,sessionId:br.session_id,args:{text:'TEST ONLY B’S OWN WORKER REPORT'}});
    assert.equal(report.life_id,B.lifeId);assert.equal(report.summary_source,'self');assert.equal(store.read(A.lifeId).activity_text,null);
    assert.throws(()=>store.publishForLife({lifeId:ar.life_id,sessionId:br.session_id,args:{text:'TEST ONLY A CLAIMS B'}}),/SESSION_OWNER_MISMATCH/);
    assert.throws(()=>store.publishForLife({lifeId:br.life_id,sessionId:ar.session_id,args:{text:'TEST ONLY B CLAIMS A'}}),/SESSION_OWNER_MISMATCH/);
    const child=register(B,handles[1],randomUUID(),'delegate');
    assert.throws(()=>store.publishForLife({lifeId:child.life_id,sessionId:child.session_id,args:{text:'TEST ONLY CHILD CLAIMS B'}}),/PUBLIC_ACTIVITY_DELEGATE_PUBLICATION_DENIED/);
    for(const key of ['sender','sender_id','senderPrincipalId','owner_life_id','lifeId'])assert.throws(()=>
      store.publishForLife({lifeId:br.life_id,sessionId:br.session_id,args:{text:'TEST ONLY SPOOF',[key]:A.lifeId}}),/PUBLIC_ACTIVITY_ARGUMENTS_INVALID/);
    assert.throws(()=>store.publishForLife({lifeId:br.life_id,sessionId:br.session_id,args:{text:'TEST ONLY SPOOF'},sender_id:A.lifeId}),/PUBLIC_ACTIVITY_HOST_METADATA_INVALID/);
    const reserved=randomUUID();registry.reserve({lifeId:B.lifeId,sessionId:reserved,role:'activity'});
    assert.throws(()=>store.publishForLife({lifeId:B.lifeId,sessionId:reserved,args:{text:'TEST ONLY UNVERIFIED NATIVE SESSION'}}),/PUBLIC_ACTIVITY_NATIVE_SESSION_REQUIRED/);
    const activity=register(B,handles[1],randomUUID(),'activity');store.publishForLife({lifeId:activity.life_id,sessionId:activity.session_id,args:{text:'TEST ONLY B’S OWN ACTIVITY',visibility:'public'}});
    assert.equal(store.read(B.lifeId).activity_text,'TEST ONLY B’S OWN ACTIVITY');
    store.publishForLife({lifeId:br.life_id,sessionId:br.session_id,args:{text:'TEST ONLY PRIVATE WORKER CANARY',visibility:'private'}});
    assert.equal(store.read(B.lifeId).activity_text,null);assert(!(await readFile(resolve(fixture.root,'TEST-ONLY-worker-public-reports','public-activity.json'),'utf8')).includes('PRIVATE WORKER CANARY'));
  }finally{registry?.close();await fixture.cleanup();}
});
