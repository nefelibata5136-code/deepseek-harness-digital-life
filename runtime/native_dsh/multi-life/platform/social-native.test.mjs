// Real installed preset, Agent loop, native tools and official Adapter; local SSE.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {writeFile,readFile} from 'node:fs/promises';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootLifeHost} from '../host.mjs';
import {createOfficialProviderFactory} from './official-provider.mjs';
import {WorkerGateway} from './worker-gateway.mjs';
import {listenLifeHost} from './http.mjs';
import {mountRoomWorker} from './legacy-worker.mjs';
import {mountRoomInbox} from './legacy-room-inbox.mjs';
import {communicationEventId} from './social.mjs';

test('both native presets execute speech, filesystem, tests, further speech and terminal finish; official request prefixes remain stable',{timeout:60000},async()=>{
  const fixture=await createFixture(['A','B']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  const queues=[],wire=[],bridges=[],drivers=[];let host,http;
  try {
    for(const m of fixture.manifests){m.deployment.provider='deepseek-official';m.deployment.model='deepseek-flash';m.deployment.maxTokens=256;registry.register(m);}
    host=await bootLifeHost({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,providerRoutes:['deepseek-official'],digitalLifePreset:true,
      memoryBindings:new Map(),ownerBindings:new Map(),admit:async()=>({allowed:true}),externalWorld:true,
      budgetConfig:{accounts:new Map([['TEST-account',{dailyLimitNanoCny:50000000000,stopOnUnknownUsage:true}]]),lifeAccounts:new Map(fixture.manifests.map(m=>[m.lifeId,{accountRef:'TEST-account'}]))},
      providerFactory:createOfficialProviderFactory({credentialForAccount:async()=>'TEST-ONLY-SOCIAL-KEY-1234567890'}),
      rawModelTransport:async(_url,init)=>{
        const request=JSON.parse(init.body);wire.push(request);const step=queues.shift();assert(step,'unexpected model continuation');
        assert(request.tools.some(t=>t.name==='read'));assert(request.tools.some(t=>t.name==='edit'));assert(request.tools.some(t=>t.name==='life_send_message'));
        const speech=request.tools.find(t=>t.name==='life_send_message');assert(!speech.input_schema.properties.room_id);assert(!speech.input_schema.properties.action);
        const callId=randomUUID(),events=[
          {type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:100,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
          {type:'content_block_start',index:0,content_block:{type:'tool_use',id:callId,name:step.name,input:{}}},
          {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(typeof step.args==='function'?step.args():step.args)}},
          {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},{type:'message_stop'}];
        return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
      }});
    const agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    host.ctx.provide('sessionController',{resolveAgent:async id=>({agent:agents.find(a=>a.session.id===id)})});
    const tokens=fixture.manifests.map(()=> 'TEST ONLY WORKER TOKEN '+randomUUID());
    host.workerGateway=new WorkerGateway({registry,rooms:host.rooms,tasks:host.taskStore,
      workerBindings:new Map(fixture.manifests.map((m,i)=>[m.lifeId,{token:tokens[i],allowedPresetId:m.deployment.presetId,humanPrincipalId:'human:maintainer'}]))});
    http=await listenLifeHost(host,{principalId:'human:maintainer',displayName:'用户',token:'TEST ONLY HUMAN TOKEN '+randomUUID()});
    const publicRoom=host.rooms.defineRoom({room_id:'TEST-ONLY-PUBLIC-OPAQUE',room_type:'group',visibility:'shared',participants:['human:maintainer',...fixture.manifests.map(m=>m.lifeId)]});
    host.rooms.defineRoom({room_id:'TEST-ONLY-PEER-OPAQUE',participants:fixture.manifests.map(m=>m.lifeId)});
    for(const [i,m]of fixture.manifests.entries()){
      const agent=agents[i],preset=host.ctx.agentPresets.serviceFor(agent,'digitalLifeSocial');assert.equal(preset.nativePreset,true);
      const bridge=await mountRoomWorker(host.ctx,{lifeId:m.lifeId,authoritySessionId:m.authoritySessionId,workspace:m.deployment.workspace,presetId:m.deployment.presetId,
        supervisorUrl:'http://127.0.0.1:'+http.port,token:tokens[i]});bridges.push(bridge);
      const driver=await mountRoomInbox({ctx:host.ctx,bridge,lifeId:m.lifeId,authoritySessionId:m.authoritySessionId,root:resolve(fixture.root,'TEST-inbox-'+i),intervalMs:60000,coalesceMs:0,
        initialPolicy:{human_idle:true,peer_idle:false,rest:false}});drivers.push(driver);
      const file=resolve(m.deployment.workspace,'safe-native-test.txt');await writeFile(file,'TEST BEFORE\n');
      const begin=wire.length;queues.push(
        {name:'life_send_message',args:{to:'用户',visibility:'public',body:'TEST PUBLIC '+i}},
        {name:'read',args:{file_path:file}},
        {name:'edit',args:{file_path:file,old_string:'TEST BEFORE',new_string:'TEST AFTER'}},
        {name:'read',args:{file_path:file}},
        {name:'digital_life_foundation_check',args:{}},
        {name:'life_send_message',args:{to:fixture.manifests[1-i].displayName,visibility:'private',body:'TEST PEER '+i}},
        {name:'life_send_message',args:{to:'用户',visibility:'public',body:'TEST SECOND PUBLIC '+i}},
        {name:'life_turn_ack',args:()=>{
          const sent=host.rooms.recentMessageSources(m.lifeId,m.authoritySessionId).filter(x=>x.message.sender_id===m.lifeId);
          return {records:[{key:'TEST-speech-proof',kind:'communication',summary:'TEST ONLY same-turn committed speeches',
            evidence_event_ids:sent.map(x=>communicationEventId(x.room.room_id,x.message.message_id))}]};
        }});
      host.rooms.postHuman('human:maintainer',{room_id:publicRoom.room_id,body:'TEST ONLY ONE HUMAN STIMULUS '+i});
      assert.equal((await driver.tick()).state,'admitted');await new Promise(done=>setTimeout(done,50));await agent.whenIdle();await bridge.drainRecent();await host.ctx.sessions.flush(agent.session);
      assert.equal(queues.length,0,JSON.stringify([...agent.session.ownEvents()].filter(e=>['turn/end','tool/result'].includes(e.type)).map(e=>({type:e.type,data:e.data}))));assert.equal(await readFile(file,'utf8'),'TEST AFTER\n');
      const calls=[...agent.session.ownEvents()].filter(e=>e.type==='tool/call');assert.equal(calls.length,8);
      assert.equal(new Set(calls.map(e=>e.data.turn)).size,1);
      for(const call of calls){const result=[...agent.session.ownEvents()].find(e=>e.type==='tool/result'&&e.sourceEventSeqs?.includes(call.seq));assert.equal(result?.data.message?.isError,false,JSON.stringify(result?.data));}
      assert.equal([...agent.session.ownEvents()].findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
      const requests=wire.slice(begin);assert.equal(requests.length,8);
      for(let j=1;j<requests.length;j++){
        assert.equal(requests[j].system,requests[0].system);assert.deepEqual(requests[j].tools,requests[0].tools);
        assert.deepEqual(requests[j].messages.slice(0,requests[j-1].messages.length),requests[j-1].messages);
      }
      assert(!JSON.stringify(requests).includes(publicRoom.room_id));assert(!JSON.stringify(requests).includes('"room_id"'));
      driver.dispose();await driver.drain();
    }
  }finally{for(const d of drivers)d.dispose();for(const b of bridges)b.dispose();if(http)await http.close();if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}
});
