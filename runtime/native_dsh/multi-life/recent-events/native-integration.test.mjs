import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {DeepSeekAdapter,resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {createNeutralWorld} from '../supervisor/world.mjs';
import {listenLifeHost} from '../platform/http.mjs';
import {mountRoomWorker,createWorkerControlTransport} from '../platform/legacy-worker.mjs';
import {mountRoomInbox} from '../platform/legacy-room-inbox.mjs';
import {roomEventId} from './world.mjs';

for(const ownerIndex of [0,1])test('official Adapter keeps Core, tools and request prefix stable across input reconciliation for owner '+ownerIndex,{timeout:30000},async testContext=>{
  const originalFetch=globalThis.fetch,wires=[];let t,completeId;
  const connection=resolveAdapterOptions({baseURL:'https://api.deepseek.com/anthropic',thinking:'disabled',maxTokens:256,
    models:[{id:'TEST-model',name:'TEST',contextWindow:1000000,maxTokens:256,systemPromptUpdate:'in-history',toolUpdate:'addition-only'}],retryPolicy:{mode:'normal',maxRetries:0}});
  const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'TEST-ONLY-INPUT-RECONCILIATION',
    prepareExtensions:async()=>({fields:{},accept:async()=>{}})});
  globalThis.fetch=async(url,init)=>{
    if(new URL(url).hostname==='127.0.0.1')return originalFetch(url,init);
    assert.equal(new URL(url).hostname,'api.deepseek.com');const wire=JSON.parse(init.body);wires.push(wire);
    const result={status:'ok',disposition:'silent',records:[],actions:[],completed_event_ids:wires.length===1?[]:[completeId]},callId=randomUUID();
    const events=[
      {type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'tool_use',id:callId,name:'life_turn_ack',input:{}}},
      {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(result)}},
      {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:1}},{type:'message_stop'}];
    return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  };
  try {
    t=await setup(adapter,ownerIndex);const agent=t.agent;
    const senderIndex=ownerIndex===0?1:0;const room=t.world.rooms.defineRoom({participants:[t.life(senderIndex),t.life(ownerIndex)]});
    const message=await t.postPeer(senderIndex,room,'TEST ONLY OFFICIAL ADAPTER INPUT');completeId=roomEventId(room.room_id,message.message_id);
    t.advance(19000);assert.equal((await t.driver.tick()).state,'admitted');await t.idle();
    await t.kernel.runtime.prompt({lifeId:t.owner.lifeId,sessionId:agent.session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY NEXT WAKE'}]});await t.idle();
    assert.equal(wires.length,2);assert.equal(wires[1].system,wires[0].system);assert.deepEqual(wires[1].tools,wires[0].tools);
    assert.deepEqual(wires[1].messages.slice(0,wires[0].messages.length),wires[0].messages);
    const next=JSON.stringify(wires[1].messages.slice(wires[0].messages.length));assert(next.includes('本批收口对账'));assert(next.includes('delivery_count'));assert(next.includes('explicitly_completed'));
    const item=(await t.inbox()).items.find(item=>item.message_id===message.message_id);assert.equal(item.status,'handled');
    const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    testContext.diagnostic(JSON.stringify({official_adapter:true,local_sse:true,external_model_calls:0,requests:wires.length,
      static_core_hashes:wires.map(wire=>sha(wire.system)),tool_hashes:wires.map(wire=>sha(wire.tools)),existing_prefix_preserved:true,completed_input:true}));
  }finally{if(t)await t.close();globalThis.fetch=originalFetch;}
});

const silent={status:'ok',disposition:'silent',records:[],actions:[]};
const deferred=()=>{let resolve;const promise=new Promise(accept=>{resolve=accept;});return {promise,resolve};};
async function bounded(promise,label='native integration') {
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST ONLY '+label+' deadline')),20000);})]);}finally{clearTimeout(timer);}
}
class NativeStub extends LlmAdapter {
  requests=[];active=0;maxActive=0;result=silent;
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:1000000}};}
  async *stream(options) {
    assert(Object.isFrozen(options)&&Object.isFrozen(options.messages));assert(options.tools.some(tool=>tool.name==='life_turn_ack'));
    this.requests.push(options);this.active++;this.maxActive=Math.max(this.maxActive,this.active);
    try {
      const number=this.requests.length;await this.onStream?.(options,number);
      const result={records:[],...(typeof this.result==='function'?this.result(options,number):this.result)};
      const block={type:'tool-call',id:randomUUID(),name:'life_turn_ack',arguments:JSON.stringify(result)};
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};
      yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:'tool-calls'}};
    }finally{this.active--;}
  }
}

