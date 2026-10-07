import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {mountRoomInbox} from './legacy-room-inbox.mjs';
import {mountPlatform} from './mount.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>structuredClone(value);
class Stub extends LlmAdapter {
  requests=[];
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}
  async *stream(options){this.requests.push(options);this.trace.push('model');
    const block={type:'text',text:'TEST ONLY native input processed'};
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:block.text};yield {type:'block-end',index:0,block};
    yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:'stop'}};
  }
}
async function setup(){
  const fixture=await createFixture(['A']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});let host,controller;
  try {
    const [owner]=fixture.manifests;registry.register(owner);const adapter=new Stub(),trace=[];adapter.trace=trace;
    host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter,providerRoutes:['TEST-shared-provider']});
    const agent=await host.runtime.create({lifeId:owner.lifeId,sessionId:owner.authoritySessionId,role:'authority'}),root=resolve(fixture.root,'TEST-ONLY-room-controller');
    const item={inbox_id:randomUUID(),inbox_seq:1,owner_life_id:owner.lifeId,execution_session_id:owner.authoritySessionId,room_id:randomUUID(),message_id:randomUUID(),
      membership_epoch:randomUUID(),status:'pending',requested:false,revision:1,received_at:'2026-10-01T00:00:00.000Z',attempt:null,
      message:{sender_id:'life-'+randomUUID(),sender_type:'life',body_hash:digest('TEST ONLY original input'),body:'TEST ONLY original input'}};
    item.message.message_id=item.message_id;
    let selections=0,acknowledgements=0,authorizations=0,reconciliations=0,loseAck=false,revokeAt=null;
    const send=agent.send.bind(agent);agent.send=(message,target,wake)=>{trace.push('send:'+wake);return send(message,target,wake);};
    const ctx={agents:host.ctx.agents,sessions:{flush:async session=>{trace.push('flush');return host.ctx.sessions.flush(session);}},
      on:host.ctx.on.bind(host.ctx),effect:host.ctx.effect.bind(host.ctx),get:host.ctx.get?.bind(host.ctx)};
    const bridge={
      status:()=>({ready:true,life_id:owner.lifeId,registered_session_id:owner.authoritySessionId}),
      async inspect(){return {inbox:{owner_life_id:owner.lifeId,items:item.status==='revoked'?[]:[clone(item)],nextAfter:1,hasMore:false}};},
      async selectBatch({items}){
        selections++;assert.deepEqual(items.map(row=>row.inbox_id),[item.inbox_id]);
        if(!item.attempt){const id=randomUUID(),rpc='room-inbox-batch:'+owner.lifeId+':'+id;
          const message=createUserMessage({content:[{type:'text',text:JSON.stringify({channel:'room-inbox-batch',items:[{inbox_id:item.inbox_id,message:item.message}]})}],
            source:{kind:'room-inbox-batch',rpcId:rpc,attemptId:id,inboxIds:[item.inbox_id],receiverLifeId:owner.lifeId,modelAdmissionDurability:'journal-flushed-before-provider'}});
          item.attempt={attempt_id:id,session_id:owner.authoritySessionId,request_id:rpc,inbox_ids:[item.inbox_id],requested_inbox_ids:item.requested?[item.inbox_id]:[],state:'prepared',native_message:clone(message),
            native_message_id:message.id,model_admission_durability:'journal-flushed-before-provider'};item.requested=false;item.revision++;
        }
        return {items:[clone(item)],attempt:clone(item.attempt),native_message:clone(item.attempt.native_message)};
      },
      async authorizeBatch({attempt_id}){
        authorizations++;if(revokeAt===authorizations){item.status='revoked';throw Object.assign(Error('TEST ONLY membership revoked'),{code:'INBOX_MEMBERSHIP_REVOKED'});}
        return {authorized:true,attempt_id};
      },
      async acknowledgeBatch({attempt_id}){
        acknowledgements++;trace.push('ack');item.attempt.state='pending';item.revision++;
        if(loseAck){loseAck=false;throw Object.assign(Error('TEST ONLY durable ACK receipt lost'),{code:'TEST_ACK_LOST'});}
        return {attempt_id,items:[clone(item)]};
      },
      async reconcileDelivery({evidence}){reconciliations++;item.attempt.state=evidence.state;item.attempt.native_evidence=clone(evidence);item.retryable=evidence.retryable===true;return clone(item);}
    };
    const t={fixture,registry,host,owner,adapter,agent,root,item,ctx,bridge,trace,
      get counts(){return {selections,acknowledgements,authorizations,reconciliations};},
      loseAck(){loseAck=true;},revokeAt(n){revokeAt=n;},
      async mount(options={}){controller=await mountRoomInbox({ctx,bridge,lifeId:owner.lifeId,authoritySessionId:owner.authoritySessionId,root,intervalMs:60000,...options});t.controller=controller;return controller;},
      async policy(args={},acting=agent){return host.ctx.tools.get('life_inbox_policy',agent).execute(args,{agent:acting,signal:new AbortController().signal});},
      async idle(){await Promise.race([agent.whenIdle(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('TEST ONLY idle deadline')),10000);timer.unref();})]);},
      async cleanup(){controller?.dispose();await controller?.drain();await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}};
    return t;
  }catch(error){controller?.dispose();if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();throw error;}
}

