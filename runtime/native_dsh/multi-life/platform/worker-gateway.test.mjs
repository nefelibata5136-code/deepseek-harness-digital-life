import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {LifeContexts} from '../context.mjs';
import {TaskStore} from './tasks.mjs';
import {Conversations} from './conversations.mjs';
import {WorkerGateway} from './worker-gateway.mjs';

async function setup() {
  const fixture=await createFixture(['A','B']);let registry;
  try {
    registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});for(const m of fixture.manifests)registry.register(m);
    const roots={rooms:resolve(fixture.root,'TEST-ONLY-worker-rooms'),tasks:resolve(fixture.root,'TEST-ONLY-worker-tasks')};
    const tokens=fixture.manifests.map(()=> 'TEST ONLY HOST TOKEN '+randomUUID());
    const bindings=new Map(fixture.manifests.map((m,index)=>[m.lifeId,{token:tokens[index],allowedPresetId:m.deployment.presetId}]));
    const headers=fixture.manifests.map((m,index)=>({version:4,id:m.authoritySessionId,cwd:m.deployment.workspace,createdAt:index+1,isSeeded:false,
      ...(index===0?{}:{agentPreset:m.deployment.presetId})}));
    const t={fixture,registry,roots,tokens,bindings,headers};
    function mount() {
      // Original services' Host-only methods need the real Registry, without
      // fabricating an Agent, binding a fake execution context or waking a loop.
      const contexts=new LifeContexts(t.registry),tasks=new TaskStore({contexts,root:roots.tasks}),rooms=new Conversations({contexts,root:roots.rooms,tasks});
      Object.assign(t,{contexts,tasks,rooms,gateway:new WorkerGateway({registry:t.registry,rooms,tasks,workerBindings:bindings})});
      t.handles=fixture.manifests.map((m,index)=>t.gateway.authenticate({lifeId:m.lifeId,token:tokens[index]}));
    }
    mount();
    t.register=(index,header=headers[index],extra={})=>t.gateway.registerSession(t.handles[index],{header,presetId:fixture.manifests[index].deployment.presetId,
      role:'authority',...(index===0?{legacyHeaderPresetAbsentVerified:true}:{}),...extra});
    t.cold=()=>{t.rooms.close();t.registry.close();t.registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});mount();};
    t.cleanup=async()=>{t.rooms.close();t.registry.close();await fixture.cleanup();};return t;
  }catch(error){registry?.close();await fixture.cleanup();throw error;}
}