async function setup(adapter=new NativeStub(),ownerIndex=1) {
  const fixture=await createFixture(['NATIVE A','NATIVE B','NATIVE C']);let registry,kernel,world,http,bridge,driver;
  // Keep the deterministic central clock behind the native driver's real clock;
  // the native coalescing policy must not mistake fixture future timestamps for
  // inputs that have yet to arrive.
  const t={fixture,adapter,now:Date.now()-60000};
  try {
    registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});for(const manifest of fixture.manifests)registry.register(manifest);
    kernel=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter,providerRoutes:['TEST-shared-provider']});
    const agents=await Promise.all(fixture.manifests.map(manifest=>kernel.runtime.create({lifeId:manifest.lifeId,sessionId:manifest.authoritySessionId,role:'authority'})));
    const tokens=fixture.manifests.map(()=> 'TEST ONLY PRIVATE INTEGRATION TOKEN '+randomUUID()),workerBindings=new Map(fixture.manifests.map((manifest,index)=>[manifest.lifeId,{token:tokens[index],allowedPresetId:manifest.deployment.presetId,humanPrincipalId:'human:maintainer'}]));
    world=createNeutralWorld({registry,platformRoot:resolve(fixture.root,'TEST-ONLY-central-world'),workerBindings,now:()=>t.now});
    const humanToken='TEST ONLY LOCAL HUMAN INTEGRATION TOKEN '+randomUUID();
    http=await listenLifeHost(world,{principalId:'human:maintainer',displayName:'用户',token:humanToken});
    const supervisorUrl='http://127.0.0.1:'+http.port;
    const transports=fixture.manifests.map((manifest,index)=>createWorkerControlTransport(supervisorUrl,manifest.lifeId,tokens[index]));
    kernel.ctx.provide('sessionController',{resolveAgent:async id=>({agent:agents.find(agent=>agent.session.id===id)})});
    const owner=fixture.manifests[ownerIndex],agent=agents[ownerIndex];
    bridge=await mountRoomWorker(kernel.ctx,{lifeId:owner.lifeId,authoritySessionId:owner.authoritySessionId,workspace:owner.deployment.workspace,presetId:owner.deployment.presetId,role:'authority',supervisorUrl,token:tokens[ownerIndex]});
    driver=await mountRoomInbox({ctx:kernel.ctx,bridge,lifeId:owner.lifeId,authoritySessionId:owner.authoritySessionId,root:resolve(fixture.root,'TEST-ONLY-B-inbox'),initialPolicy:{peer_idle:true,human_idle:true,rest:false},intervalMs:60000,coalesceMs:0});
    Object.assign(t,{registry,kernel,world,http,bridge,driver,agents,transports,owner,agent});
    t.advance=milliseconds=>{t.now+=milliseconds;};
    t.life=index=>fixture.manifests[index].lifeId;
    t.postHuman=async(room,body)=>{
      const response=await fetch(supervisorUrl+'/v1/rooms/'+encodeURIComponent(room.room_id)+'/messages',{method:'POST',headers:{authorization:'Bearer '+humanToken,'content-type':'application/json'},body:JSON.stringify({body})});
      const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.state,'saved');assert.equal(result.delivery,'durable-room-inbox');return result.message;
    };
    t.postPeer=(index,room,body)=>transports[index]('post',{sessionId:fixture.manifests[index].authoritySessionId,args:{room_id:room.room_id,body}});
    t.inbox=(index=ownerIndex,includeTerminal=true)=>transports[index]('inbox',{includeTerminal});
    t.inspect=(index=1)=>transports[index]('timeline',{recent:{operation:'inspect',sessionId:fixture.manifests[index].authoritySessionId}});
    t.idle=async()=>{await bounded(agent.whenIdle());await bounded(bridge.drainRecent(),'recent completion');await kernel.ctx.sessions.flush(agent.session);};
    t.events=()=>[...agent.session.ownEvents()];
    t.close=async()=>{
      adapter.releaseAll?.();driver.dispose();await bounded(driver.drain(),'inbox cleanup');bridge.dispose();await kernel.ctx.fiber.dispose();
      world.rooms.recentEvents.store.close();await world.dispose();await fixture.cleanup();
    };
    return t;
  }catch(error){adapter.releaseAll?.();driver?.dispose();bridge?.dispose();if(kernel)await kernel.ctx.fiber.dispose();if(world){world.rooms.recentEvents.store.close();await world.dispose();}else{if(http)await http.close();registry?.close();}await fixture.cleanup();throw error;}
}