test('schema1 migration preserves exact bytes and owner policy but retires copied receipts',async()=>{
  const t=await setup();try {
    mkdirSync(t.root,{recursive:true});const original=Buffer.from(JSON.stringify({schema_version:1,life_id:t.owner.lifeId,authority_session_id:t.owner.authoritySessionId,
      revision:7,policy:{peer_idle:false,human_idle:false,rest:true},receipts:{old:{state:'needs_review'}},requested_choices:{old:{requested_revision:3}}},null,2)+'\r\n');
    writeFileSync(resolve(t.root,'room-inbox-policy.json'),original);const controller=await t.mount();
    const persisted=JSON.parse(readFileSync(resolve(t.root,'room-inbox-policy.json'),'utf8'));
    assert.equal(persisted.schema_version,2);assert.equal(persisted.revision,7);assert(!Object.hasOwn(persisted,'receipts'));assert(!Object.hasOwn(persisted,'requested_choices'));
    const archive=readdirSync(t.root).find(name=>name.startsWith('room-inbox-policy.schema1.'));assert(archive);assert.deepEqual(readFileSync(resolve(t.root,archive)),original);
    assert.equal((await controller.tick()).state,'rest');assert.equal(t.counts.selections,0);assert.equal(t.item.attempt,null);
    assert.equal(controller.status().receipt_projection_removed,true);await assert.rejects(t.policy({},{}),/LEGACY_INBOX_AUTHORITY_REQUIRED/);
  }finally{await t.cleanup();}
});

test('native journal is flushed and central ACK is accepted before the single native wake',async()=>{
  const t=await setup();try {
    const controller=await t.mount();assert.equal((await controller.tick()).state,'admitted');await t.idle();
    assert(t.trace.indexOf('flush')<t.trace.indexOf('ack'));assert(t.trace.indexOf('ack')<t.trace.indexOf('send:true'));assert(t.trace.indexOf('send:true')<t.trace.indexOf('model'));
    assert.equal(t.adapter.requests.length,1);assert.equal(t.agent.inbox.hasPending,false);
    const inputs=[...t.agent.session.ownEvents()].filter(event=>event.type==='user/message'&&event.data.source?.rpcId===t.item.attempt.request_id);assert.equal(inputs.length,1);
    assert.equal((await controller.tick()).state,'idle');assert.equal(t.adapter.requests.length,1);assert.equal(t.counts.selections,1);assert.equal(t.item.status,'pending');
    assert.equal(t.item.attempt.state,'completed');assert.equal(controller.status().needs_review,0);
  }finally{await t.cleanup();}
});

test('lost central ACK preserves durable pending input and controller reload reuses one attempt and RPC',async()=>{
  const t=await setup();try {
    const first=await t.mount();t.loseAck();assert.equal((await first.tick()).state,'pending');await t.idle();
    assert.equal(t.adapter.requests.length,0);assert.equal(t.agent.inbox.nextTurn.length,1);const original=clone(t.item.attempt),message=clone(t.agent.inbox.nextTurn[0]);
    const saved=[...t.agent.session.ownEvents()].filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted?.some(item=>item.id===message.id));assert.equal(saved.length,1);
    first.dispose();const next=await t.mount();assert.equal((await next.tick()).state,'admitted');await t.idle();
    assert.equal(t.item.attempt.attempt_id,original.attempt_id);assert.equal(t.item.attempt.request_id,original.request_id);assert.equal(t.adapter.requests.length,1);
    const inputs=[...t.agent.session.ownEvents()].filter(event=>event.type==='user/message'&&event.data.source?.rpcId===original.request_id);assert.equal(inputs.length,1);
    assert.equal((await next.tick()).state,'idle');assert.equal(t.adapter.requests.length,1);
  }finally{await t.cleanup();}
});

test('membership revocation cancels only the exact pending Room envelope before any model wake',async()=>{
  const t=await setup();try {
    const controller=await t.mount();t.revokeAt(2);const unrelated=createUserMessage({content:[{type:'text',text:'TEST ONLY unrelated native input'}],source:{kind:'user',rpcId:'TEST-unrelated'}});
    t.agent.send(unrelated,'next-turn',false);const result=await controller.tick();assert.equal(result.error_code,'INBOX_MEMBERSHIP_REVOKED');await t.idle();
    assert.equal(t.adapter.requests.length,0);assert.deepEqual(t.agent.inbox.nextTurn.map(message=>message.id),[unrelated.id]);assert.equal(t.item.status,'revoked');
  }finally{await t.cleanup();}
});

test('owner explicit process bypasses automatic ingress while completed work never becomes a polling loop',async()=>{
  const t=await setup();try {
    const controller=await t.mount({initialPolicy:{peer_idle:false,human_idle:false,rest:false}});
    assert.equal((await controller.tick()).state,'idle');assert.equal(t.counts.selections,0);t.item.requested=true;
    assert.equal((await controller.tick()).state,'admitted');await t.idle();t.item.status='handled';t.item.requested=false;
    for(let i=0;i<3;i++)assert.equal((await controller.tick()).state,'idle');assert.equal(t.adapter.requests.length,1);assert.equal(t.counts.selections,1);
  }finally{await t.cleanup();}
});

