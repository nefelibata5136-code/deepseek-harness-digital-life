// Explicit operator recovery. No Room polling, resident timer, or new identity.
import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {bootLifeHost} from './host.mjs';
import {createOfficialProviderFactory,captureOfficialRawTransport} from './platform/official-provider.mjs';
import {mountNormalInterfaceOwnership} from './platform/normal-interface-ownership.mjs';
import {credentialOperation} from '../capabilities/isolation.mjs';
import {workerRegistry,workerLayout,worldSnapshot,privacyManifests,privateControlRoots,credentialResolver,worldRoot,python} from './supervisor/deployment.mjs';
import {workerRequest} from './supervisor/client.mjs';
import {findSessionPath} from './supervisor/acceptance-tools.mjs';
const lifeId=process.argv[2];
if(!lifeId||!process.argv.includes('--execute'))throw new Error('EXPLICIT_LIFE_AND_EXECUTE_REQUIRED');
try {await workerRequest(lifeId,'/status');throw new Error('WORKER_MUST_BE_OFFLINE');}catch(e){if(e.message==='WORKER_MUST_BE_OFFLINE')throw e;}
const manifest=worldSnapshot().lives[lifeId];if(!manifest||manifest.kind==='legacy')throw new Error('MODERN_LIFE_REQUIRED');
const layout=workerLayout(lifeId),sessionId=manifest.authoritySessionId;
const report=resolve(import.meta.dirname,'../../../reports/newlife-compaction-recovery-20261007',String(Date.now()));await mkdir(report,{recursive:true});
const journal=await findSessionPath(layout.session_root,sessionId),before=await readFile(journal);
const backup=resolve(report,'original-'+Date.now()+'.jsonl');await copyFile(journal,backup);
const hash=v=>createHash('sha256').update(v).digest('hex');
await writeFile(resolve(report,'backup.json'),JSON.stringify({lifeId,sessionId,journal,backup,bytes:before.length,sha256:hash(before)},null,2));
const registry=await workerRegistry(lifeId),lives=registry.list(),resolver=credentialResolver(lives);
const memoryBindings=new Map(),ownerBindings=new Map();
for(const m of lives){memoryBindings.set(m.lifeId,{sources:[],config:{workspace_id:'YOUR_DASHSCOPE_WORKSPACE_ID',embedding_model:'text-embedding-v4',rerank_model:'qwen3-rerank',dimension:1024,default_results:5,default_candidates:30},credentialLogicalRef:'QWEN_API_KEY'});
ownerBindings.set(m.lifeId,{accounts:{deepseek:{accountRef:resolver.accountForLife(m.lifeId),kind:'provider',shared:false},qwen:{accountRef:'shared-qwen-provider',kind:'provider',shared:true}},credentials:{memory:{QWEN_API_KEY:{hostRef:'DL_QWEN_API_KEY',accountName:'qwen'}}},browsers:{}});}
let host;
try{
host=await bootLifeHost({registry,root:layout.kernel_root,sessionRoot:layout.session_root,scheduleRoot:layout.schedule_root,externalWorld:true,platformRoot:resolve(worldRoot,'workers',lifeId,'platform'),digitalLifePreset:true,
providerRoutes:['deepseek-official'],memoryBindings,ownerBindings,privacyPolicy:'logical-owner-routing',admit:async()=>({allowed:true}),authorityPolicy:c=>c.manifest.kind==='legacy',actorPolicy:c=>c.role==='authority',
hostCredentialForMemory:async(_c,b)=>(await credentialOperation(python,'resolve',b.hostRef)).value,
capabilityOptions:{credentialBackend:async(_c,b,action)=>credentialOperation(python,action,b.hostRef)},
rawModelTransport:captureOfficialRawTransport(),providerFactory:createOfficialProviderFactory({credentialForAccount:resolver.credentialForAccount}),
budgetConfig:{budgetLimitsEnabled:false,accounts:new Map(resolver.metadata().map(r=>[r.accountRef,{dailyLimitNanoCny:5000000000,stopOnUnknownUsage:false}])),lifeAccounts:new Map(lives.map(m=>[m.lifeId,{accountRef:resolver.accountForLife(m.lifeId)}]))},
extensions:[async h=>mountNormalInterfaceOwnership(h.ctx,{registry:h.contexts.registry,contexts:h.contexts,manifests:privacyManifests,controlRoots:privateControlRoots,protectedWriteRoots:[resolve(import.meta.dirname,'../..')]})]});
host.runtime.workerLifeIds=new Set([lifeId]);
const agent=await host.runtime.create({lifeId,sessionId,role:'authority'});
const allowed=new Set(['context_compact','context_compact_prepare','context_compact_read','context_compact_commit','context_compact_status','read','read_source','life_core_read','life_session_read','life_session_list','session_event_read','session_event_trace','session_event_search','session_search','cache_status','billing_status','budget_status']);
host.ctx.tools.guard(exec=>exec.agent===agent&&!allowed.has(exec.name)?'RECOVERY_ONLY: only read and self-compaction tools are available during this operator recovery':undefined);
const tools=host.ctx.tools.schemas(agent).map(t=>t.name);
// Suppress Resident follow-on prompting only in this operator instance.
// Durable settings are unchanged; the normal worker restores ordinary behavior.
const ownerFoundation=host.ctx.agentPresets.serviceFor(agent,'personaHost');
if(ownerFoundation)ownerFoundation.status=async()=>({stop_reason:'operator-compaction-recovery'});
if(!tools.includes('context_compact_prepare')||!host.ctx.tokenMeter)throw new Error('SELF_COMPACTION_NOT_MOUNTED');
const startSeq=agent.session.seq,initial=host.ctx.tokenMeter.measure(agent.session);
console.log(JSON.stringify({stage:'author-ready',lifeId,sessionId,startSeq,inputEstimate:initial.totalTokens,tools:tools.filter(n=>n.startsWith('context_compact'))}));
host.ctx.on('session/event',(s,e)=>{if(s.id===sessionId&&['tool/call','turn/end','compaction/end'].includes(e.type))console.log(JSON.stringify({stage:e.type,seq:e.seq,name:e.data.name,reason:e.data.reason?.kind,error:e.data.error?.map?.(v=>v.message)}));});
const requestId=randomUUID();await writeFile(resolve(report,'request.json'),JSON.stringify({lifeId,sessionId,requestId,startSeq,initialTokens:initial.totalTokens,observedAt:new Date().toISOString()},null,2));
await host.runtime.prompt({lifeId,sessionId,requestId,sourceKind:'operator-self-compaction-recovery',content:[{type:'text',text:'用户明确要求尽快恢复：你的上下文已超出容量。现在是原本人、原主Session的轻量容量恢复视图，只包含本人Core与本轮恢复内容，旧历史完整保留。这是实际恢复，不是功能测试。暂停所有旧任务和外部动作，立即 context_compact_prepare（retain_ratio 建议0.05），用 context_compact_read 分页核查关键原文，尤其早期身份和决定、最近未完事项。由你本人决定保留内容并写 checkpoint，调用 context_compact_commit，再调用 context_compact_status 确认 committed。未读的材料明确为未逐条阅读，可回查原始Session，不猜测、不补造。原文始终保留，不写长期记忆。成功后本轮结束，控制侧恢复运行；不要继续旧任务或发Room消息。'}]});
await agent.whenIdle();await host.ctx.sessions.flush(agent.session);
const events=[...agent.session.ownEvents()],ends=events.filter(e=>e.seq>=startSeq&&e.type==='compaction/end'&&!e.data.error),summary=events.findLast(e=>e.type==='compaction/summary');
const result={lifeId,sessionId,requestId,startSeq,endSeq:agent.session.seq,committed:ends.length>0,initialTokens:initial.totalTokens,afterTokens:host.ctx.tokenMeter.measure(agent.session).totalTokens,summarySeq:summary?.seq,provider:summary?.data.provider,model:summary?.data.model,turnEnd:events.findLast(e=>e.type==='turn/end')?.data.reason,originalPrefixPreserved:(await readFile(journal)).subarray(0,before.length).equals(before)};
await writeFile(resolve(report,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
if(!result.committed||!result.originalPrefixPreserved)throw new Error('RECOVERY_NOT_COMMITTED');
}finally{if(host){await host.drainCheckpoints();await host.ctx.fiber.dispose();}registry.close();}