test('native common worker chain freezes a busy turn then admits four accumulated events in exactly one next wake',{timeout:60000},async()=>{
  const t=await setup(),entered=deferred(),release=deferred();t.adapter.releaseAll=release.resolve;
  try {
    const humanRoom=t.world.rooms.defineRoom({participants:['human:maintainer',t.life(1)]});
    t.adapter.onStream=async(_options,number)=>{if(number===1){entered.resolve();await release.promise;}};
    const first=await t.postHuman(humanRoom,'TEST ONLY FIXED FIRST HUMAN EVENT');t.advance(19000);
    const firstAdmission=await t.driver.tick();assert.equal(firstAdmission.state,'admitted');assert.equal(firstAdmission.count,1);await bounded(entered.promise,'first provider barrier');
    const firstRequest=t.adapter.requests[0],frozenRequest=JSON.stringify(firstRequest.messages);
    const firstSnapshot=firstRequest.messages.find(message=>message.source?.kind==='life-recent-events');
    assert(firstSnapshot);assert.match(firstSnapshot.content[0].text,/【近期发生的事】/u);assert.match(firstSnapshot.content[0].text,/【本次唤醒 · Host Delta】/u);assert.match(firstSnapshot.content[0].text,/From: 用户/u);assert.match(firstSnapshot.content[0].text,/To: 我/u);
    const late=[];for(let count=0;count<4;count++){t.advance(1000);late.push(await t.postHuman(humanRoom,'TEST ONLY LATE EVENT '+count));}
    assert.equal((await t.driver.tick()).state,'busy');assert.equal(t.adapter.requests.length,1);assert.equal(t.adapter.maxActive,1);assert.equal(JSON.stringify(firstRequest.messages),frozenRequest);assert(!frozenRequest.includes('TEST ONLY LATE EVENT'));
    const nativeDuring=t.events();assert.equal(nativeDuring.filter(event=>event.type==='turn/start').length,1);assert.equal(nativeDuring.filter(event=>event.type==='user/message'&&event.data.source?.kind==='room-inbox-batch').length,1);
    release.resolve();await t.idle();
    let central=await t.inspect();assert.equal(Object.values(central.state.batch_status).filter(status=>status.turn_status==='ok').length,1);
    assert.equal((await t.inbox()).items.find(item=>item.message_id===first.message_id).status,'handled');assert((await t.inbox()).items.filter(item=>late.some(message=>message.message_id===item.message_id)).every(item=>item.status==='queued'));
    const secondAdmission=await t.driver.tick();assert.equal(secondAdmission.state,'admitted');assert.equal(secondAdmission.count,4);await t.idle();await t.driver.tick();
    assert.equal(t.adapter.requests.length,2);assert.equal(t.adapter.maxActive,1);assert(t.adapter.requests.every(request=>request.sessionId===t.owner.authoritySessionId));assert.equal(t.bridge.recentStatus().completed,2);assert.equal(t.bridge.recentStatus().failed,0);
    const secondSnapshot=t.adapter.requests[1].messages.findLast(message=>message.source?.kind==='life-recent-events');assert(secondSnapshot);
    const expectedIds=late.map(message=>roomEventId(humanRoom.room_id,message.message_id));for(const [index,id] of expectedIds.entries()){assert(secondSnapshot.content[0].text.includes(id));assert(secondSnapshot.content[0].text.includes('TEST ONLY LATE EVENT '+index));}
    assert.match(secondSnapshot.content[0].text,/本次正式交付 4 条待处理事件/u);assert(!firstSnapshot.content[0].text.includes(expectedIds[0]));
    central=await t.inspect();const batches=Object.values(central.state.batches);assert.equal(batches.length,2);const secondBatch=batches.find(batch=>batch.event_ids.length===4);assert.deepEqual(secondBatch.event_ids,expectedIds);assert(batches.every(batch=>central.state.batch_status[batch.batch_id].turn_status==='ok'));
    const initialBatch=batches.find(batch=>batch.event_ids.length===1);assert.equal(initialBatch.events[0].occurred_at_utc,first.timestamp);assert.notEqual(initialBatch.events[0].occurred_at_utc,initialBatch.delivered_at_utc);assert.equal(initialBatch.authority_session_id,t.owner.authoritySessionId);
    const journal=t.events(),rawSnapshots=journal.filter(event=>event.type==='user/message'&&event.data.source?.kind==='life-recent-events');assert.equal(rawSnapshots.length,2);assert(rawSnapshots.every(event=>batches.some(batch=>batch.batch_id===event.data.source.deliveryBatchId)));
    assert.equal(journal.filter(event=>event.type==='turn/start').length,2);assert.equal(journal.filter(event=>event.type==='turn/end'&&event.data.reason.kind==='completed').length,2);assert(!journal.some(event=>event.type==='user/message'&&event.data.source?.kind==='life-recent-events-retired'));
    assert((await t.inbox()).items.every(item=>item.status==='handled'));assert.equal((await t.inbox(1,false)).items.length,0);assert.equal(t.world.rooms.readForPrincipal('human:maintainer',{room_id:humanRoom.room_id}).messages.length,5,'silent ACK never creates Room speech');
  }finally{release.resolve();await t.close();}
});

