import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {LifeContexts} from '../context.mjs';
import {Conversations} from './conversations.mjs';
import {TaskStore} from './tasks.mjs';
import {WorkerGateway} from './worker-gateway.mjs';
import {SocialCommunication,socialView,communicationEventId,speechParameters} from './social.mjs';
import {mountRoomWorker} from './legacy-worker.mjs';
import {listenLifeHost} from './http.mjs';

async function setup(){
  const fixture=await createFixture(['A','B','C']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  fixture.manifests.forEach(m=>registry.register(m));const contexts=new LifeContexts(registry),tasks=new TaskStore({contexts,root:resolve(fixture.root,'tasks')});
  const rooms=new Conversations({contexts,tasks,root:resolve(fixture.root,'rooms')});
  const gateway=new WorkerGateway({registry,rooms,tasks,workerBindings:new Map(fixture.manifests.map(m=>[m.lifeId,{token:'TEST TOKEN '+m.lifeId,allowedPresetId:m.deployment.presetId}]))});
  const handles=fixture.manifests.map(m=>{const h=gateway.authenticate({lifeId:m.lifeId,token:'TEST TOKEN '+m.lifeId});gateway.registerSession(h,{header:{version:4,id:m.authoritySessionId,cwd:m.deployment.workspace,createdAt:1,agentPreset:m.deployment.presetId},presetId:m.deployment.presetId,role:'authority'});return h;});
  rooms.registerHuman({sender_id:'human:maintainer',display_name:'TEST HUMAN'});const [A,B,C]=fixture.manifests;
  const privateRoom=rooms.defineRoom({room_id:'TEST-HIDDEN-DIRECT',participants:['human:maintainer',A.lifeId]});
  const publicRoom=rooms.defineRoom({room_id:'TEST-HIDDEN-PUBLIC',room_type:'group',visibility:'shared',participants:['human:maintainer',A.lifeId,B.lifeId]});
  const otherRoom=rooms.defineRoom({room_id:'TEST-HIDDEN-OTHER-PRIVATE',participants:['human:maintainer',C.lifeId]});
  const social=new SocialCommunication(rooms),owner={lifeId:A.lifeId,sessionId:A.authoritySessionId};
  return {fixture,registry,rooms,gateway,handles,social,owner,A,B,C,privateRoom,publicRoom,otherRoom,
    call:(operation,args,callId='call-test')=>gateway.timeline(handles[0],{social:{operation,sessionId:A.authoritySessionId,args,callId}}),
    cleanup:async()=>{rooms.close();registry.close();await fixture.cleanup();}};
}
test('operator visibility repair preserves original messages and audience, and rejects stale revisions',async()=>{
  const t=await setup();try{
    const room=t.rooms.defineRoom({room_id:'TEST-PRIVATE-GROUP',room_type:'group',visibility:'private',participants:['human:maintainer',t.A.lifeId]});
    const message=t.rooms.postHuman('human:maintainer',{room_id:room.room_id,body:'immutable original',message_id:randomUUID()});
    assert.throws(()=>t.rooms.setRoomVisibility({room_id:room.room_id,visibility:'shared',expected_revision:0}),/ROOM_VISIBILITY_UPDATE_INVALID/);
    const changed=t.rooms.setRoomVisibility({room_id:room.room_id,visibility:'shared',expected_revision:room.membershipRevision});
    assert.equal(changed.visibility,'shared');assert.deepEqual(changed.participants,room.participants);
    const original=t.rooms.readForPrincipal('human:maintainer',{room_id:room.room_id}).messages[0];
    assert.equal(original.message_id,message.message_id);assert.equal(original.body_hash,message.body_hash);assert.equal(original.timestamp,message.timestamp);
    assert.throws(()=>t.rooms.setRoomVisibility({room_id:t.privateRoom.room_id,visibility:'shared',expected_revision:t.privateRoom.membershipRevision}),/ROOM_VISIBILITY_UPDATE_INVALID/);
  }finally{await t.cleanup();}
});
test('actor/private/public decisions route without Room parameters or model-visible IDs; cross-scope responses retain event identity',async()=>{
  const t=await setup();try{
    assert(!Object.hasOwn(speechParameters,'room_id'));assert(!Object.hasOwn(speechParameters,'reply_to'));
    const contacts=t.call('contacts',{});assert.equal(contacts.actors.find(a=>a.to==='TEST HUMAN').private_available,true);
    for(const source of [t.privateRoom,t.publicRoom])for(const visibility of ['private','public']){
      const input=t.rooms.postHuman('human:maintainer',{room_id:source.room_id,message_id:randomUUID(),body:'TEST ONLY SOURCE'});
      const eventId=communicationEventId(source.room_id,input.message_id);
      const read=t.call('read',{event_id:eventId});assert.equal(read.body,'TEST ONLY SOURCE');assert(!JSON.stringify(read).includes(source.room_id));
      const args={to:'TEST HUMAN',visibility,body:'TEST REPLY '+visibility,in_response_to:eventId};
      const callId='test-'+eventId+'-'+visibility;const reply=t.call('speak',args,callId);assert.equal(reply.in_response_to,eventId);assert.equal(reply.effect_result.status,'confirmed_success');
      assert(t.rooms.recentEvents.store.event(reply.event_id),'same-turn speech evidence is already durable');
      const stored=t.rooms.recentMessageById(t.A.lifeId,t.A.authoritySessionId,[t.social.event(t.owner,reply.event_id).payload.message_id])[0];
      assert.equal(stored.room.room_id,visibility==='private'?t.privateRoom.room_id:t.publicRoom.room_id);
      assert.equal(stored.message.inResponseTo,eventId);assert.equal(stored.message.addressee,'human:maintainer');
      assert.equal(stored.message.reply_to,source.room_id===stored.room.room_id?input.message_id:null);
      assert.equal(t.call('speak',args,callId).event_id,reply.event_id);
      const second=t.call('speak',{...args,body:'SECOND RESPONSE'},'second-'+eventId+'-'+visibility);assert.notEqual(second.event_id,reply.event_id);
      assert.throws(()=>t.call('speak',{...args,body:'CHANGED BODY'},callId),/ALREADY_COMMITTED|REPLY_ALREADY_COMMITTED/);
      const clean=t.call('read',{event_id:reply.event_id});assert(!Object.hasOwn(clean,'conversation_id'));assert(!Object.hasOwn(clean.payload,'room_seq'));
    }
    const plain=t.call('speak',{to:'everyone',visibility:'public',body:'TEST BROADCAST'},'broadcast-call');assert.equal(plain.to,'everyone');
    assert.equal(t.call('result',{operation_id:'broadcast-call'}).status,'confirmed_success');
    for(const args of [{room_id:t.privateRoom.room_id,body:'old'},{to:'everyone',visibility:'private',body:'bad'},
      {to:t.C.lifeId,visibility:'private',body:'inaccessible'},{to:'TEST HUMAN',visibility:'private',body:'bad',sender_id:t.B.lifeId}])assert.throws(()=>t.call('speak',args));
    const secret=t.rooms.postHuman('human:maintainer',{room_id:t.otherRoom.room_id,body:'SECRET OTHER LIFE'});
    assert.throws(()=>t.call('read',{event_id:communicationEventId(t.otherRoom.room_id,secret.message_id)}),/NOT_VISIBLE/);
  }finally{await t.cleanup();}
});
test('ambiguous routes fail closed; configured defaults and source event resolve only eligible routes',async()=>{
  const t=await setup();try{
    t.rooms.defineRoom({room_id:'TEST-HIDDEN-SECOND',participants:['human:maintainer',t.A.lifeId]});
    const args={to:'TEST HUMAN',visibility:'private',body:'TEST ONLY'};
    assert.throws(()=>t.call('speak',args),/SOCIAL_ROUTE_AMBIGUOUS/);
    writeFileSync(t.rooms.socialRoutingPath,JSON.stringify({version:1,private:{[t.A.lifeId]:{'human:maintainer':t.privateRoom.room_id}},public:{[t.A.lifeId]:t.publicRoom.room_id}}));
    const result=t.call('speak',args);assert.equal(result.visibility,'private');
    assert.equal(t.rooms.recentMessageById(t.A.lifeId,t.A.authoritySessionId,[t.social.event(t.owner,result.event_id).payload.message_id])[0].room.room_id,t.privateRoom.room_id);
    assert.equal(t.call('speak',args,'call-test').event_id,result.event_id);
    const raw=t.rooms.inboxForLife({lifeId:t.A.lifeId,includeTerminal:true});const clean=socialView(raw);
    assert(!JSON.stringify(clean).includes('"room_id"'));
  }finally{await t.cleanup();}
});
test('actual worker tool boundary accepts actor speech and event reads, removes Room tools and sanitizes Inbox',async()=>{
  const t=await setup();let http,worker;try{
    const tools=new Map(),sections=new Map(),header={version:4,id:t.A.authoritySessionId,cwd:t.A.deployment.workspace,createdAt:1,agentPreset:t.A.deployment.presetId};
    const agent={session:{id:header.id,header},ctx:{tools:{register:tool=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},
      systemPrompt:{section:section=>{sections.set(section.name,section);return()=>sections.delete(section.name);}}}};
    const ctx={agents:{get:id=>id===header.id?agent:undefined},sessionController:{resolveAgent:async()=>agent},on:()=>()=>{},effect:()=>{}};
    http=await listenLifeHost({ctx:{effect:()=>{}},contexts:t.rooms.contexts,rooms:t.rooms,workerGateway:t.gateway},
      {principalId:'human:maintainer',displayName:'TEST HUMAN',token:'TEST HUMAN CHANNEL TOKEN WITH AT LEAST 32 CHARS'});
    worker=await mountRoomWorker(ctx,{lifeId:t.A.lifeId,authoritySessionId:header.id,workspace:header.cwd,presetId:header.agentPreset,supervisorUrl:'http://127.0.0.1:'+http.port,token:'TEST TOKEN '+t.A.lifeId});
    const exec={agent,callId:'native-tool-call',signal:new AbortController().signal};
    assert(!tools.has('life_room_list'));assert(!tools.has('life_room_read'));assert(tools.has('life_contact_list'));assert(tools.has('life_event_read'));
    const original=t.rooms.postHuman('human:maintainer',{room_id:t.publicRoom.room_id,body:'TEST ONLY PUBLIC SOURCE'}),eventId=communicationEventId(t.publicRoom.room_id,original.message_id);
    const read=await tools.get('life_event_read').execute({event_id:eventId},exec);assert.equal(read.body,'TEST ONLY PUBLIC SOURCE');
    const inbox=await tools.get('life_receive_message').execute({},exec);assert(!JSON.stringify(inbox).includes(t.publicRoom.room_id));assert.equal(inbox.items[0].message_ref.event_id,eventId);
    const result=await tools.get('life_send_message').execute({to:'TEST HUMAN',visibility:'private',body:'TEST ONLY PRIVATE RESPONSE',in_response_to:eventId},exec);
    assert.equal(result.visibility,'private');assert.equal(result.in_response_to,eventId);assert(!JSON.stringify(result).includes(t.privateRoom.room_id));
    await assert.rejects(tools.get('life_send_message').execute({room_id:t.privateRoom.room_id,body:'OLD API'},exec));
    const page=await tools.get('life_message_timeline').execute({},exec);assert(page.events.some(e=>e.event_id===eventId));assert(!JSON.stringify(page).includes(t.publicRoom.room_id));
  }finally{worker?.dispose();if(http)await http.close();await t.cleanup();}
});
