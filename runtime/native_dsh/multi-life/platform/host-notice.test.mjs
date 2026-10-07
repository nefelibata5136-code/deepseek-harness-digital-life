import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {queueHostNotice} from './host-notice.mjs';

class Stub extends LlmAdapter {
  calls=0;
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}
  async *stream(){this.calls++;const block={type:'text',text:'TEST ONLY NOTICE ACK'};yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:block.text};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:'stop'}};}
}
test('Host notice wakes native Agent once and reuses the exact persisted pending notice without human impersonation',async()=>{
  const fixture=await createFixture(['A']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),adapter=new Stub();let host;
  try {
    const [A]=fixture.manifests;registry.register(A);host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter,providerRoutes:['TEST-shared-provider']});
    const agent=await host.runtime.create({lifeId:A.lifeId,sessionId:A.authoritySessionId,role:'authority'}),binding={ready:true,life_id:A.lifeId,registered_session_id:A.authoritySessionId};
    const args={ctx:host.ctx,sessionId:A.authoritySessionId,binding,text:'TEST ONLY HOST NOTICE',requestId:randomUUID()};
    assert.equal((await queueHostNotice(args)).duplicate,false);await agent.whenIdle();
    const first=[...agent.session.ownEvents()].filter(e=>e.type==='user/message'&&e.data.source?.rpcId===args.requestId);
    assert.equal(first.length,1);assert.equal(first[0].data.source.sender.sender_type,'host');assert.equal(first[0].data.source.sender.sender_id,'host:development');assert.notEqual(first[0].data.source.kind,'user');
    assert.equal((await queueHostNotice(args)).state,'materialized');assert.equal(adapter.calls,1);
    const requestId=randomUUID(),pending=createUserMessage({content:[{type:'text',text:'TEST ONLY OLD PENDING'}],source:{kind:'host-notice',rpcId:requestId,receiverLifeId:A.lifeId}});
    agent.send(pending,'next-turn',false);await host.ctx.sessions.flush(agent.session);assert.equal(adapter.calls,1);
    assert.equal((await queueHostNotice({...args,requestId})).duplicate,true);await agent.whenIdle();
    const restored=[...agent.session.ownEvents()].filter(e=>e.type==='user/message'&&e.data.source?.rpcId===requestId);
    assert.equal(restored.length,1);assert.equal(restored[0].data.id,pending.id);assert.equal(adapter.calls,2);
  }finally{if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}
});
