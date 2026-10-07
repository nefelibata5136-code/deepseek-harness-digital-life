import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createFixture} from './fixture.mjs';
import {LifeRegistry} from './registry.mjs';
import {bootLifeHost} from './host.mjs';
import {BudgetAuthority,createNativeBudgetSeam,mountBudgetStatus} from './budget/index.mjs';

const fixture=await createFixture(['A','B','C','D']);
for(const m of fixture.manifests){m.deployment.provider='deepseek-official';m.deployment.model='deepseek-flash';}
let registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),host;
const checks={},requestReceipts=[],plans=new Map(),memoryBindings=new Map(),ownerBindings=new Map();
let budget,budgetTransport;
const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('TEST ONLY integration deadline')),30000);timer.unref();})]);
const sse=()=>new Response([
  {type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:12,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
  {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
  {type:'message_stop'},
].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
class Stub extends LlmAdapter {
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:1000000},defaultMaxTokens:256};}
  async *stream(options) {
    const c=host.contexts.execution(host.ctx.agents.get(options.sessionId)),label=c.manifest.displayName.slice(10);
    const system=JSON.stringify(options.messages.filter(m=>m.role==='system'));
    if(c.role==='delegate'){assert(system.includes('Temporary engineering collaborator'));assert(!system.includes('TEST ONLY CORE'));}
    else assert(system.includes('TEST ONLY CORE '+label));
    requestReceipts.push({lifeId:c.lifeId,sessionId:c.sessionId,runId:c.runId,category:c.costCategory});
    // Real Messages wire gate and official audited prices; entirely local SSE.
    const response=await budgetTransport('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',
      body:JSON.stringify({model:'deepseek-flash',max_tokens:256,stream:true,messages:[{role:'user',content:[{type:'text',text:'TEST ONLY metered synthetic native attempt'}]}]})});
    assert.equal(response.status,200);await response.text();
    const plan=plans.get(options.sessionId),step=plan?.steps[plan.index++];
    const block=step?{type:'tool-call',id:randomUUID(),name:step.name,arguments:JSON.stringify(step.args)}:{type:'text',text:'TEST ONLY completed '+label};
    yield {type:'block-start',index:0,blockType:block.type};
    if(step)yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};
    else yield {type:'text-delta',index:0,text:block.text};
    yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:12,outputTokens:2}};
    yield {type:'finish',reason:{kind:step?'tool-calls':'stop'}};
  }
}
const adapter=new Stub();
async function launch(){
  host=await bootLifeHost({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,providerRoutes:['deepseek-official'],
    memoryBindings,ownerBindings,admit:async()=>({allowed:true}),rawModelTransport:async()=>sse(),
    budgetConfig:{accounts:new Map([['TEST-shared-account',{dailyLimitNanoCny:210000000000}]]),
      lifeAccounts:new Map(registry.list().map(m=>[m.lifeId,{accountRef:'TEST-shared-account'}])),fixtureNow:'2026-10-06T15:00:00+08:00'},
    providerFactory:({transport})=>{budgetTransport=transport;return adapter;}});budget=host.budget;
}
async function execute(agent,steps,text='TEST ONLY integrated tool flow') {
  const start=([...agent.session.ownEvents()].at(-1)?.seq??-1)+1;plans.set(agent.session.id,{steps,index:0});
  const c=host.contexts.execution(agent),requestId=randomUUID();
  await host.runtime.prompt({lifeId:c.lifeId,sessionId:c.sessionId,requestId,content:[{type:'text',text}]});
  await bounded(agent.whenIdle());await host.ctx.sessions.flush(agent.session);await host.drainCheckpoints();plans.delete(c.sessionId);
  const events=[...agent.session.ownEvents()].filter(e=>e.seq>=start);
  for(const step of steps) {
    const call=events.find(e=>e.type==='tool/call'&&e.data.name===step.name);assert(call,'missing actual native call '+step.name+': '+JSON.stringify(events.map(e=>({type:e.type,reason:e.data.reason,failure:e.data.failure,error:e.data.error}))));
    const result=events.find(e=>e.type==='tool/result'&&e.sourceEventSeqs?.includes(call.seq));
    assert(result&&!result.data.message.isError,'native execution failed '+step.name+': '+JSON.stringify(result?.data));
    if(!step.name.startsWith('private_'))assert(!JSON.stringify(result.data).includes('"ok":false'),'domain operation failed '+step.name+': '+JSON.stringify(result.data));
  }
  assert(events.some(e=>e.type==='turn/end'&&e.data.reason?.kind==='completed'),'native turn did not complete');return events;
}
try {
  for(const m of fixture.manifests) {
    registry.register(m);const raw=resolve(m.deployment.memory,'TEST-ONLY-original.jsonl');
    await writeFile(raw,JSON.stringify({id:'same-record',conversation_id:'same-conversation',role:'assistant',content:m.displayName+' PRIVATE MEMORY CANARY',created_at:null})+'\n');
    memoryBindings.set(m.lifeId,{sources:[{namespace:'same-namespace',path:raw}],syntheticProvider:true,
      config:{workspace_id:'TEST-workspace',embedding_model:'TEST-embedding',rerank_model:'TEST-rerank',dimension:3}});
    ownerBindings.set(m.lifeId,{accounts:{provider:{accountRef:'TEST-shared-account',kind:'provider',shared:true},social:{accountRef:'TEST-own-social-'+m.lifeId,kind:'identity'}},
      browsers:{default:{bindingRef:'TEST-own-browser-'+m.lifeId,profileRoot:resolve(m.deployment.state,'TEST-browser-profile')}},credentials:{}});
  }
  await launch();let agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
  await Promise.all(agents.map((agent,i)=>execute(agent,[{name:'life_mental_write',args:{text:'TEST ONLY MENTAL '+['A','B','C','D'][i]}}])));checks.nativeFourLifeStateComposition=true;
  for(const [i,m] of fixture.manifests.entries()) {
    const c=host.contexts.execution(agents[i]),page=await host.privateServices.memory.execute(c,'pending'),item=page.result.messages.find(x=>x.namespace==='same-namespace');assert(item);
    const ref={mid:item.mid,namespace:item.namespace,conversation_id:item.conversation,record_id:item.record_id,revision_hash:item.source_ref.revision_hash,content_hash:item.source_ref.content_hash};
    const event={alias:'TEST SAME',name:m.displayName+' CANARY',one_line:m.displayName+' own meaning',time:{},meaning:{now:m.displayName+' independently authored'},source_refs:[ref],side_refs:[],
      units:[{key:'same-entrance',title:m.displayName+' CANARY',my_phrases:[m.displayName+' own words'],terms:['TEST ONLY'],refs:[ref]}]};
    plans.set(m.authoritySessionId,{steps:[{name:'memory_propose',args:{event_json:JSON.stringify(event),event_id:'evt_same'}},
      {name:'memory_accept',args:{event_id:'evt_same',expected_revision:1}},{name:'memory_search',args:{query:'TEST ONLY'}}],index:0});
  }
  await Promise.all(agents.map(agent=>execute(agent,plans.get(agent.session.id).steps,'TEST ONLY author and accept own memory')));
  for(const [i,m] of fixture.manifests.entries()) {
    const c=host.contexts.execution(agents[i]),catalog=await host.privateServices.memory.execute(c,'catalog');assert.equal(catalog.result.total,1);
    const summary=await host.privateServices.memory.execute(c,'open',{view:'summary',event_id:'evt_same'});assert.equal(JSON.parse(summary.result.text).summary_author,m.lifeId);
    const sources=await createSourcesCheck(m,agents[i]);assert(sources.recordCount>0);assert.equal(sources.evidenceKind,'derived-public-native-snapshot');
    const exported=await readFile(resolve(m.deployment.workspace,'memory/retrieval/journal-export.json'),'utf8');assert(exported.includes(m.lifeId));
    for(const other of fixture.manifests.filter(o=>o.lifeId!==m.lifeId))assert(!JSON.stringify(catalog).includes(other.displayName));
  }
  checks.nativeMemoryCallsReceiptsAndExports=true;checks.publicNativeEvidenceSnapshot=true;
  await Promise.all(agents.map((agent,i)=>execute(agent,[{name:'private_write',args:{path:'same-name',value:'TEST ONLY VAULT SECRET '+['A','B','C','D'][i]}},
    {name:'private_read',args:{path:'same-name'}}],'TEST ONLY private Vault turn')));
  for(const [i,agent] of agents.entries()){
    const actual=await host.privateServices.vault.execute(host.contexts.execution(agent),'read',{path:'same-name'});assert.equal(actual.document.value,'TEST ONLY VAULT SECRET '+['A','B','C','D'][i]);
    assert(!JSON.stringify([...agent.session.ownEvents()]).includes('TEST ONLY VAULT SECRET'));}
  checks.nativeVaultPrivateTurnsNoJournalSecret=true;
  host.rooms.registerHuman({sender_id:'human:maintainer',display_name:'TEST ONLY human'});
  const [A,B,C]=agents.map(a=>host.contexts.execution(a)),room=host.rooms.defineRoom({participants:['human:maintainer',A.lifeId,B.lifeId],visibility:'shared'});
  const sent=host.rooms.post(A,{conversationId:room.conversationId,body:'TEST ONLY peer invitation; no reply obligation'});
  const receipt=await host.rooms.deliverToLife({conversationId:room.conversationId,messageId:sent.messageId,lifeId:B.lifeId,runtime:host.runtime});
  assert.equal(receipt.status,'queued');host.rooms.decide(B,{inbox_id:receipt.inbox_id,expectedRevision:receipt.revision,action:'process'});
  const delivered=await host.processInbox({lifeId:B.lifeId,inbox_id:receipt.inbox_id});assert(delivered.accepted);
  const receiving=await host.runtime.resolve({lifeId:B.lifeId,sessionId:delivered.sessionId});await bounded(receiving.whenIdle());
  await execute(receiving,[{name:'life_room_post',args:{conversationId:room.conversationId,replyTo:sent.messageId,body:'TEST ONLY actual native reply from B'}}]);
  const replies=host.rooms.read(A,{conversationId:room.conversationId}).messages;assert.equal(replies[1].senderPrincipalId,B.lifeId);assert.equal(replies[1].originSessionId,receiving.session.id);
  assert.throws(()=>host.rooms.read(C,{conversationId:room.conversationId}),/CONVERSATION_NOT_VISIBLE/);checks.nativeRoomActivityCanReply=true;
  const child=await host.runtime.delegate(A,{task:'TEST ONLY return an engineering suggestion'});await bounded(child.agent.whenIdle());
  assert.throws(()=>host.rooms.post(host.contexts.execution(child.agent),{conversationId:room.conversationId,body:'forged'}),/DELEGATE_SOCIAL_SEND_DENIED/);checks.engineeringDelegateHasNoLifeIdentity=true;
  const fs=host.ctx.agentPresets.serviceFor(agents[0],'fs');
  for(const path of [resolve(fixture.nativeRoot,'schedule-storage','tasks.json'),resolve(fixture.nativeRoot,'platform/conversations/rooms.json'),resolve(fixture.manifests[0].deployment.memory,'.native-source-snapshots')])
    await assert.rejects(fs.resolve(path),/TRUSTED_CONTROL_RESOURCE/);checks.sharedControlFilesGuarded=true;
  await Promise.all(agents.map(agent=>execute(agent,[{name:'budget_status',args:{}}])));
  const account=await budget.inspectAccount('TEST-shared-account');assert(account.by_life);assert.equal(Object.values(account.by_life).reduce((sum,x)=>sum+x.settled,0),account.account.settled);
  assert(Object.values(account.by_life).every(x=>x.settled>0));assert(requestReceipts.some(x=>x.category==='subagent'));assert(requestReceipts.some(x=>x.category==='peer_room'));checks.nativeBudgetAttemptAttribution=true;
  await host.drainCheckpoints();await host.ctx.fiber.dispose();host=null;registry.close();registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  await launch();agents=await Promise.all(fixture.manifests.map(m=>host.runtime.resolve({lifeId:m.lifeId,sessionId:m.authoritySessionId})));
  for(const [i,m] of fixture.manifests.entries()) {
    assert.equal((await host.life.readMental(host.contexts.execution(agents[i]))).mental.text,'TEST ONLY MENTAL '+['A','B','C','D'][i]);
    assert.equal((await host.privateServices.vault.execute(host.contexts.execution(agents[i]),'read',{path:'same-name'})).document.value,'TEST ONLY VAULT SECRET '+['A','B','C','D'][i]);
  }
  assert.equal(host.rooms.read(host.contexts.execution(agents[0]),{conversationId:room.conversationId}).messages.length,2);checks.composedColdReopen=true;
  await host.ctx.fiber.dispose();host=null;registry.close();registry=null;await fixture.cleanup();
  const report={passed:true,observedAt:new Date().toISOString(),checks,checksPassed:Object.keys(checks).length,nativeModelAttempts:requestReceipts.length,
    paidModelCalls:0,productionWrites:0,formalLifeRegistrations:0,fixtureCleaned:true,evidenceKind:'local-native-composition-and-synthetic-wire'};
  await writeFile(new URL('../../../reports/multi-life-implementation-20261006/integration-validation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(host)await host.ctx.fiber.dispose();registry?.close();await fixture.cleanup();}
async function createSourcesCheck(m,agent){await host.ctx.sessions.flush(agent.session);return JSON.parse(await readFile(resolve(m.deployment.memory,'.native-source-snapshots',m.authoritySessionId+'.v4.jsonl.source.json'),'utf8'));}
