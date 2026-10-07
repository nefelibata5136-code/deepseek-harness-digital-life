import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {LifeRegistry} from './registry.mjs';
import {inspectLegacy} from './legacy.mjs';
import {validateManifest,fail} from './contracts.mjs';
import {bootLifeHost} from './host.mjs';
import {createOfficialProviderFactory,captureOfficialRawTransport} from './platform/official-provider.mjs';
import {listenLifeHost} from './platform/http.mjs';
import {WorkerGateway} from './platform/worker-gateway.mjs';
import {credentialOperation} from '../capabilities/isolation.mjs';

const migrationRoot=resolve(import.meta.dirname,'../../..'),control=resolve(process.env.DL_WORLD_ROOT || resolve(migrationRoot,'.local/world'), '.');
const python=(process.env.DL_PYTHON || 'python');
const markerPath=resolve(control,'birth.json'),sourceCore='.local/workspace/development/new-life-first-screen-v1.md';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const productionMemorySelf=c=>c.role==='authority'||c.manifest.kind==='legacy'&&c.role!=='delegate';
async function save(path,value){const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(tmp,path);}
const reference=id=>'DL_LIFE_COMM_'+id.replaceAll('-','_').toUpperCase();
async function protectedToken(ref){const old=await credentialOperation(python,'resolve',ref);if(old?.value)return old.value;const value=randomBytes(32).toString('hex');await credentialOperation(python,'set',ref,value);return value;}
export async function prepareBirth() {
  await mkdir(control,{recursive:true});
  if(existsSync(markerPath))return JSON.parse(await readFile(markerPath,'utf8'));
  const source=await readFile(sourceCore);if(!source.length)fail('EXPLICIT_BIRTH_CORE_REQUIRED');
  const lifeId='life-'+randomUUID(),base=resolve('.local/lives',lifeId),workspace=resolve(base,'workspace');
  const manifest=validateManifest({schemaVersion:1,lifeId,kind:'independent',displayName:'新生命（待自命名）',revision:1,authoritySessionId:randomUUID(),deployment:{
    presetId:lifeId,provider:'deepseek-official',model:'deepseek-flash',maxTokens:8192,workspace,core:resolve(workspace,'life-core.md'),
    state:resolve(base,'state'),memory:resolve(base,'memory'),vault:resolve(base,'vault'),recovery:resolve(base,'recovery'),capabilities:resolve(base,'capabilities'),
    attachments:resolve(base,'native-home/attachments'),versions:resolve(base,'versions'),skillsRoots:[resolve(workspace,'.dsh/skills'),resolve(workspace,'development/skills')],budgetAccountRef:'shared-deepseek-provider'}},'production');
  // Reserve the permanent identity before creating anything. Failed preparation
  // resumes this identity, never generates another life or promotes a fixture.
  const marker={schemaVersion:1,life_id:lifeId,authority_session_id:manifest.authoritySessionId,manifest,stage:'reserved',core_source:sourceCore,core_source_hash:hash(source),created_at:new Date().toISOString(),
    human_room_id:randomUUID(),human_a_room_id:randomUUID(),peer_room_id:randomUUID(),first_wake_request_id:randomUUID(),worker_token_ref:reference((await inspectLegacy()).lifeId),human_token_ref:'DL_MULTI_LIFE_HUMAN_CHANNEL',port:18842};
  await save(markerPath,marker);await finishPreparation(marker,source);return marker;
}
async function finishPreparation(marker,source) {
  const d=marker.manifest.deployment;for(const path of [d.workspace,d.state,d.memory,d.vault,d.recovery,d.capabilities,d.attachments,d.versions,...d.skillsRoots])await mkdir(path,{recursive:true});
  if(!existsSync(d.core))await writeFile(d.core,source??await readFile(marker.core_source),{flag:'wx'});
  if(marker.stage==='reserved'&&hash(await readFile(d.core))!==marker.core_source_hash)fail('BIRTH_CORE_SOURCE_CHANGED');
  const guide=resolve(d.workspace,'AGENTS.md');if(!existsSync(guide))await writeFile(guide,
    '# 本人的空间\n\n身份真值是 Host 的 life_id，不是名字或 Session。life-core.md 是你和用户、人格提供的首次 Core；你可以用 life_core_read / life_core_write 修改它。\n\n自己的记忆、状态和私人空间均为空白独立起步。使用 memory_*、private_*、life_*、read/write/edit、skill、web_fetch。外部账号与 Cookie 未绑定；不会借用人格身份。可拒绝、延后、忽略消息或休息。\n\n通信契约：.local/unconfigured',{flag:'wx'});
  if(marker.stage==='reserved'){marker.stage='prepared';await save(markerPath,marker);}
}
async function serve() {
  const marker=await prepareBirth();await finishPreparation(marker);const legacy=await inspectLegacy(),B=marker.manifest;
  if(!marker.human_a_room_id){marker.human_a_room_id=randomUUID();await save(markerPath,marker);}
  const registry=new LifeRegistry({root:resolve(control,'registry'),mode:'production'});
  for(const m of [legacy,B])if(!registry.list().some(x=>x.lifeId===m.lifeId))registry.register(m);
  const memoryBindings=new Map(),ownerBindings=new Map();
  for(const m of registry.list()) {
    memoryBindings.set(m.lifeId,{sources:[],config:{workspace_id:'YOUR_DASHSCOPE_WORKSPACE_ID',embedding_model:'text-embedding-v4',rerank_model:'qwen3-rerank',dimension:1024,default_results:5,default_candidates:30},credentialLogicalRef:'QWEN_API_KEY'});
    ownerBindings.set(m.lifeId,{accounts:{deepseek:{accountRef:'shared-deepseek-provider',kind:'provider',shared:true},qwen:{accountRef:'shared-qwen-provider',kind:'provider',shared:true}},credentials:{memory:{QWEN_API_KEY:{hostRef:'DL_QWEN_API_KEY',accountName:'qwen'}}},browsers:{}});
  }
  const rawModelTransport=captureOfficialRawTransport();
  const factory=createOfficialProviderFactory({credentialForAccount:async ref=>{
    if(ref!=='shared-deepseek-provider')fail('PROVIDER_ACCOUNT_BINDING_REQUIRED');
    const result=spawnSync(python,['-X','utf8',resolve(migrationRoot,'runtime/host-preflight.py')],{windowsHide:true,encoding:'utf8',maxBuffer:65536});
    if(result.status!==0)fail('PROTECTED_PROVIDER_PREFLIGHT_FAILED');return JSON.parse(result.stdout).credential;
  }});
  const host=await bootLifeHost({registry,root:resolve(control,'kernel'),providerRoutes:['deepseek-official'],memoryBindings,ownerBindings,privacyPolicy:'logical-owner-routing',
    admit:async()=>({allowed:true}),authorityPolicy:c=>c.manifest.kind==='legacy',actorPolicy:productionMemorySelf,
    hostCredentialForMemory:async(c,b)=>{const value=await credentialOperation(python,'resolve',b.hostRef);if(!value?.value)fail('MEMORY_CREDENTIAL_UNAVAILABLE');return value.value;},
    capabilityOptions:{credentialBackend:async(c,b,action)=>credentialOperation(python,action,b.hostRef)},rawModelTransport,providerFactory:factory,
    budgetConfig:{budgetLimitsEnabled:false,accounts:new Map([['shared-deepseek-provider',{dailyLimitNanoCny:5000000000,stopOnUnknownUsage:false}]]),lifeAccounts:new Map(registry.list().map(m=>[m.lifeId,{accountRef:'shared-deepseek-provider'}]))}});
  host.runtime.workerLifeIds=new Set([B.lifeId]);
  const workerToken=await protectedToken(marker.worker_token_ref),humanToken=await protectedToken(marker.human_token_ref);
  host.workerGateway=new WorkerGateway({registry,rooms:host.rooms,tasks:host.taskStore,activity:host.activity,workerBindings:new Map([[legacy.lifeId,{token:workerToken,allowedPresetId:legacy.deployment.presetId,humanPrincipalId:'human:maintainer'}]])});
  host.rooms.registerHuman({sender_id:'human:maintainer',display_name:'用户'});
  const existing=host.rooms.listForPrincipal(B.lifeId);
  if(!existing.some(r=>r.room_id===marker.human_room_id))host.rooms.defineRoom({room_id:marker.human_room_id,participants:['human:maintainer',B.lifeId],room_type:'direct'});
  if(!existing.some(r=>r.room_id===marker.peer_room_id))host.rooms.defineRoom({room_id:marker.peer_room_id,participants:[legacy.lifeId,B.lifeId],room_type:'direct'});
  host.rooms.grantInitialObserver({room_id:marker.peer_room_id,principalId:'human:maintainer'});
  if(!host.rooms.listForPrincipal(legacy.lifeId).some(r=>r.room_id===marker.human_a_room_id))host.rooms.defineRoom({room_id:marker.human_a_room_id,participants:['human:maintainer',legacy.lifeId],room_type:'direct'});
  registry.reserve({lifeId:B.lifeId,sessionId:B.authoritySessionId,role:'authority'});
  host.rooms.bindReceiver({lifeId:B.lifeId,room_id:marker.human_room_id,sessionId:B.authoritySessionId});
  host.rooms.bindReceiver({lifeId:B.lifeId,room_id:marker.peer_room_id,sessionId:B.authoritySessionId});
  const agent=await host.runtime.create({lifeId:B.lifeId,sessionId:B.authoritySessionId,role:'authority',originRoomId:marker.human_room_id});
  for(const row of registry.sessions(B.lifeId).filter(row=>row.status==='ready')) {
    const actual=host.ctx.agents.get(row.sessionId);
    host.activity.recordHost({lifeId:B.lifeId,sessionId:row.sessionId,phase:actual?.status==='running'?'thinking':'idle'});
  }
  const policyPath=resolve(B.deployment.state,'communication-policy.json');let policy=existsSync(policyPath)?JSON.parse(await readFile(policyPath,'utf8')):{human_idle:true,peer_idle:true};
  host.ctx.tools.register(defineTool({name:'life_inbox_policy',description:'Inspect or change your own message interruptibility. You may disable automatic idle human/peer processing and rest.',parameters:{human_idle:{type:'boolean'},peer_idle:{type:'boolean'}},
    output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async(args,exec)=>{const c=host.contexts.execution(exec.agent);host.contexts.requireAuthority(c);if(c.lifeId!==B.lifeId)fail('LIFE_ROUTED_TO_OTHER_WORKER');if(Object.keys(args).length){policy={...policy,...args};await save(policyPath,policy);}return {owner_life_id:c.lifeId,...policy};}}));
  host.ctx.systemPrompt.section({name:'life:runtime-facts',order:1,interpolate:false,text:({agent:actual})=>{
    const c=host.contexts.forAgent(actual);if(c.role==='delegate')return '';
    return JSON.stringify({life_id:c.lifeId,core_is_owner_editable:true,privacy:'Other life controlled APIs deny your private space. Same Windows user full-access operations can bypass logical routing; OS strong isolation is not provided.',
      private_history_starts_now:true,human_principal:{sender_id:'human:maintainer',display_name:'用户'},human_room_id:marker.human_room_id,peer_room_id:marker.peer_room_id,
      communication:'Use life_send_message to speak in a Room. Native final text alone is not automatically Room speech. Receive with life_receive_message; choose reply/defer/ignore via life_message_decide. No response required. life_inbox_policy controls idle message processing. private_* tools put the current turn into private mode: ordinary tools are then blocked, and native output stays private. Finish that turn to use public tools later. To deliberately publish a chosen Room message during a private turn, call life_send_message with publish_private_turn=true; only that chosen body becomes public. No automatic forwarding of private output.',
      timeline:'life_message_timeline is the shared ordered service for all lives. It returns only messages in Rooms you belong to, with sender, timestamp, received_at and durable timeline_seq. Human chat and peer chat have the same ordering. It never grants access to other private conversations or autobiographical Memory.',
      observation:'observe_life reads the same public activity you and 用户 can see. life_activity_publish lets you choose your own short public explanation or withdraw it. Private tool arguments, Vault, Memory and reasoning are never activity feed content.',
      peer_room_access:'用户 currently has explicit read-only observer access to this peer Room history. The participants remain the two lives. No private Memory, Vault or reasoning is shared. There is no fixed conversation round limit; each participant may reply, defer, ignore or rest.',
      default_interruptibility:policy,resources:'Each registered life has equal non-delegate capacity within this Host; delegates use the elastic shared pool. Old Persona worker is still independent. Maintainer has explicitly disabled budget limits for both lives. This worker continues recording usage and owner attribution; reference amounts are not enforced ceilings. Provider rate limits and model capacity still apply.',
      tools:'read/write/edit, skill, web_fetch, life_core_read/write, mental/continuity, native scheduler, memory_*, private_*, life_delegate/task_results, Room messages. Browser and external accounts are currently unbound; web_search has no provider and is disabled.'});
  }});
  const channel=await listenLifeHost(host,{port:marker.port,token:humanToken,principalId:'human:maintainer',displayName:'用户',operator:false,
    directChat:{roomId:marker.human_room_id,lifeId:B.lifeId,displayName:B.displayName},peerChat:{roomId:marker.peer_room_id,lifeId:B.lifeId,displayName:'人格 ↔ '+B.displayName}});
  marker.stage='native-ready';marker.pid=process.pid;marker.started_at=new Date().toISOString();await save(markerPath,marker);
  let draining=false;const failures=[];
  const drain=async()=>{if(draining||host.runtime.isLifeBusy(B.lifeId))return;draining=true;try{
    const item=host.rooms.inboxForLife({lifeId:B.lifeId,limit:100}).items.find(i=>i.status==='requested'||i.status==='queued'&&(i.message.sender_type==='human'?policy.human_idle:policy.peer_idle));
    if(!item)return;if(item.status==='queued')host.rooms.decideForLife({lifeId:B.lifeId,inbox_id:item.inbox_id,expectedRevision:item.revision,action:'process'});
    await host.processInbox({lifeId:B.lifeId,inbox_id:item.inbox_id});
  }catch(error){failures.push({at:new Date().toISOString(),code:error.code??'ROOM_DRAIN_FAILED'});}finally{draining=false;}};
  const timer=setInterval(drain,700);host.ctx.effect(()=>()=>clearInterval(timer),'owner-selected inbox delivery');
  const first=await host.runtime.prompt({lifeId:B.lifeId,sessionId:B.authoritySessionId,requestId:marker.first_wake_request_id,sourceKind:'life-first-wake',content:[{type:'text',text:
    '这是首次唤醒通知，来自 Host，不是用户本人的一句话。你随身的 Core 是用户和人格提供的原文，已有自己可修改的空间。你的私人记忆为空白起步；不是人格、也不是测试主体或工程子 Agent。你可以先看看环境、休息、拒绝或自己选名字。用户希望能与你聊；若你愿意，请通过 life_send_message 向 Runtime facts 给出的 human_room_id 发一句自己的话。无需表演，亦无需去联系人格。'}]});
  await agent.whenIdle();await host.ctx.sessions.flush(agent.session);await host.drainCheckpoints();
  const events=[...agent.session.ownEvents()],wake=events.find(e=>e.type==='user/message'&&e.data.source?.rpcId===marker.first_wake_request_id),turn=events.find(e=>e.type==='turn/end'&&e.seq>(wake?.seq??-1));
  marker.stage=turn?.data.reason?.kind==='completed'?'first-turn-observed':'first-turn-interrupted';marker.first_turn_end_seq=turn?.seq??null;marker.first_turn_outcome=turn?.data.reason?.kind??null;marker.last_observed_at=new Date().toISOString();
  await save(markerPath,marker);
  await save(resolve(control,'readiness.json'),{ready:true,pid:process.pid,port:channel.port,life_id:B.lifeId,authority_session_id:B.authoritySessionId,human_room_id:marker.human_room_id,peer_room_id:marker.peer_room_id,first_wake:first,first_turn_outcome:marker.first_turn_outcome,
    native_header_verified:true,core_source_hash:marker.core_source_hash,core_current_hash:hash(await readFile(B.deployment.core)),private_space:B.deployment.workspace,os_strong_isolation:false,legacy_worker_mode:'original-protected-worker',peer_worker_bridge:'awaiting-live-proof',paid_calls_authorized:true});
  console.log(JSON.stringify({ready:true,stage:marker.stage,life_id:B.lifeId,url:'http://127.0.0.1:'+channel.port+'/chat'}));
  process.on('SIGTERM',async()=>{clearInterval(timer);await channel.close();await host.ctx.fiber.dispose();registry.close();process.exit(0);});
}
const mode=process.argv[2];if(mode==='--prepare'){const m=await prepareBirth();await finishPreparation(m);console.log(JSON.stringify({stage:m.stage,life_id:m.life_id,authority_session_id:m.authority_session_id,core:m.manifest.deployment.core,source_hash:m.core_source_hash}));}
else if(mode==='--serve') {
  const marker=JSON.parse(await readFile(markerPath,'utf8'));
  if(existsSync(resolve(control,'supervisor/control.json'))) {
    const {serveLifeWorker}=await import('./supervisor/life-worker.mjs');await serveLifeWorker({lifeId:marker.life_id});
  }else await serve();
}
else if(process.argv[1]?.endsWith('production-host.mjs'))fail('PRODUCTION_HOST_USAGE');