test('prior completed attempt survives missing local journal evidence without starting another native turn',async()=>{
  const t=await setup();try {
    await t.bridge.selectBatch({items:[{inbox_id:t.item.inbox_id,expectedRevision:t.item.revision}]});t.item.attempt.state='completed';
    const controller=await t.mount();assert.equal((await controller.tick()).state,'idle');
    assert.equal(t.item.attempt.state,'completed');assert.equal(t.adapter.requests.length,0);assert.equal(t.counts.selections,1);assert.equal(t.counts.reconciliations,0);
  }finally{await t.cleanup();}
});

test('explicit owner admission survives a lost ACK with automatic ingress disabled without a second process request',async()=>{
  const t=await setup();try {
    t.item.requested=true;const first=await t.mount({initialPolicy:{peer_idle:false,human_idle:false,rest:false}});t.loseAck();
    assert.equal((await first.tick()).state,'pending');assert.equal(t.item.requested,false);assert.deepEqual(t.item.attempt.requested_inbox_ids,[t.item.inbox_id]);
    first.dispose();const next=await t.mount();assert.equal((await next.tick()).state,'admitted');await t.idle();
    assert.equal(t.adapter.requests.length,1);assert.equal((await next.tick()).state,'idle');assert.equal(t.adapter.requests.length,1);
  }finally{await t.cleanup();}
});

test('rest pauses admission while finished native execution still reconciles',async()=>{
  const t=await setup();try {
    const controller=await t.mount();assert.equal((await controller.tick()).state,'admitted');await t.idle();
    assert.equal(t.item.attempt.state,'pending');await t.policy({rest:true});assert.equal((await controller.tick()).state,'rest');
    assert.equal(t.item.attempt.state,'completed');assert.equal(t.item.status,'pending');assert.equal(t.counts.reconciliations,1);
    assert.equal(t.counts.selections,1);assert.equal(t.adapter.requests.length,1);
  }finally{await t.cleanup();}
});

test('platform exposes one durable send, independent semantic decisions and current-session effect lookup',async()=>{
  const t=await setup();let platform;try {
    platform=mountPlatform(t.host,{root:resolve(t.fixture.root,'TEST-ONLY-platform-surface')});
    const tool=name=>t.host.ctx.tools.get(name,t.agent),call=(name,args,callId='TEST-native-call')=>tool(name).execute(args,{agent:t.agent,callId,signal:new AbortController().signal});
    assert.equal(tool('life_room_post'),undefined);
    const decision=tool('life_message_decide');assert.deepEqual(decision.parameters.properties.action.enum,['complete','continue','process','defer','ignore']);
    assert.equal(Object.hasOwn(decision.parameters.properties,'body'),false);
    platform.rooms.registerHuman({sender_id:'human:test',display_name:'TEST ONLY local fixture'});
    const room=platform.rooms.defineRoom({participants:['human:test',t.owner.lifeId]}),input=platform.rooms.postHuman('human:test',{room_id:room.room_id,body:'TEST ONLY source input'});
    const inbox=await call('life_receive_message',{});assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].status,'pending');
    const first=await call('life_send_message',{room_id:room.room_id,body:'TEST ONLY outward message'},'stable-send');
    const retry=await call('life_send_message',{room_id:room.room_id,body:'TEST ONLY outward message'},'stable-send');
    assert.equal(first.message_id,retry.message_id);assert.equal(first.message_id,'native-send:'+t.owner.lifeId+':'+t.owner.authoritySessionId+':stable-send');
    assert.equal(first.effect_result.status,'confirmed_success');assert.equal(platform.rooms.readForPrincipal(t.owner.lifeId,{room_id:room.room_id}).messages.length,2);
    assert.equal((await call('life_receive_message',{})).items[0].status,'pending');assert.equal(t.adapter.requests.length,0);
    assert.equal((await call('life_action_result',{room_id:room.room_id,message_id:first.message_id})).status,'confirmed_success');
    assert.equal((await call('life_action_result',{call_id:'TEST-no-such-call'})).status,'unknown');
    await assert.rejects(call('life_action_result',{call_id:'TEST-no-such-call',room_id:room.room_id}),/ACTION_RESULT_REFERENCE_CONFLICT/);
    const reply=await call('life_send_message',{room_id:room.room_id,reply_to:input.message_id,body:'TEST ONLY reply'},'reply-call-1');
    const sameReply=await call('life_send_message',{room_id:room.room_id,reply_to:input.message_id,body:'TEST ONLY reply'},'reply-call-2');
    assert.equal(reply.message_id,sameReply.message_id);assert.equal((await call('life_receive_message',{})).items[0].status,'pending');
    const complete=await call('life_message_decide',{decision_token:inbox.items[0].decision_token,action:'complete'});assert.equal(complete.status,'handled');
    assert.equal(t.adapter.requests.length,0);
  }finally{await t.cleanup();if(platform)assert.equal(platform.rooms.closed,true);}
});
