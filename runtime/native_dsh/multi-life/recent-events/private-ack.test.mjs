import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {mountPrivateServices} from '../private-services/index.mjs';
import * as legacyVault from '../../private-vault/capability.mjs';
import {PrivateVaultStore} from '../../private-vault/store.mjs';
import {isPrivateCompletionAck,PLACEHOLDER} from '../../private-vault/session-privacy.mjs';
import {mountRecentEventsWorker} from './worker.mjs';
import {findTurnActionResult} from './action-result.mjs';

const silent={status:'ok',disposition:'silent',actions:[]};
async function journalFiles(root) {
  const result=[];for(const entry of await readdir(root,{withFileTypes:true})){const path=resolve(root,entry.name);if(entry.isDirectory())result.push(...await journalFiles(path));else result.push(path);}return result;
}
const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST_ONLY_PRIVATE_ACK_DEADLINE')),20000);})]);}finally{clearTimeout(timer);}};

test('private completion ACK allows only the exact empty-action protocol and no hidden body fields',()=>{
  for(const disposition of ['acted','silent','deferred'])assert.equal(isPrivateCompletionAck({status:'ok',disposition,actions:[]}),true);
  assert.equal(isPrivateCompletionAck(Object.defineProperty({...silent},'body_override',{value:'TEST ONLY PRIVATE'})),false);
  assert.equal(isPrivateCompletionAck({...silent,[Symbol('hidden')]:'TEST ONLY PRIVATE'}),false);
  assert.equal(isPrivateCompletionAck({...silent,actions:Object.defineProperty([],'hidden',{value:'TEST ONLY PRIVATE'})}),false);
  for(const value of [null,{}, {...silent,body_override:'TEST ONLY PRIVATE'}, {status:'failed',disposition:'silent',actions:[]}, {...silent,actions:[{type:'send_message',conversation_id:'room',body:'TEST ONLY PRIVATE'}]}, {status:'ok',disposition:'silent'}, {...silent,actions:Object.assign([],{hidden:'TEST ONLY PRIVATE'})}, '{"status":"failed","status":"ok","disposition":"silent","actions":[]}'])assert.equal(isPrivateCompletionAck(value),false);
});

