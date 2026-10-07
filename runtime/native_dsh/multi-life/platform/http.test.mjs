import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootLifeHost} from '../host.mjs';
import {listenLifeHost} from './http.mjs';

class Stub extends LlmAdapter {
  plans=new Map();
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}
  async *stream(options) {
    const step=this.plans.get(options.sessionId);this.plans.delete(options.sessionId);
      const block=step?{type:'tool-call',id:randomUUID(),name:step.name??'write',arguments:JSON.stringify(step.args??step)}:{type:'text',text:'TEST ONLY HTTP receipt'};
    yield {type:'block-start',index:0,blockType:block.type};
    if(step)yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};
    else yield {type:'text-delta',index:0,text:block.text};
    yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};
    yield {type:'finish',reason:{kind:step?'tool-calls':'stop'}};
  }
}
const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('TEST ONLY HTTP deadline')),20000);timer.unref();})]);

test('authenticated HTTP requires exact owner, preserves RPC dedup and human signature; native fs cannot overwrite domain state',async()=>{
  const fixture=await createFixture(['A','B','C','D']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),adapter=new Stub();let host,channel;
  try {
    for(const m of fixture.manifests)registry.register(m);
    host=await bootLifeHost({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter,providerRoutes:['TEST-shared-provider'],
      memoryBindings:new Map(),ownerBindings:new Map(),admit:async()=>({allowed:true})});
    const agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    const [A,B]=fixture.manifests;channel=await listenLifeHost(host,{principalId:'human:maintainer',displayName:'TEST ONLY human',operator:true});
    const request=async(path,input,{auth=true}={})=>{
      const response=await fetch('http://127.0.0.1:'+channel.port+path,{method:input===undefined?'GET':'POST',
        headers:{...auth?{authorization:'Bearer '+channel.token}:{},'content-type':'application/json'},...input===undefined?{}:{body:JSON.stringify(input)}});
      return {status:response.status,data:await response.json()};
    };
    assert.equal((await request('/lives',undefined,{auth:false})).status,403);
    assert.equal((await request('/lives')).data.lives.length,4);
    assert.equal((await request('/lives')).data.osStrongIsolation,false);
    const input={lifeId:A.lifeId,sessionId:A.authoritySessionId,requestId:randomUUID(),text:'TEST ONLY HTTP A'};
    assert.equal((await request('/life/prompt',{...input,lifeId:B.lifeId})).status,404);
    assert.equal((await request('/life/prompt',{...input,lifeId:null})).data.error,'EXPLICIT_LIFE_REQUIRED');
    assert.equal((await request('/life/prompt',input)).data.accepted,true);await bounded(agents[0].whenIdle());
    assert.equal((await request('/life/prompt',input)).data.duplicate,true);
    await host.ctx.sessions.flush(agents[0].session);await host.drainCheckpoints();
    const events=await request('/life/events?lifeId='+A.lifeId+'&sessionId='+A.authoritySessionId);
    assert.equal(events.status,200);assert.equal(events.data.events.filter(e=>e.type==='user/message'&&e.data.source?.rpcId===input.requestId).length,1);
    assert.equal((await request('/life/events?lifeId='+B.lifeId+'&sessionId='+A.authoritySessionId)).status,404);
    assert.equal((await request('/life/cancel',{lifeId:B.lifeId,sessionId:A.authoritySessionId})).status,404);
    const activity=await request('/life/activity',{lifeId:B.lifeId});assert.equal(activity.status,200);assert.equal(registry.owner(activity.data.sessionId).lifeId,B.lifeId);
    const room=host.rooms.defineRoom({participants:['human:maintainer',A.lifeId],visibility:'private'});
    const human=await request('/room/message',{conversationId:room.conversationId,body:'TEST ONLY HUMAN'});
    assert.equal(human.data.message.senderPrincipalId,'human:maintainer');assert.equal(human.data.state,'saved');
    assert.equal((await request('/room/message',{conversationId:room.conversationId,body:'spoof',senderPrincipalId:A.lifeId})).data.error,'SENDER_IS_HOST_BOUND');
    const unjoined=host.rooms.defineRoom({participants:[A.lifeId],visibility:'private'});
    assert.equal((await request('/room/message',{conversationId:unjoined.conversationId,body:'not a member'})).status,400);
    const peer=host.rooms.defineRoom({participants:[A.lifeId,B.lifeId]});
    const observerChannel=await listenLifeHost(host,{principalId:'human:maintainer',displayName:'TEST ONLY human',peerChat:{roomId:peer.room_id,lifeId:A.lifeId,displayName:'TEST ONLY peer'}});
    try {
      const denied=await fetch('http://127.0.0.1:'+observerChannel.port+'/peer-chat');
      assert.equal(denied.status,403,'a missing or revoked observer grant is contained by HTTP');
      assert.equal((await fetch('http://127.0.0.1:'+observerChannel.port+'/v1/self',{headers:{authorization:'Bearer '+observerChannel.token}})).status,200,'the Host remains available after denial');
    }finally{await observerChannel.close();}
    host.rooms.post(host.contexts.execution(agents[1]),{room_id:peer.room_id,body:'TEST ONLY private peer'});
    const publicStatus=await request('/v1/status?life_id='+A.lifeId);
    assert.equal(publicStatus.data.room_inbox_pending,1,'public count includes only this authenticated human\'s Room');
    assert.equal(publicStatus.data.room_inbox_pending_scope,'authorized-human-rooms');
    assert(!JSON.stringify(publicStatus.data).includes('TEST ONLY private peer'));
    host.activity.recordHost({lifeId:A.lifeId,sessionId:A.authoritySessionId,phase:'private'});
    assert.equal((await request('/v1/status?life_id='+A.lifeId)).data.busy,true);
    assert.equal((await request('/v1/activity?life_id='+A.lifeId)).data.phase,'private');
    host.activity.recordHost({lifeId:A.lifeId,sessionId:A.authoritySessionId,phase:'idle'});
    const stateFile=resolve(A.deployment.state,'TEST-only-state-canary.txt');await writeFile(stateFile,'TEST ONLY PRESERVE STATE');
    for(const path of [A.deployment.core,stateFile]) {
      const before=await readFile(path),start=[...agents[0].session.ownEvents()].at(-1).seq;
      adapter.plans.set(A.authoritySessionId,{file_path:path,content:'TEST ONLY FORBIDDEN OVERWRITE'});
      await request('/life/prompt',{...input,requestId:randomUUID(),text:'TEST ONLY negative native write'});await bounded(agents[0].whenIdle());
      const result=[...agents[0].session.ownEvents()].find(e=>e.seq>start&&e.type==='tool/result');
      assert(result?.data.message.isError);assert(JSON.stringify(result.data).includes('OWNER_STATE_USE_DOMAIN_API'));
      assert.deepEqual(await readFile(path),before);
    }
    const continuity=resolve(A.deployment.workspace,'memory/continuity.md');await mkdir(resolve(continuity,'..'),{recursive:true});await writeFile(continuity,'TEST ONLY PRESERVE CONTINUITY');
    const activityA=await host.runtime.create({lifeId:A.lifeId,role:'activity'});
    for(const step of [{file_path:continuity,content:'FORBIDDEN'},{name:'edit',args:{file_path:continuity,old_string:'PRESERVE',new_string:'FORBIDDEN'}}]) {
      const before=await readFile(continuity),start=[...activityA.session.ownEvents()].at(-1)?.seq??-1;
      adapter.plans.set(activityA.session.id,step);await request('/life/prompt',{lifeId:A.lifeId,sessionId:activityA.session.id,requestId:randomUUID(),text:'TEST ONLY activity continuity bypass denied'});await bounded(activityA.whenIdle());
      const result=[...activityA.session.ownEvents()].find(e=>e.seq>start&&e.type==='tool/result');assert(result?.data.message.isError);assert(JSON.stringify(result.data).includes('OWNER_STATE_USE_DOMAIN_API'));assert.deepEqual(await readFile(continuity),before);
    }
    await host.drainCheckpoints();
    const report={passed:true,observedAt:new Date().toISOString(),testCount:1,evidenceKind:'loopback-human-channel-and-native-negative-tools',
      fourFixtureOwners:true,authenticated:true,exactOwnerDenied:true,requestDedup:true,humanSenderBound:true,domainStateDirectWriteDenied:true,activityContinuityWriteAndEditDenied:true,paidModelCalls:0,formalLifeRegistrations:0};
    await writeFile(new URL('../../../../reports/multi-life-implementation-20261006/http-validation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  }finally{if(channel)await channel.close();if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}
});
