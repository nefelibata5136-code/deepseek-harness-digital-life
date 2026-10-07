import {DigitalLifeStore} from '../../digital-life/store.mjs';
import {collectAttention} from '../../digital-life/attention.mjs';
import {createFileLocks} from '../../../workspace_foundation/file-operation-locks.mjs';
import {canonical,fail} from '../contracts.mjs';
import {resolve} from 'node:path';
import {assertOwnerPath} from './paths.mjs';
import {LifeDocuments} from './documents.mjs';
import {createOwnerSchedule,guardScheduleDeliveryTarget} from './schedule.mjs';
export {guardScheduleDeliveryTarget} from './schedule.mjs';

// Host-only factory; capabilities obtain an opaque execution context per call.
// Store instances and in-flight initialization are cached once per owner/root.
export function createLifeServices({contexts,schedule,tasks,locks,now=()=>Date.now(),authorityPolicy}) {
  const stores=new Map(),rootOwners=new Map(),ticks=new Map(),failures=new Map(),wakeFacts=new Map();
  const ownedLocks=!locks;if(!locks)locks=createFileLocks();
  let disposed=false;
  const require=(c,operation=false)=>{
    if(disposed)fail('LIFE_SERVICES_DISPOSED');c=contexts.require(c);
    if(operation&&c.role!=='authority') {
      // Only the trusted composition can preserve an explicit legacy permission.
      // Independent lives remain strict even if a caller supplies a broad policy.
      if(c.manifest.kind!=='legacy'||typeof authorityPolicy!=='function'||authorityPolicy(c,operation)!==true)contexts.requireAuthority(c);
    }
    return c;
  };
  const documents=new LifeDocuments({contexts,locks,now,requireAuthority:require});
  const ownerSchedule=createOwnerSchedule({contexts,schedule});
  const identity=c=>({identity:c.lifeId,lifeId:c.lifeId,displayName:c.manifest.displayName??null});
  const provenance=c=>{if(!c.callId)fail('OWN_CALL_PROVENANCE_REQUIRED');return {sessionId:c.sessionId,callId:c.callId};};
  async function prepareStore(lifeId) {
    // Trusted preset composition only, before a newly created Agent is live.
    // Domain tools and the preset MUST share this single state writer.
    if(disposed)fail('LIFE_SERVICES_DISPOSED');
    const manifest=contexts.registry.life(lifeId),root=canonical(manifest.deployment.state),oldOwner=rootOwners.get(root);
    if(oldOwner&&oldOwner!==lifeId)fail('STATE_ROOT_OWNER_COLLISION');
    rootOwners.set(root,lifeId);
    let entry=stores.get(lifeId);
    if(entry&&(entry.root!==root||entry.revision!==manifest.revision))fail('STATE_BINDING_CHANGED_REQUIRES_REMOUNT');
    if(!entry){entry={root,revision:manifest.revision,promise:new DigitalLifeStore(root,{now}).init()};stores.set(lifeId,entry);}
    const store=await entry.promise;
    if(disposed||contexts.registry.life(lifeId).revision!==manifest.revision)fail('STATE_BINDING_CHANGED_REQUIRES_REMOUNT');
    return store;
  }
  async function storeFor(context) {
    const c=require(context);assertOwnerPath(contexts,c,c.manifest.deployment.state);
    const store=await prepareStore(c.lifeId);require(c);return store;
  }
  const ownsSession=(lifeId,sessionId)=>{try{return contexts.registry.owner(sessionId).lifeId===lifeId;}catch{return false;}};
  function tasksFor(c) {
    if(!tasks)return {running:()=>[],list:async()=>[]};
    return {running:()=>tasks.running().filter(id=>ownsSession(c.lifeId,id)),
      list:async()=>{const rows=await tasks.list();require(c);return rows.filter(row=>ownsSession(c.lifeId,row.sessionId));}};
  }
  const api={
    documents,schedule:ownerSchedule,prepareStore,
    async status(context) {
      const c=require(context),state=await (await storeFor(c)).status();require(c);
      return {...state,...identity(c),authoritySessionId:c.manifest.authoritySessionId,
        failure:failures.get(c.lifeId)?.code??failures.get(c.lifeId)?.message??null};
    },
    async readMental(context) {const c=require(context),value=await (await storeFor(c)).readMental(now());require(c);return {lifeId:c.lifeId,mental:value};},
    async writeMental(context,{text,expiresAt}) {const c=require(context,'mental:write');return (await storeFor(c)).writeMental({text,expiresAt,...provenance(c)});},
    async configure(context,patch) {
      const c=require(context,'resident:configure');
      // Sampling consent needs native own-call evidence; it is not accepted here.
      for(const key of Object.keys(patch))if(!['residentEnabled','intervalMs','directive'].includes(key))fail('UNSUPPORTED_LIFE_SETTING');
      provenance(c);return (await storeFor(c)).configure(patch);
    },
    async listPending(context,options) {
      const c=require(context),page=await (await storeFor(c)).listPending(options);require(c);
      const items=page.items.filter(row=>ownsSession(c.lifeId,row.sourceSessionId));
      return {...page,items,suppressedUnknownOwners:page.items.length-items.length,lifeId:c.lifeId};
    },
    async appendPending(context,input) {
      const c=require(context);if(input.sourceSessionId!==c.sessionId)fail('PENDING_SOURCE_OWNER_MISMATCH');
      return (await storeFor(c)).appendPending(input);
    },
    async resolvePending(context,input) {
      const c=require(context,'pending:resolve'),store=await storeFor(c),record=store.pending.find(row=>row.id===input.id);
      if(record&&!ownsSession(c.lifeId,record.sourceSessionId))fail('PENDING_SOURCE_OWNER_MISMATCH');
      return store.resolvePending({...input,...provenance(c)});
    },
    async attention(context,agent,{limit=12,maxBytes=2400}={}) {
      const c=require(context,'resident:attention');if(contexts.forAgent(agent).sessionId!==c.sessionId)fail('ATTENTION_AGENT_MISMATCH');
      for(const name of ['memory/continuity.md','development/wants.md'])assertOwnerPath(contexts,c,resolve(c.manifest.deployment.workspace,name));
      const result=await collectAttention({agent,workspace:c.manifest.deployment.workspace,
        store:{listPending:async options=>{const page=await api.listPending(c,options);return {...page,total:page.total??page.items.length};}},schedule:{list:options=>ownerSchedule.list(c,options)},
        tasks:{running:tasksFor(c).running,list:async()=>{const rows=await tasksFor(c).list();return rows.map(row=>({...row,primary:row.role==='authority',title:row.title??row.role??'owned activity'}));}},limit,maxBytes});
      require(c);return {...result,lifeId:c.lifeId};
    },
    // Caller mounts into native pre-step once. Never installs a second loop.
    async snapshotFor(context,{admitWake=false}={}) {
      const c=require(context,admitWake?'resident:wake':false),store=await storeFor(c),state=await store.state(),at=now();
      const previous=state.clock.lastWakeAt,elapsedMs=previous?Math.max(0,at-Date.parse(previous)):null;
      const facts={now:new Date(at).toISOString(),timeZone:'Asia/Shanghai',previousWakeAt:previous,elapsedMs,
        possibleWakeWindowsPassed:elapsedMs===null?null:Math.floor(elapsedMs/state.settings.intervalMs),missedWakesAreNotReplayed:true};
      const [core,continuity,mental,pending]=await Promise.all([documents.read(c,'core'),documents.read(c,'continuity'),api.readMental(c),api.listPending(c,{limit:20})]);
      require(c,admitWake?'resident:wake':false);
      if(admitWake){await store.saveClock({lastWakeAt:facts.now,nextWakeAt:new Date(at+state.settings.intervalMs).toISOString(),lastOutcome:'interrupted'});wakeFacts.set(c.lifeId,facts);}
      return {...identity(c),core,continuity,mental:mental.mental,pending,settings:state.settings,time:facts,clock:state.clock};
    },
    async rest(context,{nextWakeAt,reason,signal}={}) {
      const c=require(context,'resident:rest'),store=await storeFor(c),settings=await store.settings();let wake;
      if(nextWakeAt){const at=Date.parse(nextWakeAt);if(!Number.isFinite(at)||at<=now()||!reason?.trim()||reason.length>8000)fail('SELF_WAKE_REQUIRES_FUTURE_TIME_AND_REASON');
        wake=await ownerSchedule.create(c,{title:'Resident：本人安排的下次醒来',at:new Date(at).toISOString(),prompt:'[Resident self-wake]\n本人留下的原因与接续：'+reason+'\n可以继续、改变主意或休息。'},signal);}
      require(c,'resident:rest');await store.saveClock({lastRestAt:new Date(now()).toISOString(),lastOutcome:'rest',
        nextWakeAt:new Date(Math.max(now()+settings.intervalMs,wake?Date.parse(wake.scheduledAt)+settings.intervalMs:0)).toISOString()});
      return {lifeId:c.lifeId,sessionId:c.sessionId,resting:true,noActionIsSuccess:true,...(wake?{scheduleId:wake.id,nextWakeAt:wake.scheduledAt}:{})};
    },
    async recordTurnEnd(context,{at,reason}) {
      const c=require(context,'resident:turn-end'),store=await storeFor(c),state=await store.state();
      return store.saveClock({lastRestAt:at,lastOutcome:reason==='completed'?(state.clock.lastOutcome==='rest'?'rest':'completed'):'interrupted'});
    },
    wakeFacts(context){const c=require(context);return structuredClone(wakeFacts.get(c.lifeId)??null);},
    // Explicit trusted Host invocation. No timer and no implicit all-life task.
    tick({lifeId,runtime,admit=async()=>({allowed:false}),isRunning=()=>false,signal=new AbortController().signal}) {
      if(disposed)fail('LIFE_SERVICES_DISPOSED');
      if(ticks.has(lifeId))return ticks.get(lifeId);
      const run=(async()=>{
        const manifest=contexts.registry.life(lifeId);guardScheduleDeliveryTarget(contexts.registry,manifest.authoritySessionId);
        if(isRunning(manifest.authoritySessionId))return {lifeId,delivered:false,reason:'authority-active'};
        const agent=await runtime.resolve({lifeId,sessionId:manifest.authoritySessionId});
        const c=contexts.execution(agent,{costCategory:'resident'});require(c);contexts.requireAuthority(c);
        const store=await storeFor(c),state=await store.state(),due=state.clock.nextWakeAt;
        if(!state.settings.residentEnabled||!due||now()<Date.parse(due))return {lifeId,delivered:false,reason:'not-due-or-disabled'};
        signal.throwIfAborted();const budget=await admit(c,signal);require(c);contexts.requireAuthority(c);
        if(budget?.allowed!==true)return {lifeId,delivered:false,reason:'admission-denied'};
        const admitted=await store.state();require(c);contexts.requireAuthority(c);signal.throwIfAborted();
        if(!admitted.settings.residentEnabled||admitted.clock.nextWakeAt!==due||now()<Date.parse(due)||isRunning(c.sessionId)) {
          if(typeof budget.release==='function')await budget.release();
          return {lifeId,delivered:false,reason:'wake-changed-during-admission'};
        }
        const requestId='resident:'+lifeId+':'+due;
        const result=await runtime.prompt({lifeId,sessionId:c.sessionId,requestId,signal,sourceKind:'resident-wake',content:[{type:'text',text:
          '周期性睁眼。看看实际经过的时间、自己亲写的心境和接续条，再决定是否行动。可以拒绝、改变兴趣或直接休息；什么都不做也是完整结果。'}]});
        require(c);contexts.requireAuthority(c);const current=await store.state();
        if(current.clock.nextWakeAt===due)await store.saveClock({nextWakeAt:new Date(now()+current.settings.intervalMs).toISOString()});
        failures.delete(lifeId);return {lifeId,delivered:true,requestId,...result};
      })().catch(error=>{failures.set(lifeId,error);throw error;}).finally(()=>ticks.delete(lifeId));
      ticks.set(lifeId,run);return run;
    },
    dispose(){disposed=true;if(ownedLocks)locks.dispose();},
  };
  return api;
}