for(const mode of ['owner-services','legacy-capability'])test(`real native Loader ${mode}: private read then terminal ACK completes, persists no secrets, and blocks private-content ACK actions`,async()=>{
  const f=await createFixture(['PRIVATE ACK']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});let host,worker;
  const manifest=f.manifests[0],secret='TEST_ONLY_PRIVATE_VALUE_'+randomUUID(),privatePath='TEST_ONLY_PRIVATE_PATH_'+randomUUID(),receipts=[],requests=[];let scenario='silent',step=0,delegateAckExecuted=0,coldRecovery=false,lastCompletedTurn;
  class Stub extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}
    async *stream(options) {
      requests.push({scenario,step:++step,hasPrivate:JSON.stringify(options.messages).includes(secret)});let name,args;
      if(step===1){name='private_read';args={path:privatePath};}
      else if(step===2&&scenario!=='silent'){name='life_turn_ack';args=scenario==='send'?{status:'ok',disposition:'acted',actions:[{type:'send_message',conversation_id:'TEST_ONLY_ROOM',body:secret}]}:{...silent,body_override:secret};}
      else{name='life_turn_ack';args=silent;assert(requests.at(-1).hasPrivate,'the live next step can still consume the volatile private result');}
      const block={type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)};
      yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:'tool-calls'}};
    }
  }
  const bootOptions={registry,root:f.nativeRoot,fixtureRoot:f.root,adapter:new Stub(),providerRoutes:[manifest.deployment.provider],extensions:[async current=>{
    if(mode==='owner-services')mountPrivateServices({ctx:current.ctx,contexts:current.contexts});
    else await current.ctx.plugin(legacyVault,{root:manifest.deployment.vault,fullAccess:false}).await();
  }]};
  try {
    registry.register(manifest);const store=await new PrivateVaultStore(manifest.deployment.vault).init();await store.write({path:privatePath,value:secret});
    host=await bootScoped(bootOptions);
    // A global fixture fallback lets the delegate guard be exercised even though
    // the real owner's terminal tool remains scoped to its exact Agent.
    host.ctx.tools.register(defineTool({name:'life_turn_ack',description:'TEST ONLY delegate fallback',parameters:{status:{type:'string'},disposition:{type:'string'},actions:{type:'array',items:{type:'object',additionalProperties:true}}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(){delegateAckExecuted++;return {acknowledged:true,result:silent,delivery_batch_id:'batch-'+randomUUID()};}}));
    let agent=await host.runtime.create({lifeId:manifest.lifeId,sessionId:manifest.authoritySessionId,role:'authority'});const batches=new Map();
    const rpc=async(operation,{recent:input})=>{
      assert.equal(operation,'timeline');receipts.push(structuredClone(input));
      if(input.operation==='inspect')return {life_id:manifest.lifeId,events:[],state:{batches:Object.fromEntries(batches),batch_status:Object.fromEntries([...batches].map(([id])=>[id,{turn_status:coldRecovery?'dispatched':'ok'}]))}};
      if(input.operation==='prepare'){const batch={batch_id:'batch-'+randomUUID(),life_id:manifest.lifeId,authority_session_id:agent.session.id,wake_id:input.wake_id,delivered_at_utc:new Date().toISOString(),event_ids:[],events:[],snapshot_cutoff_seq:0};batches.set(batch.batch_id,batch);return {batch,events:[],char_budget:20000};}
      if(input.operation==='ack')return {acknowledged:true,result:input.result,delivery_batch_id:input.batch_id};return {saved:true};
    };
    worker=mountRecentEventsWorker({ctx:host.ctx,agent,lifeId:manifest.lifeId,sessionId:agent.session.id,role:'authority',verify:actual=>host.contexts.forAgent(actual),rpc});
    for(const current of ['silent','send','unknown-field']) {
      scenario=current;step=0;await host.runtime.prompt({lifeId:manifest.lifeId,sessionId:agent.session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY isolated private terminal protocol'}]});await bounded(agent.whenIdle());await worker.drain();await host.ctx.sessions.flush(agent.session);
      const events=[...agent.session.ownEvents()],end=events.findLast(event=>event.type==='turn/end'),turn=end.data.turn;lastCompletedTurn=turn;assert.equal(end.data.reason.kind,'completed');const found=findTurnActionResult(events,{turn,endSeq:end.seq});assert.equal(found?.machine_ack,true);assert.deepEqual(found.result,silent);assert(!JSON.stringify(events).includes(secret));assert(!JSON.stringify(events).includes(privatePath));
      const calls=events.filter(event=>event.type==='tool/call'&&event.data.turn===turn&&event.data.name==='life_turn_ack');assert.equal(calls.length,current==='silent'?1:2);assert.deepEqual(JSON.parse(calls.at(-1).data.arguments),silent);if(current!=='silent')assert.equal(calls[0].data.arguments,'{}','public-action and unknown-field ACK attempts remain sanitized');
      assert.equal(receipts.filter(input=>input.operation==='ack'&&input.turn===turn).length,1);assert(receipts.filter(input=>input.operation==='ack').every(input=>input.result.actions.length===0));
      const observation=await host.ctx.sessionQuery.observeSession(agent.session.id,{projectionMode:'all'});try{const cold=[...observation.events];assert(!JSON.stringify(cold).includes(secret));assert(!JSON.stringify(cold).includes(privatePath));assert.deepEqual(findTurnActionResult(cold,{turn,endSeq:end.seq}).result,silent);}finally{observation[Symbol.dispose]();}
    }
    const delegate=await host.runtime.create({lifeId:manifest.lifeId,sessionId:randomUUID(),role:'delegate',parentSessionId:agent.session.id});delegate.session.append('turn/start',{turn:1});delegate.session.append('tool/call',{turn:1,step:1,callId:randomUUID(),name:'private_read',arguments:JSON.stringify({path:privatePath})});
    const denial=await host.ctx.tools.execute({agent:delegate,callId:randomUUID(),name:'life_turn_ack',arguments:silent,signal:new AbortController().signal});assert.equal(delegateAckExecuted,0);assert.equal(denial.isError,true,'the private ACK exemption is not inherited by delegates');delegate.session.append('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(worker.status().completed,3);assert.equal(worker.status().failed,0);
    // Remove the live kernel, then read the persisted Session without any live
    // Session fallback and reconcile its exact safe receipts with a fresh worker.
    worker.dispose();worker=undefined;await host.ctx.fiber.dispose();host=undefined;
    host=await bootScoped(bootOptions);assert.equal(host.ctx.sessions.get(manifest.authoritySessionId),undefined);
    const persisted=await host.ctx.sessionQuery.observeSession(manifest.authoritySessionId,{projectionMode:'all'});try{
      const events=[...persisted.events];assert(!JSON.stringify(events).includes(secret));assert(!JSON.stringify(events).includes(privatePath));assert.deepEqual(findTurnActionResult(events,{turn:lastCompletedTurn}).result,silent);
    }finally{persisted[Symbol.dispose]();}
    agent=await host.runtime.resolve({lifeId:manifest.lifeId,sessionId:manifest.authoritySessionId});coldRecovery=true;
    worker=mountRecentEventsWorker({ctx:host.ctx,agent,lifeId:manifest.lifeId,sessionId:agent.session.id,role:'authority',verify:actual=>host.contexts.forAgent(actual),rpc});await worker.drain();
    assert.equal(worker.status().recovered,3);assert.equal(worker.status().completed,3);assert.equal(worker.status().failed,0);assert.equal(worker.status().error_code,null);assert.equal(receipts.filter(input=>input.operation==='ack').length,3,'cold recovery verifies persisted receipts without executing tools again');
    // The safe call alone is insufficient: an unsafe/mismatched result wrapper
    // is still redacted, while the exact wrapper remains verifiable.
    const turn=99,callId=randomUUID();agent.session.append('turn/start',{turn});agent.session.append('tool/call',{turn,step:1,callId:randomUUID(),name:'private_read',arguments:JSON.stringify({path:privatePath})});const call=agent.session.append('tool/call',{turn,step:2,callId,name:'life_turn_ack',arguments:JSON.stringify(silent)});
    const result=wrapper=>({turn,step:2,message:{id:randomUUID(),role:'tool',source:{kind:'tool',callId},toolCallId:callId,isError:false,content:[{type:'text',text:JSON.stringify(wrapper)}]}}),id='batch-'+randomUUID();
    const unsafe=agent.session.append('tool/result',result({acknowledged:true,result:silent,delivery_batch_id:id,body_override:secret}),{surfaceOp:'append',sourceEventSeqs:[call.seq]});assert.equal(unsafe.data.message.content[0].text,PLACEHOLDER);
    const mismatch=agent.session.append('tool/result',result({acknowledged:true,result:{status:'ok',disposition:'acted',actions:[]},delivery_batch_id:id}),{surfaceOp:'append',sourceEventSeqs:[call.seq]});assert.equal(mismatch.data.message.content[0].text,PLACEHOLDER);
    const safe=agent.session.append('tool/result',result({acknowledged:true,result:silent,delivery_batch_id:id}),{surfaceOp:'append',sourceEventSeqs:[call.seq]});assert.equal(JSON.parse(safe.data.message.content[0].text).delivery_batch_id,id);agent.session.append('turn/end',{turn,reason:{kind:'completed'}});await host.ctx.sessions.flush(agent.session);
    for(const path of await journalFiles(resolve(f.nativeRoot,'sessions'))){const bytes=await readFile(path);assert(!bytes.includes(Buffer.from(secret)));assert(!bytes.includes(Buffer.from(privatePath)));}
  }finally{await worker?.drain();worker?.dispose();await host?.ctx.fiber.dispose();registry.close();await f.cleanup();}
});
