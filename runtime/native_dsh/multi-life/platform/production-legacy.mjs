import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {inspectLegacy} from '../legacy.mjs';
import {mountLegacyWorker,mountRoomWorker,createWorkerControlTransport} from './legacy-worker.mjs';
import {credentialOperation} from '../../capabilities/isolation.mjs';
import {TestSessionStore} from '../supervisor/test-sessions.mjs';

// Explicit compatibility bootstrap for the original protected worker. It never
// opens the second life's native Sessions or substitutes another life for A.
export async function mountProductionLegacy(ctx,{authoritySessionId,migrationRoot}) {
  const control=resolve(process.env.DL_WORLD_ROOT || resolve(migrationRoot,'.local/world'), '.');
  let marker;try{marker=JSON.parse(await readFile(resolve(control,'birth.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const legacy=await inspectLegacy({migrationRoot});
  if(legacy.authoritySessionId!==authoritySessionId)throw new Error('LEGACY_PRIMARY_BINDING_MISMATCH');
  const testStore=new TestSessionStore(resolve(control,'workers',legacy.lifeId,'test-sessions.json'),{lifeId:legacy.lifeId,authoritySessionId});
  let bridge=null,timeline=null,receiver=null,lastError=null,starting=false,needsActivityResync=false;
  const testSessions=new Map(),unavailableSessions=new Map(),pendingHealthNotices=new Map();let heartbeatRpc;
  const errorCode=(error,fallback)=>/^[A-Z_]{1,128}$/.test(error.code??error.message??'')?error.code??error.message:fallback;
  async function publishHealthNotice(sessionId,code) {
    const event={source_key:'bootstrap-health:'+sessionId+':'+code,event_type:'system',occurred_at_utc:null,
      body:sessionId===authoritySessionId?'Host 无法恢复本人正式通信接线；请维护者检查原生 Session 与 Host 初始化。不会自动重放未知动作。':
        'Host 无法恢复一个已登记的本人活动对话；原日志保留，其他活动与主对话继续运行。需要明确恢复该 Session。',
      payload:{health_notice:true,code,unavailable_session_id:sessionId,recovery:'explicit_session_restore_required'}};
    pendingHealthNotices.set(event.source_key,event);
    if(!heartbeatRpc)return;
    try {await heartbeatRpc('timeline',{recent:{operation:'emit',sessionId:authoritySessionId,event}});pendingHealthNotices.delete(event.source_key);}
    catch { /* Keep a metadata-only pending notice for the next Host heartbeat. */ }
  }
  async function flushHealthNotices() {
    for(const event of pendingHealthNotices.values())await publishHealthNotice(event.payload.unavailable_session_id,event.payload.code);
  }
  const {mountLegacyHumanTimeline}=await import('./legacy-human-timeline.mjs');
  const remote={
    postHuman:input=>bridge?bridge.postHuman(input):Promise.reject(Object.assign(new Error('WORKER_NOT_READY'),{code:'WORKER_NOT_READY'})),
    actionResult:input=>bridge?bridge.actionResult(input):Promise.reject(Object.assign(new Error('WORKER_NOT_READY'),{code:'WORKER_NOT_READY'})),
  };
  timeline=await mountLegacyHumanTimeline({ctx,bridge:remote,lifeId:legacy.lifeId,authoritySessionId,roomId:marker.human_a_room_id,root:resolve(control,'legacy-human-timeline')});
  const facade=Object.freeze({
    status:()=>({enabled:true,...bridge?.status()??{ready:false,life_id:legacy.lifeId},timeline:timeline?.status()??null,room_inbox_controller:receiver?.status()??null,
      unavailable_activity_sessions:[...unavailableSessions.values()],health_notices_pending:[...pendingHealthNotices.values()].map(event=>({session_id:event.payload.unavailable_session_id,error_code:event.payload.code})),
      ...lastError?{error_code:lastError}:{}}),
    async recordHumanTurn(input){
      return timeline.recordHumanTurn(input);
    },
    inspect:args=>bridge?.inspect(args),
    async createTestSession(input) {
      if(!/^[a-f0-9-]{36}$/i.test(input.session_id??'')||input.session_id===authoritySessionId||typeof input.title!=='string'||!input.title.trim())throw new Error('Independent test Session required');
      if(testSessions.has(input.session_id))return {created:true,existing:true,life_id:legacy.lifeId,session_id:input.session_id};
      await ctx.personaTasks.create({sessionId:input.session_id,title:input.title});
      const resolved=await ctx.sessionController.resolveAgent(input.session_id);if(resolved.error)throw resolved.error;
      const credential=await credentialOperation('python','resolve',marker.worker_token_ref);
      const testBridge=await mountRoomWorker(ctx,{lifeId:legacy.lifeId,authoritySessionId:input.session_id,workspace:legacy.deployment.workspace,presetId:'persona',role:'activity',supervisorUrl:'http://127.0.0.1:'+marker.port,token:credential.value});
      const {mountRoomInbox}=await import('./legacy-room-inbox.mjs');
      const testReceiver=await mountRoomInbox({ctx,bridge:testBridge,lifeId:legacy.lifeId,authoritySessionId:input.session_id,
        root:resolve(control,'workers',legacy.lifeId,'test-inbox',input.session_id),initialPolicy:{human_idle:true,peer_idle:true,rest:false},batchLimit:20,debounceMs:500});
      testSessions.set(input.session_id,{bridge:testBridge,receiver:testReceiver});
      unavailableSessions.delete(input.session_id);
      testStore.add(input);
      return {created:true,life_id:legacy.lifeId,session_id:input.session_id,title:input.title};
    },
  });
  ctx.provide('lifeCommunication',facade);
  async function start() {
    if(starting||!bridge&&ctx.personaTasks.running().includes(authoritySessionId))return;
    starting=true;const existing=Boolean(bridge);
    try {
      if(bridge) {
        await flushHealthNotices();
        if(needsActivityResync) {
          const agent=ctx.agents.get(authoritySessionId),running=agent?.status==='running';
          await bridge.recordActivity({phase:running?(ctx.personaPrivateVault.isSensitive(agent.session)?'private':'thinking'):'idle'});
          needsActivityResync=false;
        }
        await timeline.drain();
        if(heartbeatRpc)await heartbeatRpc('heartbeat',{pid:process.pid,busy:ctx.personaTasks.running().length>0,
          session_ids:[authoritySessionId,...testSessions.keys()],version:'multi-life-p0-v2',...ctx.get('multiLifeWorkerMetrics')?.status()});
        return;
      }
      const credential=await credentialOperation('python','resolve',marker.worker_token_ref);
      if(!credential?.value)throw Object.assign(new Error('WORKER_CREDENTIAL_UNAVAILABLE'),{code:'WORKER_CREDENTIAL_UNAVAILABLE'});
      heartbeatRpc=createWorkerControlTransport('http://127.0.0.1:'+marker.port,legacy.lifeId,credential.value);
      bridge=await mountLegacyWorker(ctx,{lifeId:legacy.lifeId,authoritySessionId,workspace:legacy.deployment.workspace,presetId:legacy.deployment.presetId,
        supervisorUrl:'http://127.0.0.1:'+marker.port,token:credential.value});
      const {mountLegacyRoomInbox}=await import('./legacy-room-inbox.mjs');
      receiver=await mountLegacyRoomInbox({ctx,bridge,lifeId:legacy.lifeId,authoritySessionId,root:resolve(control,'legacy-room-inbox')});
      ctx.agents.get(authoritySessionId).ctx.systemPrompt.section({name:'life:peer-room-access',order:92,interpolate:false,
        text:'你与新生命的正式私聊目前允许用户作为明确的只读观察者查看聊天记录；他不是发言成员。没有固定聊天轮数上限，可以自由持续交流，也可自主延期、忽略、暂停或休息。私人 Memory、Vault 和思考不在聊天记录中。'});
      for(const row of testStore.list()) {
        // Each exact activity remains registered and keeps its original log.
        // An unavailable archive cannot take the healthy authority offline.
        try {await facade.createTestSession(row);}
        catch(error) {
          const code=errorCode(error,'LEGACY_ACTIVITY_SESSION_UNAVAILABLE');
          unavailableSessions.set(row.session_id,{session_id:row.session_id,error_code:code,restoration_state:'unavailable',recovery:'explicit_session_restore_required'});
          await publishHealthNotice(row.session_id,code);
        }
      }
      await bridge.recordActivity({phase:ctx.agents.get(authoritySessionId)?.status==='running'?'thinking':'idle'});await timeline.drain();lastError=null;
    }catch(error){lastError=errorCode(error,'LEGACY_COMMUNICATION_START_FAILED');await publishHealthNotice(authoritySessionId,lastError);if(!existing){receiver?.dispose();receiver=null;bridge?.dispose();bridge=null;}else needsActivityResync=true;}
    finally{starting=false;}
  }
  let activityChain=Promise.resolve();
  ctx.on('session/event',(session,event)=>{
    const eventBridge=session.id===authoritySessionId?bridge:testSessions.get(session.id)?.bridge;
    if(!eventBridge)return;
    const phase=({'turn/start':'thinking','tool/call':'tool','turn/end':'idle'})[event.type];if(!phase)return;
    activityChain=activityChain.then(()=>eventBridge.recordActivity({phase,...phase==='tool'?{toolName:event.data.name}:{}}))
      .catch(error=>{needsActivityResync=true;lastError=/^[A-Z_]+$/.test(error.code??'')?error.code:'LEGACY_ACTIVITY_REPORT_FAILED';});
  });
  await start();const timer=setInterval(()=>void start(),5000);
  ctx.effect(()=>async()=>{clearInterval(timer);receiver?.dispose();for(const r of testSessions.values()){r.receiver.dispose();await r.receiver.drain();r.bridge.dispose();}await receiver?.drain();await activityChain;await timeline.drain();bridge?.dispose();},'formal legacy Room and public activity channel');
  return facade;
}