test('native group wake can send privately elsewhere and keeps unrelated private events out of its actual model context',{timeout:60000},async()=>{
  const t=await setup();try {
    const group=t.world.rooms.defineRoom({participants:[t.life(0),t.life(1),t.life(2)],visibility:'shared',room_type:'group'}),target=t.world.rooms.defineRoom({participants:[t.life(1),t.life(2)]}),unrelated=t.world.rooms.defineRoom({participants:[t.life(0),t.life(2)]});
    await t.postPeer(0,unrelated,'TEST ONLY UNRELATED PRIVATE EVENT CANARY');
    const source=await t.postPeer(0,group,'TEST ONLY GROUP STIMULUS');t.advance(3000);
    t.adapter.result={status:'ok',disposition:'acted',actions:[{type:'send_message',conversation_id:target.room_id,body:'TEST ONLY PRIVATE CROSS-CONVERSATION ACTION'}]};
    assert.equal((await t.driver.tick()).state,'admitted');await t.idle();await t.driver.tick();
    assert.equal(t.adapter.requests.length,1);const request=t.adapter.requests[0],snapshot=request.messages.find(message=>message.source?.kind==='life-recent-events');assert(snapshot);assert(!JSON.stringify(request.messages).includes('UNRELATED PRIVATE EVENT CANARY'));assert(snapshot.content[0].text.includes('TEST ONLY GROUP STIMULUS'));assert(!snapshot.content[0].text.includes('\nTo:'));
    const central=await t.inspect(),batch=Object.values(central.state.batches)[0],status=central.state.batch_status[batch.batch_id];assert.equal(batch.event_ids[0],roomEventId(group.room_id,source.message_id));assert.equal(status.turn_status,'ok');assert.equal(status.disposition,'acted');assert.equal(batch.events[0].conversation_type,'group');assert(!Object.hasOwn(batch.events[0],'to_actor_id'));
    const original=(await t.inbox()).items.find(item=>item.message_id===source.message_id);assert.equal(original.status,'handled');assert.equal(original.disposition,'acted');
    const publicRows=t.world.rooms.readForPrincipal(t.life(1),{room_id:group.room_id}).messages;assert.equal(publicRows.length,1,'native final ACK is not a reply to its trigger conversation');
    const privateRows=t.world.rooms.readForPrincipal(t.life(1),{room_id:target.room_id}).messages;assert.equal(privateRows.length,1);assert.equal(privateRows[0].sender_id,t.life(1));assert.equal(privateRows[0].origin_session_id,t.owner.authoritySessionId);assert.equal(privateRows[0].message_id,'batch-action:'+batch.batch_id+':0');assert.equal(privateRows[0].body,'TEST ONLY PRIVATE CROSS-CONVERSATION ACTION');
    const c=(await t.inbox(2)).items;assert(c.some(item=>item.message_id===source.message_id&&item.status==='queued'));assert(c.some(item=>item.message_id===privateRows[0].message_id&&item.status==='queued'));assert.equal(t.adapter.requests.filter(item=>item.sessionId===t.fixture.manifests[2].authoritySessionId).length,0,'only B worker is mounted, C retains independent pending decisions');
    const journal=t.events(),call=journal.find(event=>event.type==='tool/call'&&event.data.name==='life_turn_ack');assert(call);assert(journal.some(event=>event.type==='tool/result'&&event.sourceEventSeqs?.includes(call.seq)&&event.data.message.isError===false));assert.equal(journal.findLast(event=>event.type==='turn/end').data.reason.kind,'completed');assert.equal(t.bridge.recentStatus().completed,1);assert.equal(t.bridge.recentStatus().failed,0);
  }finally{await t.close();}
});

