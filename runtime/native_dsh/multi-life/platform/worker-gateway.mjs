import {createHash,timingSafeEqual} from 'node:crypto';
import {canonical,copy,freeze,fail} from '../contracts.mjs';
import {SocialCommunication,socialView} from './social.mjs';

const digest=value=>createHash('sha256').update(value).digest();
const invalidDigest=digest('unbound-worker');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const fields=(value,allowed)=>{if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('WORKER_ARGUMENT_SCOPE_INVALID');};
const senderFields=['lifeId','life_id','owner_life_id','sender','senderPrincipalId','sender_id','sender_type','display_name',
  'originSessionId','origin_session_id','originTaskId','origin_task_id','timestamp','sentAt'];
function roomArgs(args,allowed) {
  if(!object(args))fail('WORKER_ARGUMENT_SCOPE_INVALID');
  if(senderFields.some(key=>Object.hasOwn(args,key)))fail('SENDER_IS_HOST_BOUND');
  fields(args,allowed);return copy(args);
}

// Trusted Host protocol only. The handle derives authority from the worker's
// private binding, never JSON, native cwd, message text or an ambient Agent.
// This gateway writes control metadata/Rooms only: no native Session opening,
// prompt, wakeup, Memory, Vault, browser account or credential operation.
export class WorkerGateway {
  #registry;#rooms;#tasks;#activity;#bindings=new Map();#handles=new WeakMap();
  constructor({registry,rooms,tasks,activity,workerBindings}) {
    if(typeof registry?.life!=='function'||rooms?.contexts?.registry!==registry||tasks?.contexts?.registry!==registry||
      ['postForLife','inboxForLife','decideForLife','listForPrincipal','readForPrincipal'].some(name=>typeof rooms[name]!=='function')||
      typeof tasks?.ensureSession!=='function'||typeof tasks?.forSession!=='function'||!(workerBindings instanceof Map))fail('TRUSTED_WORKER_GATEWAY_REQUIRED');
    this.#registry=registry;this.#rooms=rooms;this.#tasks=tasks;this.#activity=activity;
    for(const [lifeId,binding] of workerBindings) {
      fields(binding,['token','allowedPresetId','humanPrincipalId']);const manifest=registry.life(lifeId);
      if(typeof binding.token!=='string'||binding.token.length<16||binding.token.length>4096||binding.allowedPresetId!==manifest.deployment.presetId)fail('WORKER_BINDING_INVALID');
      const tokenDigest=digest(binding.token);
      if([...this.#bindings.values()].some(previous=>timingSafeEqual(previous.tokenDigest,tokenDigest)))fail('WORKER_TOKEN_MUST_BE_OWNER_UNIQUE');
      if(binding.humanPrincipalId!==undefined&&(!identifier(binding.humanPrincipalId)||!binding.humanPrincipalId.startsWith('human:')))fail('EXPLICIT_HUMAN_CHANNEL_REQUIRED');
      this.#bindings.set(lifeId,{tokenDigest,presetId:binding.allowedPresetId,humanPrincipalId:binding.humanPrincipalId??null});
    }
  }
  authenticate(request) {
    fields(request,['lifeId','token']);
    const binding=this.#bindings.get(request.lifeId),token=typeof request.token==='string'&&request.token.length<=4096?request.token:'';
    const matches=timingSafeEqual(digest(token),binding?.tokenDigest??invalidDigest);
    if(!binding||!matches)fail('WORKER_AUTHENTICATION_FAILED');
    this.#registry.life(request.lifeId);
    const handle=Object.freeze(Object.create(null));this.#handles.set(handle,{lifeId:request.lifeId,presetId:binding.presetId,humanPrincipalId:binding.humanPrincipalId});return handle;
  }
  #binding(handle) {
    const binding=object(handle)?this.#handles.get(handle):undefined;if(!binding)fail('WORKER_AUTHENTICATION_FAILED');
    const manifest=this.#registry.life(binding.lifeId);
    if(manifest.deployment.presetId!==binding.presetId)fail('WORKER_PRESET_BINDING_CHANGED');
    return {...binding,manifest};
  }
  #task(row) {
    const existing=this.#tasks.forSession(row.sessionId);if(existing)return existing;
    if(row.role==='delegate') {
      const parent=this.#registry.assertTarget(row.lifeId,row.parentSessionId),parentTask=this.#task(parent);
      return this.#tasks.ensureSession({lifeId:row.lifeId,sessionId:row.sessionId,role:row.role,parentTaskId:parentTask.task_id,
        originRoomId:parentTask.origin_room_id,shared:parentTask.shared});
    }
    return this.#tasks.ensureSession({lifeId:row.lifeId,sessionId:row.sessionId,role:row.role});
  }
  registerSession(handle,input) {
    fields(input,['header','presetId','role','parentSessionId','sourceSessionId','legacyHeaderPresetAbsentVerified']);
    const binding=this.#binding(handle),{manifest}=binding,{presetId,role,parentSessionId=null,sourceSessionId=null,legacyHeaderPresetAbsentVerified=false}=input;
    fields(input.header,['version','id','cwd','createdAt','agentPreset','parentSession','isSeeded','origin','delegationDepth']);const header=copy(input.header);
    if(!identifier(header.id)||!Number.isSafeInteger(header.createdAt)||header.createdAt<0||
      header.version!==undefined&&header.version!==4||typeof legacyHeaderPresetAbsentVerified!=='boolean'||
      header.isSeeded!==undefined&&typeof header.isSeeded!=='boolean'||header.origin!==undefined&&header.origin!=='subagent'||
      header.delegationDepth!==undefined&&(!Number.isSafeInteger(header.delegationDepth)||header.delegationDepth<0)||
      header.parentSession!==undefined&&!identifier(header.parentSession)||
      !['authority','activity','delegate'].includes(role)||presetId!==binding.presetId||canonical(header.cwd)!==canonical(manifest.deployment.workspace))fail('WORKER_SESSION_HEADER_MISMATCH');
    if(header.agentPreset===undefined) {
      if(!legacyHeaderPresetAbsentVerified||manifest.kind!=='legacy'&&this.#registry.mode!=='fixture')fail('EXPLICIT_LEGACY_PRESET_VERIFICATION_REQUIRED');
    }else if(header.agentPreset!==presetId||legacyHeaderPresetAbsentVerified)fail('WORKER_SESSION_HEADER_MISMATCH');
    if(role==='authority'&&header.id!==manifest.authoritySessionId||role!=='authority'&&header.id===manifest.authoritySessionId)fail('WORKER_SESSION_ROLE_MISMATCH');
    if(role==='delegate') {
      if(!identifier(parentSessionId)||header.parentSession!==parentSessionId||header.origin!=='subagent'||
        !Number.isSafeInteger(header.delegationDepth)||header.delegationDepth<1)fail('WORKER_SESSION_LINEAGE_INVALID');
      if(this.#registry.assertTarget(binding.lifeId,parentSessionId).status!=='ready')fail('WORKER_PARENT_SESSION_NOT_READY');
    }else if(sourceSessionId!==null){if(role!=='activity'||parentSessionId!==null||!identifier(sourceSessionId)||header.parentSession!==sourceSessionId||header.isSeeded!==true||(header.delegationDepth??0)!==0||header.origin==='subagent')fail('WORKER_SESSION_LINEAGE_INVALID');this.#registry.assertTarget(binding.lifeId,sourceSessionId);}
    else if(parentSessionId!==null||header.parentSession||(header.delegationDepth??0)!==0||header.origin==='subagent'||header.isSeeded===true)fail('WORKER_SESSION_LINEAGE_INVALID');
    // Metadata reservation/completion never claims the worker's writable native
    // Session. complete also checks any previously verified incarnation hash.
    this.#registry.reserve({lifeId:binding.lifeId,sessionId:header.id,role,parentSessionId,sourceSessionId,legacyHeaderPresetAbsentVerified});
    const row=this.#registry.complete(header.id,header,presetId),task=this.#task(row);
    return freeze({life_id:binding.lifeId,session_id:row.sessionId,preset_id:row.presetId,role:row.role,status:row.status,origin_task_id:task.task_id});
  }
  #session(handle,sessionId,decision=false) {
    const binding=this.#binding(handle);if(!identifier(sessionId))fail('WORKER_REGISTERED_SESSION_REQUIRED');
    const row=this.#registry.assertTarget(binding.lifeId,sessionId);if(row.status!=='ready')fail('WORKER_SESSION_NOT_READY');
    if(row.role==='delegate')fail(decision?'DELEGATE_INBOX_DECISION_DENIED':'DELEGATE_SOCIAL_SEND_DENIED');
    return {lifeId:binding.lifeId,sessionId,task:this.#task(row)};
  }
  post(handle,input) {
    fields(input,['sessionId','args','occurredAt']);const args=roomArgs(input.args,['room_id','conversationId','body','reply_to','replyTo','message_id','messageId']);
    const {lifeId,sessionId}=this.#session(handle,input.sessionId);return this.#rooms.postForLife({lifeId,sessionId,args,occurredAt:input.occurredAt});
  }
  inbox(handle,args={}) {
    fields(args,['after','limit','includeTerminal','includeUnsettledTerminal','sessionId','executionOnly']);const {lifeId}=this.#binding(handle);
    if(args.sessionId!==undefined)this.#session(handle,args.sessionId,true);
    if(args.executionOnly!==undefined&&typeof args.executionOnly!=='boolean'||args.executionOnly===true&&args.sessionId===undefined)fail('SCHEDULER_SESSION_REQUIRED');
    this.#rooms.refreshDeferred({lifeId});return this.#rooms.inboxForLife({...copy(args),lifeId});
  }
  decide(handle,input) {
    fields(input,['sessionId','args']);const args=roomArgs(input.args,['inbox_id','decision_token','message_ref','action','expectedRevision','expected_revision','until','body','message_id','reply_message_id']);
    if(args.expected_revision!==undefined) {
      if(args.expectedRevision!==undefined&&args.expectedRevision!==args.expected_revision)fail('WORKER_ARGUMENT_ALIAS_CONFLICT');
      args.expectedRevision=args.expected_revision;delete args.expected_revision;
    }
    const {lifeId,sessionId,task}=this.#session(handle,input.sessionId,true);
    return this.#rooms.decideForLife({...args,lifeId,originSessionId:sessionId,originTaskId:task.task_id});
  }
  list(handle) {return this.#rooms.listForPrincipal(this.#binding(handle).lifeId);}
  read(handle,args) {
    const value=roomArgs(args,['room_id','conversationId','after','limit']);return this.#rooms.readForPrincipal(this.#binding(handle).lifeId,value);
  }
  timeline(handle,args={}) {
    if(Object.hasOwn(args,'social')) {
      fields(args,['social']);const input=args.social;fields(input,['operation','sessionId','args','callId']);
      const owner=this.#session(handle,input.sessionId,true),social=new SocialCommunication(this.#rooms);
      if(input.operation==='speak')return social.speak(owner,input.args,input.callId);
      if(input.operation==='contacts')return social.contacts(owner,input.args);
      if(input.operation==='read')return social.read(owner,input.args);
      if(input.operation==='messages')return social.messages(owner,input.args);
      if(input.operation==='result')return social.result(owner,input.args);
      if(input.operation==='decide')return social.decide(owner,input.args);
      fail('UNKNOWN_SOCIAL_OPERATION');
    }
    if(Object.hasOwn(args,'action_result')) {
      fields(args,['action_result']);const input=args.action_result;
      fields(input,['sessionId','message_id','room_id','reply_to','inbox_id']);
      const owner=this.#session(handle,input.sessionId,true);
      return this.#rooms.actionResultForLife({...owner,...copy(input)});
    }
    if(Object.hasOwn(args,'recent')) {
      fields(args,['recent']);const input=args.recent;
      fields(input,['operation','sessionId','wake_id','cutoff_at_utc','trigger_messages','event','batch_id','result','turn','turn_status','error_code','request_id','after','limit']);
      const owner=this.#session(handle,input.sessionId,true);
      return this.#rooms.recentEvents.call(owner,input);
    }
    fields(args,['after','limit']);return this.#rooms.timelineForPrincipal(this.#binding(handle).lifeId,copy(args));
  }
  observe(handle,args) {
    fields(args,['life_id']);this.#binding(handle);
    if(!this.#activity)fail('PUBLIC_ACTIVITY_NOT_MOUNTED');return this.#activity.read(args.life_id);
  }
  activity(handle,input) {
    fields(input,['sessionId','args']);fields(input.args,['text','visibility','expiresAt']);
    const {lifeId,sessionId}=this.#session(handle,input.sessionId);
    if(!this.#activity)fail('PUBLIC_ACTIVITY_NOT_MOUNTED');
    return this.#activity.publishForLife({lifeId,sessionId,args:copy(input.args)});
  }
  activityEvent(handle,input) {
    fields(input,['sessionId','phase','toolName']);const {lifeId,sessionId}=this.#session(handle,input.sessionId);
    if(!this.#activity)fail('PUBLIC_ACTIVITY_NOT_MOUNTED');
    return this.#activity.recordHost({lifeId,sessionId,phase:input.phase,...input.toolName===undefined?{}:{toolName:input.toolName}});
  }
  // This operation is exposed only to the protected worker Host. Its human
  // principal is configured when the channel is bound, never supplied by tools.
  humanMessage(handle,input) {
    fields(input,['args','principalId','occurredAt']);const binding=this.#binding(handle);
    if(!binding.humanPrincipalId||input.principalId!==binding.humanPrincipalId)fail('HUMAN_CHANNEL_BINDING_MISMATCH');
    const args=roomArgs(input.args,['room_id','conversationId','body','reply_to','replyTo','message_id','messageId']);
    const roomId=args.room_id??args.conversationId;
    this.#rooms.assertMember(roomId,binding.lifeId);
    return this.#rooms.recordHumanTimeline({principalId:binding.humanPrincipalId,lifeId:binding.lifeId,
      sessionId:this.#registry.life(binding.lifeId).authoritySessionId,requestId:args.message_id??args.messageId,args,occurredAt:input.occurredAt});
  }
  selectDelivery(handle,input) {
    fields(input,['sessionId','inbox_id','expectedRevision']);const {lifeId,sessionId}=this.#session(handle,input.sessionId,true);
    return this.#rooms.selectWorkerDelivery({lifeId,sessionId,inbox_id:input.inbox_id,expectedRevision:input.expectedRevision});
  }
  authorizeDelivery(handle,input) {
    fields(input,['sessionId','inbox_id','attempt_id']);const {lifeId,sessionId}=this.#session(handle,input.sessionId,true);
    return this.#rooms.authorizeWorkerDelivery({lifeId,sessionId,inbox_id:input.inbox_id,attempt_id:input.attempt_id});
  }
  acknowledgeDelivery(handle,input) {
    fields(input,['sessionId','inbox_id','attempt_id','native_state']);const {lifeId,sessionId}=this.#session(handle,input.sessionId,true);
    if(!['pending','materialized'].includes(input.native_state))fail('NATIVE_DELIVERY_EVIDENCE_REQUIRED');
    return this.#rooms.acknowledgeWorkerDelivery({lifeId,sessionId,inbox_id:input.inbox_id,attempt_id:input.attempt_id});
  }
  failDelivery(handle,input) {
    fields(input,['sessionId','inbox_id','attempt_id','error_code']);const {lifeId,sessionId}=this.#session(handle,input.sessionId,true);
    return this.#rooms.failWorkerDelivery({lifeId,sessionId,inbox_id:input.inbox_id,attempt_id:input.attempt_id,error_code:input.error_code});
  }
  selectBatch(handle,input){fields(input,['sessionId','items']);const {lifeId,sessionId}=this.#session(handle,input.sessionId,true);return this.#rooms.selectWorkerBatch({lifeId,sessionId,items:copy(input.items)});}
  authorizeBatch(handle,input){fields(input,['sessionId','inbox_ids','attempt_id']);const {lifeId,sessionId}=this.#session(handle,input.sessionId,true);return this.#rooms.authorizeWorkerBatchDelivery({lifeId,sessionId,inbox_ids:copy(input.inbox_ids),attempt_id:input.attempt_id});}
  acknowledgeBatch(handle,input){fields(input,['sessionId','inbox_ids','attempt_id']);const {lifeId,sessionId}=this.#session(handle,input.sessionId,true);return this.#rooms.acknowledgeWorkerBatchDelivery({lifeId,sessionId,inbox_ids:copy(input.inbox_ids),attempt_id:input.attempt_id});}
  reconcileDelivery(handle,input){fields(input,['sessionId','inbox_id','attempt_id','evidence']);const {lifeId,sessionId}=this.#session(handle,input.sessionId,true);return this.#rooms.reconcileWorkerDelivery({lifeId,sessionId,inbox_id:input.inbox_id,attempt_id:input.attempt_id,evidence:copy(input.evidence)});}
}
