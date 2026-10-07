// TEST ONLY child process. Parent supplies and owns a marked fixture directory.
import {readFileSync,appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {Conversations} from './conversations.mjs';
import {TaskStore} from './tasks.mjs';
import {WorkerGateway} from './worker-gateway.mjs';
import {mountRoomInbox} from './legacy-room-inbox.mjs';

const [root,mode,stage]=process.argv.slice(2),marker=JSON.parse(readFileSync(resolve(root,'TEST-ONLY.json'),'utf8'));
if(marker.fixture!==true||!root.includes('digital-life-TEST-ONLY-'))throw Error('TEST ONLY ROOT REQUIRED');
const manifests=JSON.parse(readFileSync(resolve(root,'crash-manifests.json'),'utf8'));
class Stub extends LlmAdapter {
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}
  async *stream(){appendFileSync(resolve(root,'provider-calls.jsonl'),JSON.stringify({pid:process.pid,at:Date.now()})+'\n');const block={type:'text',text:'TEST ONLY no decision'};yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:block.text};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}};}
}
const registry=new LifeRegistry({root:resolve(root,'registry'),mode:'fixture'});for(const manifest of manifests)if(!registry.list().some(m=>m.lifeId===manifest.lifeId))registry.register(manifest);
const host=await bootScoped({registry,root:resolve(root,'native'),fixtureRoot:root,adapter:new Stub(),providerRoutes:['TEST-shared-provider']}),B=manifests[1];
const agents=await Promise.all(manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
const tasks=new TaskStore({contexts:host.contexts,root:resolve(root,'TEST-ONLY-tasks')}),rooms=new Conversations({contexts:host.contexts,tasks,root:resolve(root,'TEST-ONLY-rooms')});
const statePath=resolve(root,'crash-state.json');let state;
if(existsSync(statePath))state=JSON.parse(readFileSync(statePath,'utf8'));else{const room=rooms.defineRoom({participants:manifests.map(m=>m.lifeId)}),message=rooms.post(host.contexts.execution(agents[0]),{room_id:room.room_id,body:'TEST ONLY durable crash probe'});state={room_id:room.room_id,message_id:message.message_id};writeFileSync(statePath,JSON.stringify(state));}
const token='TEST ONLY CRASH '+randomUUID(),gateway=new WorkerGateway({registry,rooms,tasks,workerBindings:new Map([[B.lifeId,{token,allowedPresetId:B.deployment.presetId}]])}),handle=gateway.authenticate({lifeId:B.lifeId,token});gateway.registerSession(handle,{header:agents[1].session.header,presetId:B.deployment.presetId,role:'authority'});
const bridge={status:()=>({ready:true,life_id:B.lifeId,registered_session_id:B.authoritySessionId}),async inspect(args){return {inbox:gateway.inbox(handle,args)};},
  ...Object.fromEntries(['selectDelivery','authorizeDelivery','acknowledgeDelivery','failDelivery','selectBatch','authorizeBatch','acknowledgeBatch','reconcileDelivery'].map(name=>[name,args=>gateway[name](handle,{sessionId:B.authoritySessionId,...args})]))};
const hold=async()=>{process.send?.({checkpoint:stage});await new Promise(()=>{});};
let driver;
if(mode==='prepare'&&stage==='after-message')await hold();
if(mode==='prepare'&&stage==='after-select'){const item=gateway.inbox(handle).items[0];gateway.selectBatch(handle,{sessionId:B.authoritySessionId,items:[{inbox_id:item.inbox_id,expectedRevision:item.revision}]});await hold();}
driver=await mountRoomInbox({ctx:host.ctx,bridge,lifeId:B.lifeId,authoritySessionId:B.authoritySessionId,root:resolve(root,'TEST-ONLY-policy'),intervalMs:60000,coalesceMs:0});
if(mode==='prepare'&&stage==='before-model')host.ctx.on('llm/stream',async function*(options,next){if(options.sessionId===B.authoritySessionId){await host.ctx.sessions.flush(agents[1].session);await hold();}yield* next();},{prepend:true});
if(mode==='prepare'){await driver.tick();await agents[1].whenIdle();await host.ctx.sessions.flush(agents[1].session);
  if(stage==='after-reply')rooms.post(host.contexts.execution(agents[1]),{room_id:state.room_id,reply_to:state.message_id,body:'TEST ONLY durable reply before crash'});
  await hold();}
else{await driver.tick();await agents[1].whenIdle();await host.ctx.sessions.flush(agents[1].session);await driver.tick();
  const row=gateway.inbox(handle).items[0];let beforeRetry=null;
  if(stage==='before-model') {
    beforeRetry={status:row.status,attempt_state:row.attempt.state,retryable:row.attempt.retryable,
      no_effect_dispatch_proven:row.attempt.native_evidence.no_effect_dispatch_proven,
      calls:existsSync(resolve(root,'provider-calls.jsonl'))?readFileSync(resolve(root,'provider-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).length:0};
  }
  if(['failed','interrupted'].includes(row?.attempt?.state)&&row.attempt.retryable){await new Promise(r=>setTimeout(r,1100));await driver.tick();await agents[1].whenIdle();await host.ctx.sessions.flush(agents[1].session);await driver.tick();}
  const calls=existsSync(resolve(root,'provider-calls.jsonl'))?readFileSync(resolve(root,'provider-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).length:0;
  const original=gateway.inbox(handle,{includeTerminal:true}).items.find(item=>item.message_id===state.message_id),replyCount=rooms.readForPrincipal(B.lifeId,{room_id:state.room_id}).messages.filter(message=>message.reply_to===state.message_id).length;
  process.send?.({recovered:true,stage,status:original?.status,attempt_state:original?.attempt?.state,calls,reply_count:replyCount,before_retry:beforeRetry});driver.dispose();await driver.drain();await host.ctx.fiber.dispose();rooms.close?.();rooms.recentEvents.store.close();registry.close();process.disconnect?.();}