test('one native authority wake directly receives complete cross-Room history in append sequence with current Core and permanent protocol',{timeout:60000},async()=>{
  const t=await setup();try {
    const human=t.world.rooms.defineRoom({participants:['human:maintainer',t.life(1)]});
    const peer=t.world.rooms.defineRoom({participants:[t.life(2),t.life(1)]});
    const publicRoom=t.world.rooms.defineRoom({participants:[t.life(0),t.life(1),t.life(2)],visibility:'shared',room_type:'group'});
    const unrelated=t.world.rooms.defineRoom({participants:[t.life(0),t.life(2)]});
    const coreMarker='TEST ONLY CURRENT CORE '+randomUUID();
    const coreText=coreMarker+'\n这是本次 fixture 文件的当前完整文字；它在 Session 建立之后才写入。\n';
    await writeFile(t.owner.deployment.core,coreText,'utf8');
    const bodies={
      public:'TEST ONLY PUBLIC CONTEXT BEGIN\n'+('公共区域完整来源材料。'.repeat(45))+'\nTEST ONLY PUBLIC CONTEXT END',
      human:'TEST ONLY GUANGZE DIRECT BEGIN\n'+('用户私聊完整来源材料。'.repeat(45))+'\nTEST ONLY GUANGZE DIRECT END',
      peer:'TEST ONLY OTHER LIFE DIRECT BEGIN\n'+('另一数字生命私聊完整来源材料。'.repeat(45))+'\nTEST ONLY OTHER LIFE DIRECT END',
    };
    const forbidden='TEST ONLY OTHER OWNERS PRIVATE CANARY '+randomUUID();
    t.advance(1000);const groupMessage=await t.postPeer(0,publicRoom,bodies.public);
    t.advance(1000);const humanMessage=await t.postHuman(human,bodies.human);
    t.advance(1000);await t.postPeer(0,unrelated,forbidden);
    // A trusted delayed arrival proves the model preserves source occurrence time despite
    // Room grouping or global commit order. Its real time is after Room creation
    // but earlier than the public and human messages committed before it. The append order stays public, human, peer.
    const peerOccurrence=new Date(t.now-2500).toISOString();
    const peerMessage=t.world.rooms.postForLife({lifeId:t.life(2),sessionId:t.fixture.manifests[2].authoritySessionId,
      args:{room_id:peer.room_id,body:bodies.peer},occurredAt:peerOccurrence});
    t.advance(1000);
    assert(groupMessage.timeline_seq<humanMessage.timeline_seq&&humanMessage.timeline_seq<peerMessage.timeline_seq);
    const admission=await t.driver.tick();assert.equal(admission.state,'admitted');assert.equal(admission.count,3);await t.idle();
    assert.equal(t.adapter.requests.length,1,'all three visible Rooms reach one actual native model request');
    const request=t.adapter.requests[0];assert.equal(request.sessionId,t.owner.authoritySessionId);
    const snapshots=request.messages.filter(message=>message.source?.kind==='life-recent-events');assert.equal(snapshots.length,1);
    const snapshot=snapshots[0],text=snapshot.content[0].text;
    const central=await t.inspect(),batches=Object.values(central.state.batches);assert.equal(batches.length,1);
    const batch=batches[0];assert.equal(snapshot.source.deliveryBatchId,batch.batch_id);assert.equal(batch.authority_session_id,t.owner.authoritySessionId);
    const rows=[{room:peer,message:peerMessage,body:bodies.peer},{room:publicRoom,message:groupMessage,body:bodies.public},{room:human,message:humanMessage,body:bodies.human}];
    const ids=rows.map(({room,message})=>roomEventId(room.room_id,message.message_id));assert.deepEqual(new Set(batch.event_ids),new Set(ids));
    const positions=rows.map(({body},index)=>{
      assert(text.includes(body.split('\n').map(line=>'│ '+line).join('\n')),'snapshot preserves every source line and its final tail');
      const start=text.indexOf('【事件开始 '+ids[index]+'】');assert(start>=0);return start;
    });assert(positions[1]<positions[2]&&positions[2]<positions[0],'late occurrence appends in Host sequence without changing its source time');
    const eventBlocks=rows.map((_row,index)=>text.slice(positions[index],text.indexOf('【事件结束 '+ids[index]+'】',positions[index])));
    assert.match(eventBlocks[0],new RegExp('From: '+t.fixture.manifests[2].displayName));assert.match(eventBlocks[0],/\nTo: 我/u);
    assert.match(eventBlocks[1],/\nIn: 公共区域/u);assert(!eventBlocks[1].includes('\nTo:'));
    assert.match(eventBlocks[2],/\nFrom: 用户\nTo: 我/u);
    const delta=text.slice(text.lastIndexOf('【本次唤醒 · Host Delta】'));
    assert.match(delta,/本次正式交付 3 条待处理事件/u);assert(delta.includes('交付批次：'+batch.batch_id));assert(delta.includes('ACK 的 delivery_batch_id 指同一个入站批次'));
    for(const id of ids){assert(delta.includes('- '+id));assert(eventBlocks[ids.indexOf(id)].includes('入站批号 '+batch.batch_id));}
    const expectedBeijing=utc=>new Date(Date.parse(utc)+8*3600000).toISOString().slice(0,19).replace('T',' ');
    assert.equal(batch.events.find(event=>event.event_id===ids[0]).occurred_at_utc,peerOccurrence);
    for(const [index,row] of rows.entries())assert(eventBlocks[index].includes('[北京 '+expectedBeijing(row.message.timestamp)+']'));
    assert(delta.includes('本批正式交付时间：北京 '+expectedBeijing(batch.delivered_at_utc)));
    assert(!JSON.stringify(request).includes(forbidden),'another pair’s private conversation never reaches the model');
    const systemText=request.messages.filter(message=>message.role==='system').flatMap(message=>message.content).filter(block=>block.type==='text').map(block=>block.text).join('\n');
    assert(systemText.includes((await readFile(t.owner.deployment.core,'utf8')).trimEnd()),'current file bytes are read into the actual native system prompt');
    assert(systemText.includes(coreMarker));assert.match(systemText,/近期发生的事/u);assert.match(systemText,/每轮必须给明确机器 ACK/u);assert.match(systemText,/life_turn_ack/u);
    const journal=t.events(),calls=journal.filter(event=>event.type==='tool/call');
    assert.deepEqual(calls.map(event=>event.data.name),['life_turn_ack'],'the unified context arrives without any Room or timeline query');
    assert.equal(journal.filter(event=>event.type==='turn/start').length,1);assert.equal(journal.findLast(event=>event.type==='turn/end').data.reason.kind,'completed');
    assert.equal(central.state.batch_status[batch.batch_id].turn_status,'ok');assert.equal(t.bridge.recentStatus().failed,0);
  }finally{await t.close();}
});
