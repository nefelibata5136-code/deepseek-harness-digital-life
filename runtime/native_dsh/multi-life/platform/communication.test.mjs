import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootLifeHost} from '../host.mjs';
import {Conversations} from './conversations.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const bounded=p=>Promise.race([p,new Promise((_,no)=>{const t=setTimeout(()=>no(Error('communication deadline')),15000);t.unref();})]);
class Stub extends LlmAdapter {
  calls=[];blocks=new Map();
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:1000000},defaultMaxTokens:256};}
  async *stream(options){this.calls.push(options.sessionId);const barrier=this.blocks.get(options.sessionId);if(barrier){barrier.entered.resolve();await barrier.release.promise;}
    const block={type:'text',text:'TEST ONLY optional social output'};yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:block.text};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}};}
}
async function setup(){const fixture=await createFixture(['A','B','C','D']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),adapter=new Stub();for(const m of fixture.manifests)registry.register(m);
  const host=await bootLifeHost({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter,providerRoutes:['TEST-shared-provider'],memoryBindings:new Map(),ownerBindings:new Map(),admit:async()=>({allowed:true})});
  const agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'}))),contexts=agents.map(a=>host.contexts.execution(a));
  host.rooms.registerHuman({sender_id:'human:TEST-maintainer',display_name:'TEST ONLY Maintainer'});host.rooms.registerHuman({sender_id:'human:TEST-other',display_name:'TEST ONLY other human'});
  return {fixture,registry,host,adapter,agents,contexts,async close(){await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}};
}
test('formal sender truth and atomic inbox fanout; role=user never establishes human identity',async()=>{
  const t=await setup();try{const [A,B,C]=t.contexts,r=t.host.rooms;
    const group=r.defineRoom({participants:['human:TEST-maintainer',A.lifeId,B.lifeId],room_type:'group'});
    assert.equal(group.room_type,'group');assert.equal(group.participant_details.find(p=>p.sender_id===A.lifeId).display_name,A.manifest.displayName);
    const sent=r.post(A,{room_id:group.room_id,body:'TEST ONLY peer message',message_id:randomUUID()});
    assert.equal(sent.sender_type,'life');assert.equal(sent.life_id,A.lifeId);assert.equal(sent.origin_task_id,t.host.taskStore.forSession(A.sessionId).task_id);
    assert.deepEqual(r.read(A,{room_id:group.room_id}).messages,r.read(B,{room_id:group.room_id}).messages);
    assert.equal(r.receive(B).items.length,1);assert.equal(r.receive(A).items.length,0);assert.equal(r.receive(C).items.length,0);assert.equal(t.adapter.calls.length,0);
    assert.equal(r.post(A,{room_id:group.room_id,body:sent.body,message_id:sent.message_id}).message_id,sent.message_id);assert.equal(r.receive(B).items.length,1);
    assert.throws(()=>r.post(A,{room_id:group.room_id,body:'spoof',sender_id:B.lifeId}),/SENDER_IS_HOST_BOUND/);
    const dm=r.defineRoom({participants:['human:TEST-other',B.lifeId]});const human=r.postHuman('human:TEST-other',{room_id:dm.room_id,body:'TEST ONLY actual different human'});
    assert.equal(human.sender_id,'human:TEST-other');assert.equal(human.life_id,null);assert.equal(human.sender_type,'human');
    const timeline=r.timeline(B);assert.deepEqual(timeline.messages.map(x=>x.message_id),[sent.message_id,human.message_id]);assert(timeline.messages.every(x=>Number.isFinite(Date.parse(x.timestamp))));
    assert.equal(r.timeline(A).messages.length,1);assert.equal(r.timeline(C).messages.length,0);assert.equal(r.timeline(B,{after:sent.timeline_seq}).messages[0].message_id,human.message_id);
    const attention=await t.host.life.attention(B,t.agents[1]);assert.doesNotThrow(()=>JSON.stringify(attention));assert(Object.values(attention.counts).every(x=>Number.isInteger(x)));
    const rpc=randomUUID();await t.host.runtime.prompt({lifeId:B.lifeId,sessionId:B.sessionId,requestId:rpc,content:[{type:'text',text:'TEST ONLY unknown channel'}]});await bounded(t.agents[1].whenIdle());
    const source=[...t.agents[1].session.ownEvents()].find(e=>e.type==='user/message'&&e.data.source?.rpcId===rpc).data.source;assert.equal(source.sender.sender_type,'unknown');assert.equal(source.sender.sender_id,null);
  }finally{await t.close();}
});
test('busy owner receives persistent inbox without cancel, steer or new native turn; autonomous defer and ignore survive reopen',async()=>{
  const t=await setup();const barrier={entered:deferred(),release:deferred()};try{const [A,B]=t.contexts,r=t.host.rooms,room=r.defineRoom({participants:[A.lifeId,B.lifeId]});
    t.adapter.blocks.set(B.sessionId,barrier);await t.host.runtime.prompt({lifeId:B.lifeId,sessionId:B.sessionId,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY long task'}]});await bounded(barrier.entered.promise);
    const before=[...t.agents[1].session.ownEvents()].length;r.post(A,{room_id:room.room_id,body:'TEST ONLY while B busy'});let item=r.receive(B).items[0];
    r.decide(B,{inbox_id:item.inbox_id,action:'process',expectedRevision:item.revision});const busy=await t.host.processInbox({lifeId:B.lifeId,inbox_id:item.inbox_id});assert.equal(busy.reason,'life-busy');
    assert.equal([...t.agents[1].session.ownEvents()].length,before);assert.equal(t.registry.sessions(B.lifeId).length,1);assert.equal(t.agents[1].status,'running');
    item=r.receive(B).items[0];r.decide(B,{inbox_id:item.inbox_id,action:'defer',expectedRevision:item.revision});
    assert.equal((await t.host.processInbox({lifeId:B.lifeId,inbox_id:item.inbox_id})).reason,'receiver-choice-required');
    const cold=new Conversations({contexts:t.host.contexts,root:resolve(t.fixture.nativeRoot,'platform/conversations'),tasks:t.host.taskStore});assert.equal(cold.receive(B).items[0].status,'deferred');
    item=r.receive(B).items[0];r.decide(B,{inbox_id:item.inbox_id,action:'ignore',expectedRevision:item.revision});assert.equal(r.receive(B).items.length,0);
    assert.equal(r.receive(B,{includeTerminal:true}).items[0].status,'ignored');assert.throws(()=>r.decide(A,{inbox_id:item.inbox_id,action:'reply',body:'spoof',expectedRevision:3}),/INBOX_NOT_VISIBLE/);
    barrier.release.resolve();await bounded(t.agents[1].whenIdle());assert.equal(t.adapter.calls.length,1);
  }finally{barrier.release.resolve();await t.close();}
});
test('selected delivery uses native maintenance, exact Core and result owner; explicit reply queues peer without automatic loop',async()=>{
  const t=await setup();try{const [A,B]=t.contexts,r=t.host.rooms,room=r.defineRoom({participants:[A.lifeId,B.lifeId]});r.post(A,{room_id:room.room_id,body:'TEST ONLY invitation'});let item=r.receive(B).items[0];
    r.decide(B,{inbox_id:item.inbox_id,action:'process',expectedRevision:item.revision});const delivered=await t.host.processInbox({lifeId:B.lifeId,inbox_id:item.inbox_id});assert(delivered.accepted);
    const receiving=await t.host.runtime.resolve({lifeId:B.lifeId,sessionId:delivered.sessionId});await bounded(receiving.whenIdle());
    const events=[...receiving.session.ownEvents()],message=events.find(e=>e.type==='user/message'&&e.data.source?.kind==='room-inbox');assert.equal(message.data.source.sender.life_id,A.lifeId);assert.equal(message.data.source.receiverLifeId,B.lifeId);
    const bc=t.host.contexts.execution(receiving);item=r.receive(bc).items[0];r.decide(bc,{inbox_id:item.inbox_id,action:'reply',expectedRevision:item.revision,body:'TEST ONLY chosen reply'});
    assert.equal(r.receive(bc).items.length,0);assert.equal(r.receive(A).items.length,1);assert.equal(r.receive(A).items[0].message.sender_id,B.lifeId);assert.equal(t.adapter.calls.length,1);
    const child=await t.host.runtime.delegate(bc,{task:'TEST ONLY owned room task'});await bounded(child.agent.whenIdle());const task=t.host.taskStore.forSession(child.sessionId);
    assert.equal(task.owner_life_id,B.lifeId);assert.equal(task.origin_room_id,room.room_id);assert.equal(task.parent_task_id,t.host.taskStore.forSession(receiving.session.id).task_id);
    assert.equal(t.host.taskStore.readResults(A,{}).results.length,0);assert.equal(t.host.taskStore.readResults(bc,{}).results[0].task_id,task.task_id);assert.equal(t.registry.list().length,4);
  }finally{await t.close();}
});
test('membership remove/rejoin during async setup revokes old delivery epoch',async()=>{
  const t=await setup();const barrier={entered:deferred(),release:deferred()};try{const [A,B]=t.contexts,r=t.host.rooms,room=r.defineRoom({participants:[A.lifeId,B.lifeId]});r.post(A,{room_id:room.room_id,body:'TEST ONLY old epoch'});const item=r.receive(B).items[0];r.decide(B,{inbox_id:item.inbox_id,action:'process',expectedRevision:item.revision});
    const original=t.host.runtime.create.bind(t.host.runtime);t.host.runtime.create=async args=>{barrier.entered.resolve();await barrier.release.promise;return original(args);};
    const running=t.host.processInbox({lifeId:B.lifeId,inbox_id:item.inbox_id});await bounded(barrier.entered.promise);
    r.setMembership({room_id:room.room_id,principalId:B.lifeId,present:false,expectedRevision:1});r.setMembership({room_id:room.room_id,principalId:B.lifeId,present:true,expectedRevision:2});barrier.release.resolve();
    await assert.rejects(running,/INBOX_MEMBERSHIP_REVOKED/);assert.equal(t.adapter.calls.length,0);assert.equal(r.receive(B).items.length,0);assert.equal(r.read(B,{room_id:room.room_id}).messages.length,0);
    r.post(A,{room_id:room.room_id,body:'TEST ONLY new epoch'});assert.equal(r.receive(B).items.length,1);assert.notEqual(r.receive(B).items[0].membership_epoch,item.membership_epoch);
  }finally{barrier.release.resolve();await t.close();}
});
test('post-send flush failure removes native pending before maintenance wakes; retry requires explicit choice',async()=>{
  const t=await setup();try{const [A,B]=t.contexts,r=t.host.rooms,room=r.defineRoom({participants:[A.lifeId,B.lifeId]});r.post(A,{room_id:room.room_id,body:'TEST ONLY fail seal'});let item=r.receive(B).items[0];r.decide(B,{inbox_id:item.inbox_id,action:'process',expectedRevision:item.revision});
    const original=t.host.ctx.sessions.flush.bind(t.host.ctx.sessions);let failed=false;t.host.ctx.sessions.flush=async session=>{const agent=t.host.ctx.agents.get(session.id);if(!failed&&agent?.inbox.nextTurn.some(m=>m.source?.kind==='room-inbox')){failed=true;throw Error('TEST ONLY injected flush failure');}return original(session);};
    await assert.rejects(t.host.processInbox({lifeId:B.lifeId,inbox_id:item.inbox_id}),/injected flush/);assert(failed);assert.equal(t.adapter.calls.length,0);
    item=r.receive(B).items[0];assert.equal(item.status,'needs_review');assert.equal(t.host.ctx.agents.get(item.attempt.session_id).inbox.nextTurn.length,0);
    assert.equal((await t.host.processInbox({lifeId:B.lifeId,inbox_id:item.inbox_id})).reason,'receiver-choice-required');
    r.decide(B,{inbox_id:item.inbox_id,action:'process',expectedRevision:item.revision});const delivered=await t.host.processInbox({lifeId:B.lifeId,inbox_id:item.inbox_id});await bounded(t.host.ctx.agents.get(delivered.sessionId).whenIdle());assert.equal(t.adapter.calls.length,1);
  }finally{await t.close();}
});

test('explicit human observer reads peer history without becoming a group member or gaining send access',async()=>{
  const t=await setup();try{const [A,B,C]=t.contexts,r=t.host.rooms,room=r.defineRoom({participants:[A.lifeId,B.lifeId],room_type:'direct'});
    r.post(A,{room_id:room.room_id,body:'TEST ONLY prior peer statement'});
    assert.throws(()=>r.readForPrincipal('human:TEST-maintainer',{room_id:room.room_id}),/CONVERSATION_NOT_VISIBLE/);
    const observed=r.setObserver({room_id:room.room_id,principalId:'human:TEST-maintainer',present:true,expectedRevision:1});
    assert.deepEqual(observed.participants,[A.lifeId,B.lifeId]);assert.equal(observed.room_type,'direct');assert.equal(observed.access.can_send,false);
    assert.equal(r.readForPrincipal('human:TEST-maintainer',{room_id:room.room_id}).messages.length,1);
    assert.throws(()=>r.postHuman('human:TEST-maintainer',{room_id:room.room_id,body:'TEST ONLY observer cannot send'}),/CONVERSATION_NOT_VISIBLE/);
    assert.equal(r.listForPrincipal(C.lifeId).length,0);
    for(let n=0;n<12;n++)r.post(n%2?A:B,{room_id:room.room_id,body:'TEST ONLY unrestricted conversational turn '+n});
    assert.equal(r.timelineForPrincipal('human:TEST-maintainer').messages.length,13);
    const cold=new Conversations({contexts:t.host.contexts,root:resolve(t.fixture.nativeRoot,'platform/conversations'),tasks:t.host.taskStore});
    assert.equal(cold.readForPrincipal('human:TEST-maintainer',{room_id:room.room_id}).room.access.can_send,false);
    r.setObserver({room_id:room.room_id,principalId:'human:TEST-maintainer',present:false,expectedRevision:2});
    assert.throws(()=>r.readForPrincipal('human:TEST-maintainer',{room_id:room.room_id}),/CONVERSATION_NOT_VISIBLE/);assert.equal(r.timelineForPrincipal('human:TEST-maintainer').messages.length,0);
    const revokedCold=new Conversations({contexts:t.host.contexts,root:resolve(t.fixture.nativeRoot,'platform/conversations'),tasks:t.host.taskStore});
    revokedCold.grantInitialObserver({room_id:room.room_id,principalId:'human:TEST-maintainer'});
    assert.throws(()=>revokedCold.readForPrincipal('human:TEST-maintainer',{room_id:room.room_id}),/CONVERSATION_NOT_VISIBLE/,'cold startup preserves an explicit revocation');
  }finally{await t.close();}
});
