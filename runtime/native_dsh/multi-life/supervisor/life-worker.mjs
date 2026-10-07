import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {bootLifeHost} from '../host.mjs';
import {createOfficialProviderFactory,captureOfficialRawTransport} from '../platform/official-provider.mjs';
import {mountRoomWorker,createWorkerControlTransport} from '../platform/legacy-worker.mjs';
import {mountRoomInbox} from '../platform/legacy-room-inbox.mjs';
import {lifeExecutionStatus} from '../platform/execution-status.mjs';
import {mountNormalInterfaceOwnership} from '../platform/normal-interface-ownership.mjs';
import {createSharedResourceClient} from '../platform/shared-resource-client.mjs';
import {publicCredentialOperation as credentialOperation,publicSettings} from './public-deployment.mjs';
import {workerRegistry,workerLayout,assertLifeExecutionEnabled,worldSnapshot,privacyManifests,privateControlRoots,credentialResolver,worldRoot,python} from './public-deployment.mjs';
import {workerReference} from './neutral.mjs';
import {mountHighTestOverride} from './reasoning.mjs';
import {TestSessionStore} from './test-sessions.mjs';
import {fail} from '../contracts.mjs';

const safeCode=e=>/^[A-Z_]+$/.test(e?.code??'')?e.code:'LIFE_WORKER_COMMAND_FAILED';
async function save(path,value){const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(tmp,path);}
export async function serveLifeWorker({lifeId,port=18844}={}) {
  if(!lifeId)fail('EXPLICIT_EXISTING_LIFE_REQUIRED');
  assertLifeExecutionEnabled(lifeId);
  const snapshot=worldSnapshot(),manifest=snapshot.lives[lifeId];if(!manifest||manifest.kind==='legacy')fail('EXPLICIT_MODERN_WORKER_BINDING_REQUIRED');
  const marker=JSON.parse(await readFile(resolve(worldRoot,'birth.json'),'utf8'));
  const registry=await workerRegistry(lifeId),lives=registry.list(),resolver=credentialResolver(lives);
  const workerRoot=resolve(worldRoot,'workers',lifeId);await mkdir(workerRoot,{recursive:true});
  const {value:token}=await credentialOperation(python,'resolve',workerReference(lifeId));if(!token)fail('WORKER_CREDENTIAL_UNAVAILABLE');
  const rpc=createWorkerControlTransport('http://127.0.0.1:'+marker.port,lifeId,token);
  const resources=createSharedResourceClient({rpc,lifeId});
  const testStore=new TestSessionStore(resolve(workerRoot,'test-sessions.json'),{lifeId,authoritySessionId:manifest.authoritySessionId});
  const memoryBindings=new Map(),ownerBindings=new Map();
  for(const m of lives) {
    memoryBindings.set(m.lifeId,{sources:[],config:{workspace_id:publicSettings().memoryWorkspaceId,embedding_model:'text-embedding-v4',rerank_model:'qwen3-rerank',dimension:1024,default_results:5,default_candidates:30},credentialLogicalRef:'QWEN_API_KEY'});
    ownerBindings.set(m.lifeId,{accounts:{deepseek:{accountRef:resolver.accountForLife(m.lifeId),kind:'provider',shared:false},qwen:{accountRef:'shared-qwen-provider',kind:'provider',shared:true}},
      credentials:{memory:{QWEN_API_KEY:{hostRef:'DL_QWEN_API_KEY',accountName:'qwen'}}},browsers:{}});
  }
  const layout=workerLayout(lifeId);
  const host=await bootLifeHost({registry,root:layout.kernel_root,sessionRoot:layout.session_root,scheduleRoot:layout.schedule_root,externalWorld:true,platformRoot:resolve(workerRoot,'platform'),digitalLifePreset:true,
    providerRoutes:['deepseek-official'],memoryBindings,ownerBindings,privacyPolicy:'logical-owner-routing',
    admit:async()=>({allowed:true}),authorityPolicy:c=>c.manifest.kind==='legacy',actorPolicy:c=>c.role==='authority'||c.manifest.kind==='legacy'&&c.role!=='delegate',
    hostCredentialForMemory:async(_c,b)=>{const result=await credentialOperation(python,'resolve',b.hostRef);if(!result?.value)fail('MEMORY_CREDENTIAL_UNAVAILABLE');return result.value;},
    capabilityOptions:{credentialBackend:async(_c,b,action)=>credentialOperation(python,action,b.hostRef)},
    rawModelTransport:captureOfficialRawTransport(),providerFactory:createOfficialProviderFactory({credentialForAccount:resolver.credentialForAccount}),
    budgetConfig:{budgetLimitsEnabled:false,accounts:new Map(resolver.metadata().map(r=>[r.accountRef,{dailyLimitNanoCny:5000000000,stopOnUnknownUsage:false}])),
      lifeAccounts:new Map(lives.map(m=>[m.lifeId,{accountRef:resolver.accountForLife(m.lifeId)}]))},
    extensions:[async h=>mountNormalInterfaceOwnership(h.ctx,{registry:h.contexts.registry,contexts:h.contexts,
      manifests:privacyManifests,controlRoots:privateControlRoots,protectedWriteRoots:[resolve(import.meta.dirname,'../../..')],acquireResource:resources.acquire})]});
  host.runtime.workerLifeIds=new Set([lifeId]);
  await (await import('../../../desktop_persona/live-stream.mjs')).mountAssistantDisplay(host.ctx,{lifeId,sessionId:manifest.authoritySessionId,port:port+100,token});
  host.ctx.provide('sessionController',{resolveAgent:async id=>{try{return {agent:await host.runtime.resolve({lifeId,sessionId:id})};}catch(error){return {error};}}});
  const reasoning=mountHighTestOverride(host.ctx,{lifeId,path:resolve(worldRoot,'supervisor/test-reasoning.json')});
  const sessions=new Map(),pending=new Set();let residentFailure=null;
  let activityChain=Promise.resolve();
  host.ctx.on('session/event',(session,event)=>{
    const row=sessions.get(session.id),phase=({'turn/start':'thinking','tool/call':'tool','turn/end':'idle'})[event.type];
    if(!row||!phase)return;
    activityChain=activityChain.then(()=>row.bridge.recordActivity({phase,...phase==='tool'?{toolName:event.data.name}:{}})).catch(()=>{});
  });
  async function attach(sessionId,{role='authority',title,initialPolicy}={}) {
    if(sessions.has(sessionId))return sessions.get(sessionId);
    const agent=await host.runtime.create({lifeId,sessionId,role});
    if(title)agent.session.append('session/title',{title,source:{kind:'user'},messageSeqs:[]});
    const bridge=await mountRoomWorker(host.ctx,{lifeId,authoritySessionId:sessionId,workspace:manifest.deployment.workspace,
      presetId:manifest.deployment.presetId,role,supervisorUrl:'http://127.0.0.1:'+marker.port,token});
    const receiver=await mountRoomInbox({ctx:host.ctx,bridge,lifeId,authoritySessionId:sessionId,
      root:resolve(workerRoot,'inbox',sessionId),initialPolicy,batchLimit:20,debounceMs:500,intervalMs:700});
    const row={agent,bridge,receiver};sessions.set(sessionId,row);return row;
  }
  let policy={human_idle:true,peer_idle:true};
  const policyPath=resolve(manifest.deployment.state,'communication-policy.json');if(existsSync(policyPath))policy=JSON.parse(await readFile(policyPath,'utf8'));
  await attach(manifest.authoritySessionId,{initialPolicy:{human_idle:policy.human_idle,peer_idle:policy.peer_idle,rest:false}});
  for(const row of testStore.list())await attach(row.session_id,{role:'activity',initialPolicy:{human_idle:true,peer_idle:true,rest:false}});
  // This explicit worker controller drives the existing owner-bound clock.
  // Disabled settings stay disabled; only this life's authority may be woken.
  const residentTimer=setInterval(()=>{
    const p=host.tick(lifeId).then(()=>{residentFailure=null;}).catch(error=>{residentFailure=safeCode(error);}).finally(()=>pending.delete(p));
    pending.add(p);
  },30000);residentTimer.unref();
  host.ctx.systemPrompt.section({name:'life:runtime-facts',order:1,interpolate:false,text:({agent})=>{
    const c=host.contexts.forAgent(agent);if(c.role==='delegate')return '';
    return JSON.stringify({life_id:c.lifeId,owner_role:c.role,core_is_owner_editable:c.role==='authority',
      identity:'This is your own owner-bound Session. Activity/test Sessions are separate from your daily authority Session.',
      privacy:'Normal Host tools deny every other life private path. Logical routing does not create Windows user isolation.',
      communication:'life_send_message is the sole outward send tool. Choose to=contact name, visibility=private/public and optional in_response_to=event ID; Host resolves the destination; a successful send proves a Room message exists and does not complete the input. Only you choose semantic completion via life_message_decide complete or life_turn_ack.completed_event_ids. continue/process/defer/ignore express your input decisions. life_action_result and native tool/result supply objective confirmed_success, confirmed_failure or unknown; unknown requires reconciliation before another effect. Native final text alone is not Room speech. You may refuse tests.',
      sequence_semantics:'timeline_seq is the global durable commit sequence and may have authorized visibility gaps. received_at is Host enqueue time, never model reading time. Public activity is not a read receipt.',
      public_world:'Neutral Supervisor owns Registry, Rooms, Inbox, Timeline and Public Activity. This worker owns your native loop and private state only.',
      resources:'This deployment keeps cost attribution and optional budget policy. Budget limits are disabled in the public template. Requests use your independent Host-bound DeepSeek credential and record estimated cost; official key billing is separate truth.'});
  }});
  // A worker reports health over a Host-only transport. No bearer enters tools.
  async function heartbeat(){await rpc('heartbeat',{pid:process.pid,busy:[...sessions.values()].some(r=>r.agent.status==='running'),session_ids:[...sessions.keys()],version:'multi-life-p0-v2',...reasoning.status()});}
  await heartbeat();const timer=setInterval(()=>{const p=heartbeat().catch(()=>{}).finally(()=>pending.delete(p));pending.add(p);},5000);timer.unref();
  const server=createServer(async(req,res)=>{
    const send=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(403,{error:'HOST_AUTHENTICATION_REQUIRED'});
    try {
      if(req.method==='GET'&&req.url==='/execution-status')return send(200,lifeExecutionStatus({sessions,lifeId}));
      if(req.method==='GET'&&req.url==='/status')return send(200,{ready:true,pid:process.pid,life_id:lifeId,...reasoning.status(),resident_controller:{poll_ms:30000,failure:residentFailure},
        credential_binding:resolver.metadata().find(r=>r.lifeId===lifeId),sessions:[...sessions].map(([id,r])=>{const f=host.ctx.agentPresets.serviceFor(r.agent,'digitalLifeFoundation');return {session_id:id,busy:r.agent.status==='running',inbox:r.receiver.status(),
          recent_events:r.bridge.recentStatus?.()??null,communication:r.bridge.status(),
          visible_recent_tools:host.ctx.tools.schemas(r.agent).map(tool=>tool.name).filter(name=>name==='life_turn_ack'||name==='life_recent_events_review'),
          digital_life_foundation:f?{version:f.version,identity:f.identity,authority_session_id:f.authoritySessionId,native_preset:f.nativePreset,lifecycle:f.lifecycle,resident_module:f.residentModule,state_board_module:f.stateBoardModule,owner_scoped:f.ownerScoped,intention_sampling:f.intentionSampling}:null};})});
      if(req.method!=='POST')return send(404,{error:'UNKNOWN_WORKER_ROUTE'});
      let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)fail('INPUT_BODY_LIMIT');chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(req.url==='/test-session') {
        if(!/^[a-f0-9-]{36}$/i.test(input.session_id??'')||typeof input.title!=='string'||!input.title.trim())fail('EXPLICIT_TEST_SESSION_REQUIRED');
        if(input.session_id===manifest.authoritySessionId)fail('TEST_MUST_USE_INDEPENDENT_SESSION');
        await attach(input.session_id,{role:'activity',title:input.title,initialPolicy:{human_idle:true,peer_idle:true,rest:false}});
        testStore.add(input);
        return send(200,{created:true,life_id:lifeId,session_id:input.session_id,title:input.title});
      }
      if(req.url==='/prompt') {
        const row=registry.assertTarget(lifeId,input.session_id);
        if(row.role!=='activity'||typeof input.text!=='string'||!input.text.trim())fail('DEVELOPER_TEST_ACTIVITY_REQUIRED');
        return send(200,await host.runtime.prompt({lifeId,sessionId:input.session_id,requestId:input.request_id,text:undefined,
          sourceKind:'developer-test',content:[{type:'text',text:input.text}]}));
      }
      if(req.url==='/stop') {
        if([...host.ctx.agents.list?.()??[]].some(a=>a.status==='running'))fail('WORKER_BUSY');
        send(200,{stopping:true,life_id:lifeId});return void stop();
      }
      return send(404,{error:'UNKNOWN_WORKER_ROUTE'});
    }catch(error){return send(400,{error:safeCode(error)});}
  });
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});
  await save(resolve(workerRoot,'control.json'),{schema_version:1,life_id:lifeId,pid:process.pid,port,token_ref:workerReference(lifeId),
    authority_session_id:manifest.authoritySessionId,started_at:new Date().toISOString(),ownership:'life-worker',credential_binding:resolver.metadata().find(r=>r.lifeId===lifeId)});
  async function stop(){clearInterval(timer);clearInterval(residentTimer);for(const r of sessions.values())r.receiver.dispose();await Promise.all([...pending]);await activityChain;await host.drainCheckpoints();server.close();await host.ctx.fiber.dispose();registry.close();process.exit(0);}
  process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
  console.log(JSON.stringify({ready:true,pid:process.pid,life_id:lifeId,port,ownership:'life-worker'}));
  return host;
}
if(process.argv[1]?.endsWith('life-worker.mjs'))await serveLifeWorker({lifeId:process.argv[2],port:Number(process.argv[3]??18844)});