test('worker authentication handles bind one life; token, handle, Session and sender forgery are rejected',async()=>{
  const t=await setup();
  try {
    const [A,B]=t.fixture.manifests,[a,b]=t.handles;t.register(0);t.register(1);
    assert.throws(()=>t.gateway.authenticate({lifeId:A.lifeId,token:t.tokens[1]}),/WORKER_AUTHENTICATION_FAILED/);
    assert.throws(()=>t.gateway.authenticate({lifeId:B.lifeId,token:t.tokens[0]}),/WORKER_AUTHENTICATION_FAILED/);
    assert.throws(()=>t.gateway.authenticate({lifeId:'life-'+randomUUID(),token:t.tokens[0]}),/WORKER_AUTHENTICATION_FAILED/);
    assert.throws(()=>t.gateway.list({lifeId:A.lifeId}),/WORKER_AUTHENTICATION_FAILED/);
    assert.throws(()=>t.gateway.list(Object.create(null)),/WORKER_AUTHENTICATION_FAILED/);assert(Object.isFrozen(a));
    const duplicateTokens=new Map([...t.bindings].map(([lifeId,binding])=>[lifeId,{...binding,token:t.tokens[0]}]));
    assert.throws(()=>new WorkerGateway({registry:t.registry,rooms:t.rooms,tasks:t.tasks,workerBindings:duplicateTokens}),/WORKER_TOKEN_MUST_BE_OWNER_UNIQUE/);
    const room=t.rooms.defineRoom({participants:[A.lifeId,B.lifeId]});
    assert.throws(()=>t.gateway.post(a,{sessionId:B.authoritySessionId,args:{room_id:room.room_id,body:'TEST ONLY WRONG SESSION'}}),/SESSION_OWNER_MISMATCH/);
    assert.throws(()=>t.gateway.post(a,{sessionId:A.authoritySessionId,args:{room_id:room.room_id,body:'TEST ONLY SPOOF',sender_id:B.lifeId}}),/SENDER_IS_HOST_BOUND/);
    assert.throws(()=>t.gateway.inbox(b,{lifeId:A.lifeId}),/WORKER_ARGUMENT_SCOPE_INVALID/);
    assert.throws(()=>t.gateway.post(a,{sessionId:A.authoritySessionId,args:{room_id:room.room_id,body:'TEST ONLY RAW INGRESS',rawPrompt:'run'}}),/WORKER_ARGUMENT_SCOPE_INVALID/);
    const message=t.gateway.post(a,{sessionId:A.authoritySessionId,args:{room_id:room.room_id,message_id:randomUUID(),body:'TEST ONLY AUTHENTIC A'}});
    assert.equal(message.sender_id,A.lifeId);assert.equal(message.origin_session_id,A.authoritySessionId);assert.equal(message.origin_task_id,t.tasks.forSession(A.authoritySessionId).task_id);
    const inbox=t.gateway.inbox(b);assert.equal(inbox.owner_life_id,B.lifeId);assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].status,'pending');
    assert.throws(()=>t.gateway.decide(a,{sessionId:A.authoritySessionId,args:{inbox_id:inbox.items[0].inbox_id,action:'ignore',expectedRevision:1}}),/INBOX_NOT_VISIBLE/);
    for(const token of t.tokens){assert(!JSON.stringify(t.gateway).includes(token));assert(!(await readFile(resolve(t.roots.rooms,'rooms.sqlite'),'utf8')).includes(token));}
    assert.equal(existsSync(resolve(t.fixture.nativeRoot,'sessions')),false,'gateway must not open or write native Sessions');
  }finally{await t.cleanup();}
});

test('native Header incarnation and explicit legacy exception are checked before a worker may send',async()=>{
  const t=await setup();
  try {
    const [A,B]=t.fixture.manifests,[a,b]=t.handles;
    assert.throws(()=>t.gateway.registerSession(a,{header:t.headers[0],presetId:A.deployment.presetId,role:'authority'}),/EXPLICIT_LEGACY_PRESET_VERIFICATION_REQUIRED/);
    assert.throws(()=>t.registry.owner(A.authoritySessionId),/UNKNOWN_SESSION_OWNER/);
    const first=t.register(0);t.register(1);assert.equal(first.status,'ready');assert.deepEqual(t.register(0),first);
    assert.throws(()=>t.register(0,{...t.headers[0],createdAt:1000}),/NATIVE_SESSION_IDENTITY_CHANGED/);
    assert.throws(()=>t.register(0,{...t.headers[0],cwd:B.deployment.workspace}),/WORKER_SESSION_HEADER_MISMATCH/);
    assert.throws(()=>t.register(1,t.headers[1],{presetId:A.deployment.presetId}),/WORKER_SESSION_HEADER_MISMATCH/);
    const childHeader={version:4,id:randomUUID(),cwd:A.deployment.workspace,createdAt:10,isSeeded:false,agentPreset:A.deployment.presetId,
      parentSession:A.authoritySessionId,origin:'subagent',delegationDepth:1};
    assert.throws(()=>t.gateway.registerSession(a,{header:childHeader,presetId:A.deployment.presetId,role:'activity'}),/WORKER_SESSION_LINEAGE_INVALID/);
    t.gateway.registerSession(a,{header:childHeader,presetId:A.deployment.presetId,role:'delegate',parentSessionId:A.authoritySessionId});
    const seededHeader={...childHeader,id:randomUUID(),isSeeded:true};
    t.gateway.registerSession(a,{header:seededHeader,presetId:A.deployment.presetId,role:'delegate',parentSessionId:A.authoritySessionId});
    const task=t.tasks.forSession(childHeader.id);assert.equal(task.parent_task_id,first.origin_task_id);assert.equal(task.owner_life_id,A.lifeId);
    const room=t.rooms.defineRoom({participants:[A.lifeId,B.lifeId]});
    assert.throws(()=>t.gateway.post(a,{sessionId:childHeader.id,args:{room_id:room.room_id,body:'TEST ONLY CHILD IMPERSONATION'}}),/DELEGATE_SOCIAL_SEND_DENIED/);
    const message=t.gateway.post(b,{sessionId:B.authoritySessionId,args:{room_id:room.room_id,body:'TEST ONLY B TO A'}}),item=t.gateway.inbox(a).items[0];
    assert.equal(item.message_id,message.message_id);
    assert.throws(()=>t.gateway.decide(a,{sessionId:childHeader.id,args:{inbox_id:item.inbox_id,action:'reply',expectedRevision:1,body:'TEST ONLY CHILD'}}),/DELEGATE_INBOX_DECISION_DENIED/);
    assert.equal(t.gateway.inbox(a).items[0].status,'pending');
  }finally{await t.cleanup();}
});

