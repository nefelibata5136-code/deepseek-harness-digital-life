import {randomUUID} from 'node:crypto';
import {createUserMessage,freezeMessage} from '@deepseek-ai/dsh-llm';
import {fail} from './contracts.mjs';
import {nativeInboxEvidence} from './platform/inbox-recovery.mjs';
import {mountModernRouter} from '../subagent-router/modern.mjs';

// Trusted local control facade. Do not expose this object as a model tool or unauthenticated HTTP service.
export class LifeRuntime {
  #sessions=new Map();#maintenance=new Set();
  constructor({ctx,registry,contexts}){
    Object.assign(this,{ctx,registry,contexts});
    this.subagentReady=registry.mode==='production'?mountModernRouter(this):Promise.resolve(null);
    this.subagentReady.catch(()=>{});
  }
  #workerTarget(lifeId){if(this.workerLifeIds&&!this.workerLifeIds.has(lifeId))fail('LIFE_ROUTED_TO_OTHER_WORKER');}
  #setup(lifeId) {
    return async(agentCtx,agent)=>{
      const row=this.registry.assertTarget(lifeId,agent.session.id);
      this.registry.assertNative(agent.session.id,agent.session.header);
      this.contexts.bind(agent);
      await this.ctx.agentPresets.mount(agentCtx,row.presetId);
      if(row.role==='delegate') {
        const known=new Set(this.ctx.tools.schemas(agent).map(tool=>tool.name));
        agentCtx.tools.restrict({allow:['read','skill','fixture_identity','life_contact_list','life_event_read','life_session_list','life_session_read','memory_search','memory_open','memory_catalog','memory_pending','memory_status'].filter(name=>known.has(name))});
      }
      return {commit:()=>{this.contexts.forAgent(agent);}};
    };
  }
  async create({lifeId,sessionId=randomUUID(),role='activity',parentSessionId=null,parentTaskId,originRoomId,shared}) {
    await this.subagentReady;
    if(!lifeId)fail('EXPLICIT_LIFE_REQUIRED');
    this.#workerTarget(lifeId);
    const row=this.registry.reserve({lifeId,sessionId,role,parentSessionId});
    if(originRoomId)this.rooms?.assertMember(originRoomId,lifeId);
    this.tasks?.ensureSession({lifeId,sessionId,role,...parentTaskId!==undefined?{parentTaskId}:{},...originRoomId!==undefined?{originRoomId}:{},...shared!==undefined?{shared}:{}});
    return this.#serialize(sessionId,async()=>{
      if(this.ctx.agents.get(sessionId))return this.resolve({lifeId,sessionId});
      let observed;
      try {observed=await this.ctx.sessionQuery.observeSession(sessionId);}
      catch(error){if(error.code!=='SESSION_QUERY_SESSION_NOT_FOUND')throw error;}
      if(observed) {
        try {this.registry.assertNative(sessionId,observed.header,observed.projections?.values.agentPreset??observed.header.agentPreset);}
        finally {observed[Symbol.dispose]();}
        return this.#resume(lifeId,sessionId);
      }
      if(row.status==='ready')fail('OWNED_NATIVE_SESSION_MISSING');
      const m=this.registry.life(lifeId);
      let parentAgent;
      if(role==='delegate') {
        parentAgent=await this.resolve({lifeId,sessionId:parentSessionId});
        if((parentAgent.session.header.delegationDepth??0)>=1)fail('DELEGATION_DEPTH_EXCEEDED');
      }
      const handle=await this.ctx.agents.create({sessionId,...parentAgent?{parentAgent}:{},meta:{cwd:m.deployment.workspace,agentPreset:row.presetId,
        ...parentAgent?{parentSession:parentSessionId,origin:'subagent',delegationDepth:(parentAgent.session.header.delegationDepth??0)+1}:{}},
        agentOptions:{provider:m.deployment.provider,model:m.deployment.model,maxTokens:m.deployment.maxTokens??(this.registry.mode==='fixture'?1024:65536)},setup:this.#setup(lifeId)});
      await this.ctx.sessions.flush(handle.agent.session);
      this.registry.complete(sessionId,handle.agent.session.header);return handle.agent;
    });
  }
  async #resume(lifeId,sessionId) {
    const row=this.registry.assertTarget(lifeId,sessionId),m=this.registry.life(lifeId);
    const observation=await this.ctx.sessionQuery.observeSession(sessionId);
    try {
      if(!observation.projections||typeof observation.projections.values.agentPreset!=='string')fail('NATIVE_PRESET_PROJECTION_REQUIRED');
      this.registry.assertNative(sessionId,observation.header,observation.projections.values.agentPreset);
    }finally{observation[Symbol.dispose]();}
    const parentAgent=row.role==='delegate'?await this.resolve({lifeId,sessionId:row.parentSessionId}):undefined;
    const handle=await this.ctx.agents.resume({resumeSessionId:sessionId,...parentAgent?{parentAgent}:{},
      agentOptions:{provider:m.deployment.provider,model:m.deployment.model,maxTokens:m.deployment.maxTokens??(this.registry.mode==='fixture'?1024:65536)},setup:this.#setup(lifeId)});
    await this.ctx.sessions.flush(handle.agent.session);
    this.registry.complete(sessionId,handle.agent.session.header,row.presetId);return handle.agent;
  }
  async resolve({lifeId,sessionId}) {
    if(!lifeId)fail('EXPLICIT_LIFE_REQUIRED');this.#workerTarget(lifeId);this.registry.assertTarget(lifeId,sessionId);
    const agent=this.ctx.agents.get(sessionId);
    if(agent){this.contexts.forAgent(agent);return agent;}
    return this.#serialize(sessionId,()=>{
      const existing=this.ctx.agents.get(sessionId);
      if(existing){this.contexts.forAgent(existing);return existing;}
      return this.#resume(lifeId,sessionId);
    });
  }
  async delegate(context,args) {
    const c=this.contexts.require(context),router=await this.subagentReady;
    if(!router)return this.delegateDeepseek(context,args);
    const parent=await this.resolve({lifeId:c.lifeId,sessionId:c.sessionId});
    return router.start(parent,{...args,run_in_background:args.run_in_background??true});
  }
  async delegateDeepseek(context,{task,sessionId=randomUUID()}) {
    const c=this.contexts.require(context);if(typeof task!=='string'||!task.trim())fail('SELF_CONTAINED_DELEGATION_REQUIRED');
    const parent=this.tasks?.forSession(c.sessionId)??this.tasks?.ensureSession({lifeId:c.lifeId,sessionId:c.sessionId,role:c.role});
    const agent=await this.create({lifeId:c.lifeId,sessionId,role:'delegate',parentSessionId:c.sessionId,...parent?{parentTaskId:parent.task_id,originRoomId:parent.origin_room_id,shared:parent.shared}:{}});
    const requestId=randomUUID();await this.#admit({lifeId:c.lifeId,sessionId,requestId,content:[{type:'text',text:task}],signal:new AbortController().signal,
      source:{kind:'delegated-task',rpcId:requestId,ownerLifeId:c.lifeId,parentSessionId:c.sessionId,parentTaskId:parent?.task_id??null,sender:{sender_id:c.lifeId,sender_type:'life',life_id:c.lifeId,display_name:c.manifest.displayName??null}}});
    return {lifeId:c.lifeId,owner_life_id:c.lifeId,sessionId,parentSessionId:c.sessionId,requestId,...this.tasks?this.tasks.forSession(sessionId):{},identity:'temporary-delegated-worker',agent};
  }
  async prompt({lifeId,sessionId,requestId,content,sender=null,sourceKind='user',signal=new AbortController().signal}) {
    if(sender){const trusted=this.rooms?.principal(sender.sender_id);if(!trusted||JSON.stringify(trusted)!==JSON.stringify(sender))fail('TRUSTED_SENDER_REQUIRED');}
    return this.#admit({lifeId,sessionId,requestId,content,signal,source:{kind:sourceKind,rpcId:requestId,sender:sender??{sender_id:null,sender_type:'unknown',life_id:null,display_name:null},clientTimeZone:'Asia/Shanghai'}});
  }
  isLifeBusy(lifeId,exceptSessionId=null) {
    return this.registry.sessions(lifeId).some(row=>row.role!=='delegate'&&row.sessionId!==exceptSessionId&&(this.#maintenance.has(row.sessionId)||this.ctx.agents.get(row.sessionId)?.status==='running'));
  }
  async roomDeliveryEvidence({lifeId,sessionId,requestId}) {
    try{this.registry.assertTarget(lifeId,sessionId);}catch(error){if(error.code==='UNKNOWN_SESSION_OWNER')return 'absent';throw error;}
    let observation;try{observation=await this.ctx.sessionQuery.observeSession(sessionId,{projectionMode:'all'});}catch(error){if(error.code==='SESSION_QUERY_SESSION_NOT_FOUND')return 'absent';throw error;}
    try {
      this.registry.assertNative(sessionId,observation.header,observation.projections?.values.agentPreset??observation.header.agentPreset);
      const inbox=observation.projections?.values.inbox,events=[...observation.events];
      if([...inbox?.['next-turn']??[],...inbox?.['next-step']??[]].some(m=>m.source?.rpcId===requestId))return 'pending';
      if(events.some(e=>e.type==='user/message'&&e.data.source?.rpcId===requestId))return 'materialized';
      return events.some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.source?.rpcId===requestId))?'ambiguous':'absent';
    }finally{observation[Symbol.dispose]();}
  }
  async roomAttemptEvidence({lifeId,sessionId,requestId,durableBeforeModel=false}) {
    this.registry.assertTarget(lifeId,sessionId);const observation=await this.ctx.sessionQuery.observeSession(sessionId,{projectionMode:'all'});
    try{this.registry.assertNative(sessionId,observation.header,observation.projections?.values.agentPreset??observation.header.agentPreset);const inbox=observation.projections?.values.inbox;
      return nativeInboxEvidence({events:[...observation.events],pending:[...inbox?.['next-turn']??[],...inbox?.['next-step']??[]],requestId,
        running:this.ctx.agents.get(sessionId)?.status==='running',durableBeforeModel});
    }finally{observation[Symbol.dispose]();}
  }
  async consumeRoomMessage({lifeId,sessionId,nativeMessage,authorize,onAdmitted,signal}) {
    const agent=await this.resolve({lifeId,sessionId});signal.throwIfAborted();
    const source=nativeMessage.source;
    if(source?.kind!=='room-inbox'||source.receiverLifeId!==lifeId||typeof authorize!=='function'||typeof onAdmitted!=='function')fail('TRUSTED_ROOM_DELIVERY_REQUIRED');
    if(this.isLifeBusy(lifeId)||this.#maintenance.has(sessionId))fail('LIFE_BUSY');
    this.#maintenance.add(sessionId);
    try {
      const job=()=>agent.runMaintenance(async maintenanceSignal=>{
        authorize();this.contexts.forAgent(agent);maintenanceSignal.throwIfAborted();
        if(this.isLifeBusy(lifeId,sessionId))fail('LIFE_BUSY');
        const message=freezeMessage(structuredClone(nativeMessage));
        try {
          // Recovery may find this exact envelope still pending. Re-arm only
          // under a still-explicit receiver choice, without duplicating it.
          agent.inbox.remove(message.id);agent.send(message,'next-turn',true);
          await this.ctx.sessions.flush(agent.session);authorize();maintenanceSignal.throwIfAborted();onAdmitted();
          return {accepted:true,lifeId,sessionId,requestId:source.rpcId,nativeMessageId:message.id};
        }catch(error) {
          // runMaintenance's finally can wake after a throw. Remove this exact
          // item first so failed flush/CAS/revocation never starts a hidden turn.
          agent.inbox.remove(message.id);await this.ctx.sessions.flush(agent.session);throw error;
        }
      });
      try{return await job();}catch(error){if(/already has active work/.test(error.message))fail('LIFE_BUSY');throw error;}
    }finally{this.#maintenance.delete(sessionId);}
  }
  async #admit({lifeId,sessionId,requestId,content,source,authorize,signal}) {
    if(!lifeId)fail('EXPLICIT_LIFE_REQUIRED');
    if(!requestId||!Array.isArray(content))fail('EXPLICIT_REQUEST_REQUIRED');
    if(!content.length||content.some(b=>b.type!=='text'||typeof b.text!=='string'||!b.text.trim()))fail('TEXT_ONLY_INGRESS_RELEASED');
    this.registry.assertTarget(lifeId,sessionId);
    const agent=await this.resolve({lifeId,sessionId});signal.throwIfAborted();
    return this.#serialize(sessionId,async()=>{
      signal.throwIfAborted();
      if(this.ctx.agents.get(sessionId)!==agent)fail('LIFE_AGENT_NOT_LIVE');
      authorize?.();
      const previous=[...agent.session.ownEvents()].some(e=>
        e.type==='user/message'&&e.data.source?.rpcId===requestId||
        e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.source?.rpcId===requestId));
      if(previous)return {accepted:true,duplicate:true,lifeId,sessionId,requestId};
      this.contexts.forAgent(agent);
      agent.followup(createUserMessage({content,source}));
      await this.ctx.sessions.flush(agent.session);
      return {accepted:true,lifeId,sessionId,requestId};
    });
  }
  async events({lifeId,sessionId}) {
    if(!lifeId)fail('EXPLICIT_LIFE_REQUIRED');
    this.registry.assertTarget(lifeId,sessionId);const observation=await this.ctx.sessionQuery.observeSession(sessionId);
    try {this.registry.assertNative(sessionId,observation.header,observation.projections?.values.agentPreset??observation.header.agentPreset);return [...observation.events];}
    finally {observation[Symbol.dispose]();}
  }
  cancel({lifeId,sessionId}) {
    if(!lifeId)fail('EXPLICIT_LIFE_REQUIRED');
    this.registry.assertTarget(lifeId,sessionId);const agent=this.ctx.agents.get(sessionId);
    if(agent){this.contexts.forAgent(agent);agent.cancel({kind:'user'});}
  }
  #serialize(sessionId,operation) {
    const result=(this.#sessions.get(sessionId)??Promise.resolve()).then(operation);
    this.#sessions.set(sessionId,result.then(()=>{},()=>{}));return result;
  }
}
