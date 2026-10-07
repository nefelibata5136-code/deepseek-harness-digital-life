import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {LifeContexts} from '../context.mjs';
import {canonical} from '../contracts.mjs';
import {createPrivateServices} from './index.mjs';
import {productionMemorySelf} from '../production-host.mjs';

async function setup(labels=['A','B'],serviceOptions={}) {
  const f=await createFixture(labels),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'}),contexts=new LifeContexts(registry);
  const agents=new Map(),paths=new Map(),memoryBindings=new Map(),ownerBindings=new Map();
  for(const m of f.manifests) {
    registry.register(m);
    const header={type:'session',version:4,id:m.authoritySessionId,cwd:m.deployment.workspace,
      agentPreset:m.deployment.presetId,createdAt:1,delegationDepth:0};
    registry.reserve({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'});registry.complete(header.id,header);
    const agent={session:{id:header.id,header}};contexts.bind(agent);agents.set(m.lifeId,agent);
    const path=resolve(f.nativeRoot,m.authoritySessionId,'session.v4.jsonl');await mkdir(resolve(f.nativeRoot,m.authoritySessionId),{recursive:true});
    await writeFile(path,JSON.stringify(header)+'\n');paths.set(header.id,path);
    const raw=resolve(m.deployment.memory,'TEST-ONLY-raw.jsonl');
    await writeFile(raw,JSON.stringify({id:'same-record',conversation_id:'same-conversation',role:'assistant',content:m.displayName+' PRIVATE MEMORY CANARY',created_at:null})+'\n');
    memoryBindings.set(m.lifeId,{sources:[{namespace:'same-namespace',path:raw}],
      config:{workspace_id:'TEST-provider-workspace',embedding_model:'TEST-model',rerank_model:'TEST-rerank',dimension:3,fixture_delay_ms:300},syntheticProvider:true});
    ownerBindings.set(m.lifeId,{accounts:{qwen:{accountRef:'TEST-shared-provider-account',kind:'provider',shared:true},social:{accountRef:'TEST-identity-'+m.lifeId,kind:'identity'}},
      credentials:{memory:{QWEN:{hostRef:'TEST-Host-Reference-'+m.lifeId,accountName:'qwen'}}},
      browsers:{default:{bindingRef:'TEST-browser-'+m.lifeId,profileRoot:resolve(m.deployment.state,'TEST-browser-profile')}}});
  }
  const nativeSources=async c=>registry.sessions(c.lifeId).filter(row=>paths.has(row.sessionId)).map(row=>({sessionId:row.sessionId,path:paths.get(row.sessionId)}));
  const services=createPrivateServices({contexts,memoryBindings,ownerBindings,nativeSources,...serviceOptions});
  const execution=(m,extra={})=>contexts.execution(agents.get(m.lifeId),extra);
  let seq=0;
  async function mutate(m,operation,args,{agent=agents.get(m.lifeId),receiptArgs=args,expectedReceiptArgs=args,receiptName='memory_'+operation}={}) {
    const callId=randomUUID(),context=contexts.execution(agent,{callId,costCategory:'memory'});
    await appendFile(paths.get(agent.session.id),JSON.stringify({type:'tool/call',seq:++seq,time:Date.now(),data:{callId,name:receiptName,arguments:JSON.stringify(receiptArgs)}})+'\n');
    return services.memory.execute(context,operation,args,{receiptArguments:expectedReceiptArgs});
  }
  async function propose(m,options={}) {
    const page=await services.memory.execute(execution(m),'pending');assert.equal(page.ok,true);
    const item=page.result.messages.find(x=>x.namespace==='same-namespace');
    const ref={mid:item.mid,namespace:item.namespace,conversation_id:item.conversation,record_id:item.record_id,
      revision_hash:item.source_ref.revision_hash,content_hash:item.source_ref.content_hash};
    const event={alias:'TEST SAME ALIAS',name:m.displayName+' CANARY',one_line:m.displayName+' own meaning',time:{},
      meaning:{now:m.displayName+' independently authored'},source_refs:[ref],side_refs:[],
      units:[{key:'same-entrance',title:m.displayName+' CANARY',my_phrases:[m.displayName+' my words'],terms:['TEST ONLY'],refs:[ref]}]};
    return mutate(m,'propose',{event,event_id:'evt_same'},options);
  }
  async function accepted(m) {const result=await propose(m);assert.equal(result.ok,true);const decision=await mutate(m,'accept',{event_id:'evt_same',expected_revision:1});assert.equal(decision.ok,true);}
  async function otherAgent(m,role) {
    const id=randomUUID(),header={type:'session',version:4,id,cwd:m.deployment.workspace,agentPreset:m.deployment.presetId,createdAt:1,delegationDepth:role==='delegate'?1:0,
      ...(role==='delegate'?{parentSession:m.authoritySessionId,origin:'subagent'}:{})};
    registry.reserve({lifeId:m.lifeId,sessionId:id,role,parentSessionId:role==='delegate'?m.authoritySessionId:null});registry.complete(id,header);
    const agent={session:{id,header}};contexts.bind(agent);
    const path=resolve(f.nativeRoot,id,'session.v4.jsonl');await mkdir(resolve(f.nativeRoot,id),{recursive:true});await writeFile(path,JSON.stringify(header)+'\n');paths.set(id,path);return agent;
  }
  return {f,registry,contexts,services,execution,mutate,propose,accepted,otherAgent,memoryBindings,ownerBindings,nativeSources,paths,agents,
    async cleanup(){await services.dispose();registry.close();await f.cleanup();}};
}

test('four synthetic lives reuse Memory and Vault without mixing identical identifiers or exports',async()=>{
  const s=await setup(['A','B','C','D']);
  try {
    await Promise.all(s.f.manifests.map(m=>s.accepted(m)));
    await Promise.all(s.f.manifests.map(m=>s.services.vault.execute(s.execution(m),'write',{namespace:'same-namespace',path:'same-path',value:m.displayName+' VAULT CANARY'})));
    for(const m of s.f.manifests) {
      const context=s.execution(m),catalog=await s.services.memory.execute(context,'catalog');assert.equal(catalog.result.total,1);
      const original=await s.services.memory.execute(context,'open',{view:'message',namespace:'same-namespace',conversation:'same-conversation',record_id:'same-record'});
      assert.equal(original.ok,true);assert.ok(original.result.text.includes(m.displayName+' PRIVATE MEMORY CANARY'));
      const search=await s.services.memory.execute(context,'search',{query:'TEST ONLY'});assert.equal(search.ok,true);assert.equal(search.result.results.length,1);
      const before=await s.services.memory.execute(context,'status');await s.services.memory.execute(context,'search',{query:'TEST ONLY'});
      const after=await s.services.memory.execute(context,'status');assert.equal(after.result.api_requests,before.result.api_requests);
      const summary=await s.services.memory.execute(context,'open',{view:'summary',event_id:'evt_same'});
      assert.equal(JSON.parse(summary.result.text).summary_author,m.lifeId);
      const exported=JSON.parse(await readFile(resolve(m.deployment.workspace,'memory/retrieval/journal-export.json'),'utf8'));
      assert.equal(exported.life_id,m.lifeId);assert.ok(exported.entries.every(e=>e.actor.life_id===m.lifeId&&e.actor.kind==='life_self'));
      const vault=await s.services.vault.execute(context,'read',{namespace:'same-namespace',path:'same-path'});assert.equal(vault.document.value,m.displayName+' VAULT CANARY');
      const list=await s.services.vault.execute(context,'list');assert.equal(list.records.length,1);
      const hits=await s.services.vault.execute(context,'search',{query:'VAULT CANARY'});assert.equal(hits.records.length,1);
      for(const other of s.f.manifests.filter(o=>o.lifeId!==m.lifeId)) {
        assert.ok(!JSON.stringify([catalog,original,search,summary,exported,vault,list,hits]).includes(other.displayName));
      }
    }
  }finally{await s.cleanup();}
});

test('production self-author policy grants every independent authority its own Memory acceptance',async()=>{
  const s=await setup(['A','B'],{actorPolicy:productionMemorySelf});try{
    await Promise.all(s.f.manifests.map(m=>s.accepted(m)));
    for(const m of s.f.manifests){const page=await s.services.memory.execute(s.execution(m),'catalog');assert.equal(page.ok,true);assert.equal(page.result.events[0].status,'accepted');}
    const B=s.f.manifests[1],delegate=await s.otherAgent(B,'delegate');
    assert.equal(productionMemorySelf(s.contexts.execution(delegate)),false);
    assert.equal(productionMemorySelf(s.execution(B)),true);
  }finally{await s.cleanup();}
});

test('different owners hold overlapping Memory provider work; source changes quarantine only their own event',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.f.manifests;await Promise.all([s.accepted(A),s.accepted(B)]);
    const results=await Promise.all([s.services.memory.execute(s.execution(A),'search',{query:'parallel'}),s.services.memory.execute(s.execution(B),'search',{query:'parallel'})]);
    assert.ok(results.every(r=>r.ok));
    const audits=await Promise.all([A,B].map(async m=>(await readFile(resolve(m.deployment.memory,'api-requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)));
    const intervals=audits.map(rows=>rows.find(r=>r.operation==='embedding'));
    assert.ok(Date.parse(intervals[0].started_at)<Date.parse(intervals[1].finished_at)&&Date.parse(intervals[1].started_at)<Date.parse(intervals[0].finished_at),'independent stores overlapped, rather than a global capability queue');
    assert.equal(audits[0][0].life_id,A.lifeId);assert.equal(audits[1][0].life_id,B.lifeId);
    await writeFile(s.memoryBindings.get(A.lifeId).sources[0].path,JSON.stringify({id:'same-record',conversation_id:'same-conversation',role:'assistant',content:'TEST ONLY A edited original',created_at:null})+'\n');
    const a=await s.services.memory.execute(s.execution(A),'search',{query:'parallel'}),b=await s.services.memory.execute(s.execution(B),'search',{query:'parallel'});
    assert.equal(a.result.results.length,0);assert.equal(b.result.results.length,1);
    const stale=await s.mutate(B,'annotate',{event_id:'evt_same',fields:{note:'TEST stale'},expected_revision:1});assert.equal(stale.error,'MEMORY_STALE_REVISION');
  }finally{await s.cleanup();}
});

test('untrusted contexts, selectors, false receipt identity and cross-owner sources fail closed',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.f.manifests,c=s.execution(A);
    await assert.rejects(s.services.memory.execute({...c},'status'),/TRUSTED_EXECUTION_CONTEXT_REQUIRED/);
    await assert.rejects(s.services.memory.execute(c,'status',{lifeId:B.lifeId}),/MEMORY_ARGUMENT_SCOPE_INVALID/);
    await assert.rejects(s.services.vault.execute(c,'read',{path:'same',root:B.deployment.vault}),/VAULT_ARGUMENT_SCOPE_INVALID/);
    const forged=s.contexts.execution(s.agents.get(A.lifeId),{callId:'TEST invented receipt'});
    const missing=await s.services.memory.execute(forged,'propose',{event:{},event_id:'unused'});assert.equal(missing.error,'MEMORY_NATIVE_RECEIPT_MISSING_OR_AMBIGUOUS');
    const wrong=await s.propose(A,{receiptName:'memory_accept'});assert.equal(wrong.error,'MEMORY_RECEIPT_OPERATION_MISMATCH');
    const changed=await s.propose(A,{receiptArgs:{event:{},event_id:'evt_same'}});assert.equal(changed.error,'MEMORY_RECEIPT_ARGUMENTS_MISMATCH');
    const services=createPrivateServices({contexts:s.contexts,memoryBindings:s.memoryBindings,nativeSources:async()=>[{sessionId:B.authoritySessionId,path:s.paths.get(B.authoritySessionId)}]});
    try{await assert.rejects(services.memory.execute(c,'status'),/SESSION_OWNER_MISMATCH/);}finally{await services.dispose();}
    const badBindings=new Map(s.memoryBindings);badBindings.set(A.lifeId,{...badBindings.get(A.lifeId),sources:s.memoryBindings.get(B.lifeId).sources});
    const bad=createPrivateServices({contexts:s.contexts,memoryBindings:badBindings});
    try{await assert.rejects(bad.memory.execute(c,'status'),/MEMORY_SOURCE_OUTSIDE_OWNER/);}finally{await bad.dispose();}
  }finally{await s.cleanup();}
});

test('activity and delegated Sessions cannot accept or annotate; delegated proposals retain suggestion ownership',async()=>{
  const s=await setup(['A']);
  try {
    const A=s.f.manifests[0],activity=await s.otherAgent(A,'activity'),delegate=await s.otherAgent(A,'delegate');
    const proposed=await s.propose(A,{agent:delegate});assert.equal(proposed.ok,true);
    for(const agent of [activity,delegate]) {
      await assert.rejects(s.mutate(A,'accept',{event_id:'evt_same',expected_revision:1},{agent}),/AUTHORITY_REQUIRED/);
      await assert.rejects(s.mutate(A,'annotate',{event_id:'evt_same',fields:{note:'fake'},expected_revision:1},{agent}),/AUTHORITY_REQUIRED/);
    }
    const summary=await s.services.memory.execute(s.execution(A),'open',{view:'summary',event_id:'evt_same'}),event=JSON.parse(summary.result.text);
    assert.equal(event.authorship.kind,'child_suggestion');assert.equal(event.authorship.life_id,A.lifeId);
    assert.ok(event.suggested_meaning);assert.equal(event.meaning,undefined);
    await assert.rejects(s.services.vault.execute(s.contexts.execution(delegate),'list'),/VAULT_DELEGATE_DENIED/);
  }finally{await s.cleanup();}
});

test('Vault owns one root per runtime, survives reopen, and uses explicit replacement semantics',async()=>{
  const s=await setup(['A']);let second;
  try {
    const A=s.f.manifests[0],c=s.execution(A);
    await s.services.vault.execute(c,'write',{path:'same',value:'TEST ONLY old'});
    second=createPrivateServices({contexts:s.contexts});
    await assert.rejects(second.vault.execute(c,'read',{path:'same'}),/VAULT_OWNER_ALREADY_ACTIVE/);
    await second.dispose();second=null;await s.services.vault.dispose();
    second=createPrivateServices({contexts:s.contexts});
    const original=await second.vault.execute(c,'read',{path:'same'});assert.equal(original.document.value,'TEST ONLY old');
    await Promise.all([second.vault.execute(c,'write',{path:'same',value:'TEST ONLY replace 1'}),second.vault.execute(c,'write',{path:'same',value:'TEST ONLY replace 2'})]);
    const latest=await second.vault.execute(c,'read',{path:'same'});assert.equal(latest.document.value,'TEST ONLY replace 2');
  }finally{await second?.dispose();await s.cleanup();}
});

test('credentials, browsers and costs resolve exact owner references and never fall back to legacy',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.f.manifests,ac=s.execution(A,{callId:'TEST call',costCategory:'memory'}),bc=s.execution(B);
    const a=s.services.bindings.credential(ac,'memory','QWEN'),b=s.services.bindings.credential(bc,'memory','QWEN');
    assert.equal(a.lifeId,A.lifeId);assert.notEqual(a.hostRef,b.hostRef);assert.equal(a.accountRef,b.accountRef);
    assert.notEqual(s.services.bindings.browser(ac).profileRoot,s.services.bindings.browser(bc).profileRoot);
    assert.notEqual(s.services.bindings.capability(ac,'memory').instanceId,s.services.bindings.capability(bc,'memory').instanceId);
    const cost=s.services.bindings.attribution(ac,{operation:'embedding',accountName:'qwen'});assert.equal(cost.lifeId,A.lifeId);assert.equal(cost.callId,'TEST call');
    assert.throws(()=>s.services.bindings.credential(ac,'memory','DL_QWEN_API_KEY'),/CREDENTIAL_BINDING_REQUIRED/);
    assert.throws(()=>s.services.bindings.browser(ac,'legacy-persona-browser'),/BROWSER_BINDING_REQUIRED/);
    const collision=new Map(s.ownerBindings);collision.set(B.lifeId,{...collision.get(B.lifeId),accounts:s.ownerBindings.get(A.lifeId).accounts});
    assert.throws(()=>createPrivateServices({contexts:s.contexts,ownerBindings:collision}),/EXTERNAL_IDENTITY_OWNER_COLLISION/);
    const browserCollision=new Map(s.ownerBindings);browserCollision.set(A.lifeId,{...browserCollision.get(A.lifeId),browsers:{default:{bindingRef:'TEST own reference',profileRoot:resolve(B.deployment.workspace,'browser')}}});
    assert.throws(()=>createPrivateServices({contexts:s.contexts,ownerBindings:browserCollision}),/BINDING_FOREIGN_PRIVATE_ROOT/);
    const missing=createPrivateServices({contexts:s.contexts});
    try{await assert.rejects(missing.memory.execute(ac,'status'),/MEMORY_BINDING_REQUIRED/);assert.throws(()=>missing.bindings.credential(ac,'memory','QWEN'),/OWNER_BINDING_REQUIRED/);}finally{await missing.dispose();}
    const noApi=new Map(s.memoryBindings);noApi.set(A.lifeId,{...noApi.get(A.lifeId),syntheticProvider:false});
    const guarded=createPrivateServices({contexts:s.contexts,memoryBindings:noApi,ownerBindings:s.ownerBindings,nativeSources:s.nativeSources});
    try{await assert.rejects(guarded.memory.execute(ac,'search',{query:'TEST no API'}),/MEMORY_CREDENTIAL_BINDING_REQUIRED/);}finally{await guarded.dispose();}
    const emptyConfig=new Map(s.memoryBindings);emptyConfig.set(A.lifeId,{...emptyConfig.get(A.lifeId),config:{}});
    const configured=createPrivateServices({contexts:s.contexts,memoryBindings:emptyConfig});
    try{await assert.rejects(configured.memory.execute(ac,'status'),/MEMORY_CONFIGURATION_REQUIRED/);}finally{await configured.dispose();}
  }finally{await s.cleanup();}
});

test('native peer sources preserve sender and event provenance without automatic self-memory acceptance',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.f.manifests,source={kind:'life-message',rpcId:'room-message-TEST-peer',messageId:'TEST-peer',conversationId:'TEST-room',senderPrincipalId:B.lifeId,clientTimeZone:'Asia/Shanghai'};
    const message={role:'user',content:[{type:'text',text:'[Conversation TEST-room / Sender principal '+B.lifeId+']\nTEST ONLY peer original'}],source};
    await appendFile(s.paths.get(A.authoritySessionId),JSON.stringify({type:'user/message',seq:100,time:Date.now(),data:message})+'\n'+
      JSON.stringify({type:'agent/inbox/spliced',seq:101,time:Date.now(),data:{inserted:[message]}})+'\n');
    const c=s.execution(A),pending=await s.services.memory.execute(c,'pending',{namespace:'harness_session_v4'});
    assert.equal(pending.ok,true);assert.equal(pending.result.messages.length,1);
    const original=await s.services.memory.execute(c,'open',{view:'message',namespace:'harness_session_v4',conversation:A.authoritySessionId,record_id:'101:user:0'});
    assert.ok(original.result.text.includes('TEST ONLY peer original'));assert.equal(original.result.source_mapping[0].locator.path,canonical(s.paths.get(A.authoritySessionId)));
    const observations=(await readFile(resolve(A.deployment.memory,'source-observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const peer=observations.find(row=>row.item.raw.source==='life-message');
    assert.deepEqual(peer.item.raw.source_metadata,source);assert.equal(peer.item.raw.sender_principal_id,B.lifeId);
    const catalog=await s.services.memory.execute(c,'catalog');assert.equal(catalog.result.total,0);
    const other=await s.services.memory.execute(s.execution(B),'pending',{namespace:'harness_session_v4'});assert.equal(other.result.messages.length,0);
  }finally{await s.cleanup();}
});

test('room-inbox sources retain real life/human speakers and owner receiving experience without sharing or accepting memories',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.f.manifests,roomId='TEST ONLY SAME DIRECT ROOM';
    for(const [receiver,sender] of [[A,B],[B,A]]) {
      const source={kind:'room-inbox',rpcId:'TEST-request-'+receiver.lifeId,inboxId:'TEST-inbox-'+receiver.lifeId,
        messageId:'TEST SAME MESSAGE ID',roomId,conversationId:roomId,receiverLifeId:receiver.lifeId,senderPrincipalId:sender.lifeId,
        sender:{sender_id:sender.lifeId,sender_type:'life',life_id:sender.lifeId,display_name:sender.displayName},clientTimeZone:'Asia/Shanghai'};
      const message={role:'user',content:[{type:'text',text:'TEST ONLY '+sender.displayName+' original peer body; transport user does not mean human'}],source};
      await appendFile(s.paths.get(receiver.authoritySessionId),JSON.stringify({type:'user/message',seq:200,time:Date.now(),data:message})+'\n'+
        JSON.stringify({type:'agent/inbox/spliced',seq:201,time:Date.now(),data:{inserted:[message]}})+'\n');
    }
    const humanSource={kind:'room-inbox',rpcId:'TEST-human-request',inboxId:'TEST-human-inbox',messageId:'TEST-human-message',roomId:'TEST-human-room',
      receiverLifeId:A.lifeId,senderPrincipalId:'human:TEST-observer',sender:{sender_id:'human:TEST-observer',sender_type:'human',life_id:null,display_name:'TEST ONLY observer'}};
    const unknownSource={kind:'life-message',rpcId:'TEST-unknown-request',messageId:'TEST-unknown-message',conversationId:roomId,senderPrincipalId:'unmapped:TEST'};
    await appendFile(s.paths.get(A.authoritySessionId),
      JSON.stringify({type:'user/message',seq:202,time:Date.now(),data:{role:'user',content:[{type:'text',text:'TEST ONLY explicitly mapped human'}],source:humanSource}})+'\n'+
      JSON.stringify({type:'user/message',seq:203,time:Date.now(),data:{role:'user',content:[{type:'text',text:'TEST ONLY unmapped transport user'}],source:unknownSource}})+'\n');
    const pages=await Promise.all([A,B].map(receiver=>s.services.memory.execute(s.execution(receiver),'pending',{namespace:'harness_session_v4'})));
    assert(pages.every(page=>page.ok));assert.equal(pages[0].result.total,3);assert.equal(pages[1].result.total,1);
    assert.deepEqual(pages[0].result.messages.map(m=>m.role).sort(),['human','life','unknown']);
    for(const [index,receiver,sender] of [[0,A,B],[1,B,A]]) {
      const c=s.execution(receiver),item=pages[index].result.messages.find(m=>m.record_id==='201:user:0');assert.equal(item.role,'life');
      const original=await s.services.memory.execute(c,'open',{view:'message',namespace:item.namespace,conversation:receiver.authoritySessionId,record_id:item.record_id});
      assert(original.ok);assert(original.result.text.includes(sender.displayName+' original peer body'));
      assert(!original.result.text.includes(receiver.displayName+' original peer body'));
      assert.equal(original.result.source_mapping[0].locator.path,canonical(s.paths.get(receiver.authoritySessionId)));
      const observations=(await readFile(resolve(receiver.deployment.memory,'source-observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      const raw=observations.find(row=>row.item.raw.source==='room-inbox'&&row.item.raw.sender_principal_id===sender.lifeId).item.raw;
      assert.equal(raw.role,'life');assert.equal(raw.transport_role,'user');assert.equal(raw.sender.life_id,sender.lifeId);
      assert.equal(raw.sender.display_name,sender.displayName);assert.equal(raw.source_metadata.senderPrincipalId,sender.lifeId);
      assert.equal(raw.receiver_life_id,receiver.lifeId);assert.equal(raw.experienced_by_life_id,receiver.lifeId);assert.equal(raw.experience_kind,'received_social_message');
      assert.equal(raw.source_metadata.messageId,'TEST SAME MESSAGE ID');assert.equal(raw.source_metadata.roomId,roomId);
      assert.equal((await s.services.memory.execute(c,'catalog')).result.total,0);
      const ref={mid:item.mid,namespace:item.namespace,conversation_id:item.conversation,record_id:item.record_id,
        revision_hash:item.source_ref.revision_hash,content_hash:item.source_ref.content_hash};
      const event={name:'TEST ONLY received social message',one_line:receiver.displayName+' received a message from '+sender.displayName,time:{},
        meaning:{now:'TEST ONLY my experience is receiving this message; the sender authored its content'},source_refs:[ref],side_refs:[],
        units:[{key:'TEST-received',title:'TEST ONLY received experience',my_phrases:['TEST ONLY I received it'],terms:[],refs:[ref]}]};
      const proposal=await s.mutate(receiver,'propose',{event,event_id:'evt_same_room'});assert(proposal.ok);assert.equal(proposal.result.status,'candidate');
      const status=await s.services.memory.execute(c,'status');assert.equal(status.result.accepted,0);
      const journal=JSON.parse(await readFile(resolve(receiver.deployment.workspace,'memory/retrieval/journal-export.json'),'utf8'));
      assert.equal(journal.life_id,receiver.lifeId);assert(journal.entries.every(entry=>entry.actor.life_id===receiver.lifeId));
      assert(journal.entries.some(entry=>entry.payload.source_refs?.some(sourceRef=>sourceRef.conversation_id===receiver.authoritySessionId)));
    }
    const aRows=(await readFile(resolve(A.deployment.memory,'source-observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const human=aRows.find(row=>row.item.raw.sender_principal_id==='human:TEST-observer').item.raw;
    assert.equal(human.role,'human');assert.equal(human.sender.display_name,'TEST ONLY observer');assert.equal(human.sender.life_id,null);
    const unknown=aRows.find(row=>row.item.raw.sender_principal_id==='unmapped:TEST').item.raw;
    assert.equal(unknown.role,'unknown');assert.equal(unknown.sender.display_name,null);assert.equal(unknown.sender.life_id,null);
    assert.equal((await s.services.memory.execute(s.execution(B),'open',{view:'message',namespace:'harness_session_v4',conversation:A.authoritySessionId,record_id:'201:user:0'})).ok,false);
  }finally{await s.cleanup();}
});

test('room-inbox provenance rejects conflicting trusted sender and foreign receiver fields',async()=>{
  for(const fault of ['sender','receiver']) {
    const s=await setup();
    try {
      const [A,B]=s.f.manifests,source={kind:'room-inbox',messageId:'TEST-fault',roomId:'TEST-fault-room',senderPrincipalId:B.lifeId,
        sender:{sender_id:B.lifeId,sender_type:'life',life_id:fault==='sender'?A.lifeId:B.lifeId,display_name:B.displayName},
        receiverLifeId:fault==='receiver'?B.lifeId:A.lifeId};
      await appendFile(s.paths.get(A.authoritySessionId),JSON.stringify({type:'user/message',seq:300,time:Date.now(),
        data:{role:'user',content:[{type:'text',text:'TEST ONLY invalid Host provenance'}],source}})+'\n');
      const result=await s.services.memory.execute(s.execution(A),'pending',{namespace:'harness_session_v4'});
      assert.equal(result.ok,false);assert.equal(result.error,fault==='sender'?'MEMORY_PEER_SENDER_MISMATCH':'MEMORY_PEER_RECEIVER_MISMATCH');
    }finally{await s.cleanup();}
  }
});

test('delayed peer processing preserves sent/received timeline facts and labels unknown legacy send time',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.f.manifests,room='TEST ONLY DELAYED DIRECT ROOM';
    const sentAt='2026-10-06T08:01:02.123+08:00',receivedAt='2026-10-06T00:01:03.234Z',processedAt='2026-10-06T12:30:00.456Z';
    const formal={kind:'room-inbox',rpcId:'TEST-formal-late',messageId:'TEST SAME TIMELINE MESSAGE',roomId:room,conversationId:room,
      messageTimestamp:sentAt,receivedAt,messageTimelineSeq:42,senderPrincipalId:B.lifeId,receiverLifeId:A.lifeId,
      sender:{sender_id:B.lifeId,sender_type:'life',life_id:B.lifeId,display_name:B.displayName}};
    const legacy={kind:'life-message',rpcId:'TEST-legacy-late',messageId:'TEST SAME TIMELINE MESSAGE',conversationId:room,senderPrincipalId:A.lifeId};
    for(const [receiver,source,body] of [[A,formal,'TEST ONLY B EARLY SENT ORIGINAL'],[B,legacy,'TEST ONLY A UNKNOWN LEGACY SEND ORIGINAL']]) {
      const message={role:'user',source,content:[{type:'text',text:body}]};
      await appendFile(s.paths.get(receiver.authoritySessionId),JSON.stringify({type:'user/message',seq:400,time:Date.parse(processedAt)-1,data:message})+'\n'+
        JSON.stringify({type:'agent/inbox/spliced',seq:401,time:Date.parse(processedAt),data:{inserted:[message]}})+'\n');
    }
    for(const [receiver,source,sender] of [[A,formal,B],[B,legacy,A]]) {
      const c=s.execution(receiver),pending=await s.services.memory.execute(c,'pending',{namespace:'harness_session_v4'});
      assert(pending.ok);assert.equal(pending.result.total,1);assert.equal(pending.result.messages[0].record_id,'401:user:0');
      assert.equal(Date.parse(pending.result.messages[0].created_at),Date.parse(receiver===A?sentAt:processedAt));
      const open=await s.services.memory.execute(c,'open',{view:'message',namespace:'harness_session_v4',conversation:receiver.authoritySessionId,record_id:'401:user:0'});
      assert(open.ok);assert.equal(open.result.source_mapping[0].locator.path,canonical(s.paths.get(receiver.authoritySessionId)));
      const rows=(await readFile(resolve(receiver.deployment.memory,'source-observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      const raw=rows.find(row=>row.item.raw.source===source.kind).item.raw;
      assert.deepEqual(raw.source_metadata,source);assert.equal(raw.sender_principal_id,sender.lifeId);assert.equal(raw.experienced_by_life_id,receiver.lifeId);
      assert.equal(Date.parse(raw.native_materialized_at),Date.parse(processedAt));assert.equal(raw.observed_at,raw.native_materialized_at);
      if(receiver===A) {
        assert.equal(raw.created_at,sentAt);assert.equal(raw.message_sent_at,sentAt);assert.equal(raw.received_at,receivedAt);assert.equal(raw.message_timeline_seq,42);
        assert.equal(raw.time_provenance.created_at,'source.messageTimestamp');assert.equal(raw.time_provenance.message_timestamp_status,'valid');
        assert(Date.parse(raw.created_at)<Date.parse(raw.native_materialized_at));
      } else {
        assert.equal(raw.message_sent_at,null);assert.equal(raw.received_at,null);assert.equal(raw.message_timeline_seq,null);
        assert.equal(raw.time_provenance.message_sent_at,'unknown');assert.equal(raw.time_provenance.message_timestamp_status,'unknown');
        assert.equal(raw.time_provenance.created_at,'native-event-observation-only; message-sent-time-unknown');
      }
      const before=rows.length;await s.services.memory.execute(c,'sync');
      const after=(await readFile(resolve(receiver.deployment.memory,'source-observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(after.length,before,'projection timestamps must be stable, rather than Memory sync time replacing the native evidence');
      assert.equal((await s.services.memory.execute(c,'status')).result.accepted,0);
    }
    // Invalid or timezone-free metadata remains intact as raw source metadata,
    // but it does not become a fabricated sent/received timestamp.
    const invalid={...formal,messageId:'TEST-invalid-time',rpcId:'TEST-invalid-time',messageTimestamp:'not-a-timestamp',receivedAt:'2026-10-06T12:00:00',messageTimelineSeq:true};
    await appendFile(s.paths.get(A.authoritySessionId),JSON.stringify({type:'user/message',seq:402,time:Date.parse(processedAt),
      data:{role:'user',source:invalid,content:[{type:'text',text:'TEST ONLY INVALID TIME METADATA'}]}})+'\n');
    const pending=await s.services.memory.execute(s.execution(A),'pending',{namespace:'harness_session_v4'});assert.equal(pending.result.total,2);
    const rows=(await readFile(resolve(A.deployment.memory,'source-observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const raw=rows.find(row=>row.item.raw.source_metadata?.messageId==='TEST-invalid-time').item.raw;
    assert.deepEqual(raw.source_metadata,invalid);assert.equal(raw.message_sent_at,null);assert.equal(raw.received_at,null);assert.equal(raw.message_timeline_seq,null);
    assert.equal(raw.time_provenance.message_timestamp_status,'invalid');assert.equal(Date.parse(raw.created_at),Date.parse(processedAt));
    assert.equal((await s.services.memory.execute(s.execution(B),'pending',{namespace:'harness_session_v4'})).result.total,1);
  }finally{await s.cleanup();}
});