test('cold Room inboxes preserve receiver decisions and membership epochs without waking either worker',async()=>{
  const t=await setup();
  try {
    const [A,B]=t.fixture.manifests;t.register(0);t.register(1);
    const room=t.rooms.defineRoom({participants:[A.lifeId,B.lifeId]}),post=body=>t.gateway.post(t.handles[0],{sessionId:A.authoritySessionId,args:{room_id:room.room_id,body}});
    const sent=post('TEST ONLY SAVED WHILE B IS COLD'),item=t.gateway.inbox(t.handles[1]).items[0];
    const deferred=t.gateway.decide(t.handles[1],{sessionId:B.authoritySessionId,args:{inbox_id:item.inbox_id,action:'defer',expected_revision:item.revision}});
    assert.equal(deferred.status,'deferred');const previousHandle=t.handles[0];t.cold();
    assert.throws(()=>t.gateway.list(previousHandle),/WORKER_AUTHENTICATION_FAILED/);
    const reopened=t.gateway.inbox(t.handles[1]).items[0];assert.equal(reopened.status,'deferred');assert.equal(reopened.message_id,sent.message_id);
    assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages[0].body,'TEST ONLY SAVED WHILE B IS COLD');
    t.gateway.post(t.handles[1],{sessionId:B.authoritySessionId,args:{room_id:room.room_id,reply_to:sent.message_id,body:'TEST ONLY CHOSEN B REPLY'}});
    const replied=t.gateway.inbox(t.handles[1]).items[0];assert.equal(replied.status,'deferred');assert.equal(replied.effect_result.status,'confirmed_success');
    const reply=t.gateway.decide(t.handles[1],{sessionId:B.authoritySessionId,args:{decision_token:replied.decision_token,action:'complete'}});assert.equal(reply.status,'handled');assert.equal(t.gateway.inbox(t.handles[1]).items.length,0);
    const aReply=t.gateway.inbox(t.handles[0]).items[0];assert.equal(aReply.message.sender_id,B.lifeId);
    t.rooms.setMembership({room_id:room.room_id,principalId:B.lifeId,present:false,expectedRevision:1});
    assert.throws(()=>t.gateway.read(t.handles[1],{room_id:room.room_id}),/CONVERSATION_NOT_VISIBLE/);
    post('TEST ONLY NOT FOR REMOVED B');t.rooms.setMembership({room_id:room.room_id,principalId:B.lifeId,present:true,expectedRevision:2});
    assert.equal(t.gateway.read(t.handles[1],{room_id:room.room_id}).messages.length,0);
    post('TEST ONLY NEW MEMBERSHIP');const fresh=t.gateway.inbox(t.handles[1]).items[0];
    assert.equal(fresh.message.body,'TEST ONLY NEW MEMBERSHIP');assert.notEqual(fresh.membership_epoch,item.membership_epoch);
    const requested=t.gateway.decide(t.handles[1],{sessionId:B.authoritySessionId,args:{inbox_id:fresh.inbox_id,action:'process',expectedRevision:fresh.revision}});
    assert.equal(requested.status,'pending');assert.equal(requested.requested,true);assert.equal(existsSync(resolve(t.fixture.nativeRoot,'sessions')),false);
    const ignored=t.gateway.decide(t.handles[1],{sessionId:B.authoritySessionId,args:{inbox_id:requested.inbox_id,action:'ignore',expectedRevision:requested.revision}});
    assert.equal(ignored.status,'ignored');t.cold();assert.equal(t.gateway.inbox(t.handles[1]).items.length,0);
  }finally{await t.cleanup();}
});
