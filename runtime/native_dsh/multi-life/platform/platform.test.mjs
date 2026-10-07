import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {LifeRegistry} from '../registry.mjs';
import {createFixture} from '../fixture.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {Conversations} from './conversations.mjs';
import {ResourceBroker} from './resources.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('resource barrier timeout')),10000);t.unref();})]);
class Stub extends LlmAdapter {
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}
  async *stream(){const block={type:'text',text:'TEST ONLY acknowledged'};yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:block.text};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:'stop'}};}
}
async function setup() {
  const fixture=await createFixture(['A','B','C','D']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  for(const m of fixture.manifests)registry.register(m);
  const host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter:new Stub(),providerRoutes:['TEST-shared-provider']});
  const agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
  const contexts=agents.map(a=>host.contexts.execution(a));
  return {fixture,registry,host,agents,contexts,async cleanup(){await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}};
}
test('private/shared room membership, source identity, dedup and native peer journal survive cold reopen',async()=>{
  const t=await setup();
  try {
    const [A,B,C]=t.contexts,root=resolve(t.fixture.nativeRoot,'conversations');let rooms=new Conversations({contexts:t.host.contexts,root});
    rooms.registerHuman({sender_id:'human:maintainer',display_name:'TEST ONLY human'});
    const privateRoom=rooms.defineRoom({participants:['human:maintainer',A.lifeId]});
    const human=rooms.postHuman('human:maintainer',{conversationId:privateRoom.conversationId,body:'TEST ONLY PRIVATE A'});
    assert.equal(rooms.list(B).length,0);assert.throws(()=>rooms.read(B,{conversationId:privateRoom.conversationId}),/CONVERSATION_NOT_VISIBLE/);
    assert.throws(()=>rooms.post(A,{conversationId:privateRoom.conversationId,body:'bad',senderPrincipalId:B.lifeId}),/SENDER_IS_HOST_BOUND/);
    const room=rooms.defineRoom({participants:['human:maintainer',A.lifeId,B.lifeId],visibility:'shared'}),messageId=randomUUID();
    const message=rooms.post(A,{conversationId:room.conversationId,messageId,body:'TEST ONLY PEER A TO B'});
    assert.equal(message.senderPrincipalId,A.lifeId);assert.equal(rooms.post(A,{conversationId:room.conversationId,messageId,body:message.body}).messageId,messageId);
    assert.throws(()=>rooms.post(A,{conversationId:room.conversationId,messageId,body:'changed'}),/MESSAGE_ID_CONFLICT/);
    rooms.setMembership({conversationId:room.conversationId,principalId:C.lifeId,present:true,expectedRevision:1});
    assert.equal(rooms.read(C,{conversationId:room.conversationId}).messages.length,0);
    rooms.post(B,{conversationId:room.conversationId,body:'TEST ONLY AFTER JOIN'});assert.equal(rooms.read(C,{conversationId:room.conversationId}).messages.length,1);
    const receipt=await rooms.deliverToLife({conversationId:room.conversationId,messageId,lifeId:B.lifeId,runtime:t.host.runtime});
    assert.equal(receipt.status,'queued');rooms.decide(B,{inbox_id:receipt.inbox_id,expectedRevision:receipt.revision,action:'process'});
    const delivered=await rooms.processRequested({lifeId:B.lifeId,inbox_id:receipt.inbox_id,runtime:t.host.runtime});
    assert(delivered.accepted);const agent=await t.host.runtime.resolve({lifeId:B.lifeId,sessionId:delivered.sessionId});await bounded(agent.whenIdle());
    const events=await t.host.runtime.events({lifeId:B.lifeId,sessionId:delivered.sessionId});
    const actual=events.find(e=>e.type==='user/message'&&e.data.source?.kind==='room-inbox');
    assert(actual);assert.equal(actual.data.source.senderPrincipalId,A.lifeId);assert.equal(actual.data.source.conversationId,room.conversationId);
    assert.equal(t.host.contexts.forAgent(agent).lifeId,B.lifeId);assert(events.some(e=>e.type==='system/message'&&JSON.stringify(e.data).includes('TEST ONLY CORE B')));
    const again=await rooms.deliverToLife({conversationId:room.conversationId,messageId,lifeId:B.lifeId,runtime:t.host.runtime});assert.equal(again.attempt.session_id,delivered.sessionId);
    assert.equal([...agent.session.ownEvents()].filter(e=>e.type==='user/message'&&e.data.source?.messageId===messageId).length,1);
    rooms.setMembership({conversationId:room.conversationId,principalId:B.lifeId,present:false,expectedRevision:2});
    assert.throws(()=>rooms.read(B,{conversationId:room.conversationId}),/CONVERSATION_NOT_VISIBLE/);
    await assert.rejects(rooms.deliverToLife({conversationId:room.conversationId,messageId,lifeId:B.lifeId,runtime:t.host.runtime}),/CONVERSATION_NOT_VISIBLE/);
    rooms=new Conversations({contexts:t.host.contexts,root});assert.equal(rooms.read(A,{conversationId:privateRoom.conversationId}).messages[0].bodyHash,human.bodyHash);
  }finally{await t.cleanup();}
});
test('desktop and same-file contention serialize while other files and model requests proceed',async()=>{
  const t=await setup();
  try {
    const [A,B]=t.contexts,broker=new ResourceBroker({contexts:t.host.contexts,locks:t.host.locks}),signal=new AbortController().signal;
    const entered=deferred(),release=deferred();let bDesktop=false,bOther=false;
    const held=broker.withDesktop(A,signal,async()=>{entered.resolve();await release.promise;});await bounded(entered.promise);
    const waiting=broker.withDesktop(B,signal,async()=>{bDesktop=true;});
    await bounded(broker.withFile(B,resolve(B.manifest.deployment.workspace,'different.txt'),signal,async()=>{bOther=true;}));
    await t.host.runtime.prompt({lifeId:B.lifeId,sessionId:B.sessionId,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY MODEL WHILE DESKTOP HELD'}]});await bounded(t.agents[1].whenIdle());
    assert(bOther);assert.equal(bDesktop,false);release.resolve();await Promise.all([held,waiting]);assert(bDesktop);
    const abort=new AbortController(),fileEntered=deferred(),fileRelease=deferred(),file=resolve(t.fixture.root,'shared.txt');
    const holdFile=broker.withFile(A,file,signal,async()=>{fileEntered.resolve();await fileRelease.promise;});await fileEntered.promise;
    const queued=broker.withFile(B,file,abort.signal,async()=>{throw Error('cancelled waiter executed');});abort.abort(Error('TEST cancellation'));await assert.rejects(queued,/TEST cancellation/);
    fileRelease.resolve();await holdFile;assert.equal(t.host.locks.owners.length,0);
  }finally{await t.cleanup();}
});
test('temporary child Agents retain their parent life owner and have no authority or file-write tools',async()=>{
  const t=await setup();
  try {
    const [A,B]=t.contexts,child=await t.host.runtime.delegate(A,{task:'TEST ONLY READ ONLY CHILD'});await bounded(child.agent.whenIdle());
    const owner=t.registry.owner(child.sessionId);assert.equal(owner.lifeId,A.lifeId);assert.equal(owner.parentSessionId,A.sessionId);assert.equal(owner.role,'delegate');
    assert.equal(t.registry.list().length,4);assert.throws(()=>t.host.contexts.requireAuthority(t.host.contexts.execution(child.agent)),/AUTHORITY_REQUIRED/);
    assert.throws(()=>t.registry.reserve({lifeId:B.lifeId,sessionId:randomUUID(),role:'delegate',parentSessionId:A.sessionId}),/DELEGATION_OWNER_MISMATCH/);
    const headers=[...child.agent.session.ownEvents()].filter(e=>e.type==='request/header');assert(headers.length);
    const visible=headers.flatMap(e=>e.data.header.tools??[]);assert(visible.some(tool=>tool.name==='read'),'Child must retain read capability');
    assert(!visible.some(tool=>['write','edit'].includes(tool.name)));
  }finally{await t.cleanup();}
});
