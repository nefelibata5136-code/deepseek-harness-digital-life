import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {RecentEventStore,canonicalUtc,stableJson} from './store.mjs';
import {parseActionResult} from './action-result.mjs';
import {recentPolicy} from './policy.mjs';
import {copy,freeze,fail} from '../contracts.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const invalid=(code,details)=>{throw Object.assign(new Error(code+': '+JSON.stringify(details)),{code,details});};
const loadedSources=Object.freeze(Object.fromEntries(['world.mjs','store.mjs','ledger.mjs','policy.mjs','../platform/conversations.mjs','../platform/tasks.mjs'].map(name=>
  [name,digest(readFileSync(resolve(import.meta.dirname,name)))])));
export const roomEventId=(roomId,messageId)=>'event-room-'+digest(roomId+'\0'+messageId);
const text=message=>(message.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
const snapshots=new Set(['runtime-context','persona-state','persona-state-retired','life-current-state','life-state-retired','life-recent-events','life-recent-events-retired','life-recent-retired']);

/** A recoverable projection of existing Rooms plus semantic native stimuli.
 * Rooms remain the communication authority. Immutable event files use stable
 * source IDs; a crash between a Room commit and projection is repaired on read.
 * This service has no Agent, model driver, timer or credential resolver.
 */
export class RecentWorld {
  constructor({rooms,root,now=()=>Date.now()}) {
    Object.assign(this,{rooms,root:resolve(root),now});mkdirSync(this.root,{recursive:true});
    this.path=resolve(this.root,'action-dispatch.json');
    const bytes=existsSync(this.path)?readFileSync(this.path,'utf8'):null;
    this.store=new RecentEventStore({root:this.root,now,canSeeEvent:(lifeId,event)=>rooms.recentEventVisible(lifeId,event)});
    const db=this.store.control;
    if(!db.prepare("SELECT value FROM meta WHERE key='dispatchActivated'").get()) {
      const legacy=bytes===null?{schema_version:1,activated_at_utc:canonicalUtc(now()),drafts:{},snapshots:{}}:JSON.parse(bytes);
      if(legacy.schema_version!==1||!legacy.drafts||!legacy.activated_at_utc)fail('RECENT_DISPATCH_STORE_INVALID');
      db.exec('BEGIN IMMEDIATE');try{this.commit(legacy);db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('dispatchActivated',legacy.activated_at_utc);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    }
    const map=kind=>new Proxy({}, {
      get:(_target,id)=>{if(typeof id!=='string')return undefined;const row=db.prepare('SELECT data FROM dispatch WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(row.data):undefined;},
      ownKeys:()=>db.prepare('SELECT id FROM dispatch WHERE kind=?').all(kind).map(row=>row.id),
      getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true}),
    });
    this.state={schema_version:1,activated_at_utc:db.prepare("SELECT value FROM meta WHERE key='dispatchActivated'").get().value,drafts:map('draft'),snapshots:map('snapshot')};
  }
  commit(next) {
    // Narrow row writes. The previous dispatch JSON remains a read-only archive.
    for(const [kind,key]of [['draft','drafts'],['snapshot','snapshots']])for(const [id,value]of Object.entries(next[key]??{}))this.store.control.prepare('INSERT OR REPLACE INTO dispatch VALUES(?,?,?)').run(kind,id,stableJson(value));
  }
  updateDraft(id,patch){const draft={...this.state.drafts[id],...patch};this.commit({drafts:{[id]:draft}});return draft;}
  cursor(lifeId,sessionId){return Number(this.store.control.prepare('SELECT data FROM dispatch WHERE kind=? AND id=?').get('cursor',lifeId+':'+sessionId)?.data??0);}
  setCursor(lifeId,sessionId,value){this.store.control.prepare('INSERT OR REPLACE INTO dispatch VALUES(?,?,?)').run('cursor',lifeId+':'+sessionId,String(value));}
  all(lifeId) {return this.store.listVisible(lifeId,{limit:Number.MAX_SAFE_INTEGER});}
  sync(lifeId,sessionId) {
    const after=this.cursor(lifeId,sessionId),sources=this.rooms.recentMessageSources(lifeId,sessionId,{after});
    for(const {room,message,audience} of sources) {
      const eventId=roomEventId(room.room_id,message.message_id),prior=this.store.event(eventId);
      if(prior){if(prior.payload.body_hash!==message.body_hash)fail('CONVERSATION_EVIDENCE_CHANGED');continue;}
      const direct=message.conversationType==='direct'||!message.conversationType&&room.room_type==='direct';
      const target=direct?audience.find(id=>id!==message.sender_id)??message.sender_id:null;
      this.store.emit({event_id:eventId,source_key:'room:'+room.room_id+':'+message.message_id,
        occurred_at_utc:message.timestamp??null,event_type:'communication',from_actor_id:message.sender_id,from_display_name:message.display_name??message.sender_id,
        conversation_id:room.room_id,conversation_type:direct?'direct':'group',conversation_display_name:message.conversationDisplayName??room.room_id,
        ...direct?{to_actor_id:target,to_display_name:this.rooms.principal(target).display_name??target}:{},visibility:{members:audience},body:message.body,
        payload:{room_seq:message.seq,message_id:message.message_id,body_hash:message.body_hash,timeline_seq:message.timeline_seq,
          available_at_utc:message.observed_at??null,room_visibility:room.visibility,
          ...(message.inResponseTo?{in_response_to:message.inResponseTo}:{}),...(message.addressee?{addressed_to_actor_id:message.addressee,addressed_to_display_name:message.addressee&&message.addressee!=='everyone'?this.rooms.principal(message.addressee).display_name:null}:{}),
          historical_import:message.observed_at==null||Date.parse(message.observed_at)<Date.parse(this.state.activated_at_utc)},
        originSessionId:message.origin_session_id??null,originTaskId:message.origin_task_id??null});
    }
    this.setCursor(lifeId,sessionId,sources.at(-1)?.message.timeline_seq??after);return sources;
  }
  scoped(lifeId,sessionId,event) {
    if(!this.rooms.recentEventVisible(lifeId,event))return false;
    if(event.event_type==='communication')return this.rooms.recentRoomScope(lifeId,sessionId,event.conversation_id);
    return !event.payload?.scope_session_id||event.payload.scope_session_id===sessionId;
  }
  emit({lifeId,sessionId,task},event,{exactSessionScope=false}={}) {
    if(!event||!['self_record','tool_action','scheduler','task_completion','system','external_stimulus'].includes(event.event_type)||
      typeof event.source_key!=='string'||!event.source_key||typeof event.body!=='string'||Buffer.byteLength(event.body)>1024*1024)fail('SEMANTIC_LIFE_EVENT_REQUIRED');
    const owner=this.rooms.contexts.registry.assertTarget(lifeId,sessionId),system=!['tool_action','self_record'].includes(event.event_type);
    const source='native:'+lifeId+':'+sessionId+':'+event.source_key;
    // Availability is Host admission metadata, fixed at the first successful
    // save. Reuse only that field; the store still compares all source facts.
    const existing=this.store.source(source);
    const available=existing?existing.payload.available_at_utc:canonicalUtc(this.now());
    return this.store.emit({event_id:'event-native-'+digest(source),source_key:source,occurred_at_utc:event.occurred_at_utc??null,
      event_type:event.event_type,from_actor_id:system?'host:'+event.event_type:lifeId,
      from_display_name:system?'Host · '+event.event_type:this.rooms.principal(lifeId).display_name,
      conversation_id:'life-activity:'+lifeId,conversation_type:'activity',conversation_display_name:system?'系统事件':'我的行动',
      visibility:{members:[lifeId]},body:event.body,payload:{...copy(event.payload??{}),available_at_utc:available,
        scope_session_id:exactSessionScope||owner.role==='activity'?sessionId:null},originSessionId:sessionId,originTaskId:task?.task_id??null});
  }
  batch(owner,id) {
    const batch=this.store.getBatch(owner.lifeId,id);
    if(batch.authority_session_id!==owner.sessionId)fail('DELIVERY_BATCH_SESSION_MISMATCH');
    if(batch.events.some(event=>!this.scoped(owner.lifeId,owner.sessionId,event)))fail('DELIVERY_BATCH_VISIBILITY_REVOKED');
    return batch;
  }
  deliveryHistory(owner,batch,events) {return this.store.deliveryHistory(owner.lifeId,owner.sessionId,events.filter(event=>this.scoped(owner.lifeId,owner.sessionId,event)),batch);}
  projectInputs(owner,inbox=this.rooms.recentInboxItems(owner.lifeId,owner.sessionId)) {
    for(const item of inbox) {
      const id=roomEventId(item.room_id,item.message_id);if(!this.store.event(id))continue;
      this.store.projectInputDecision({life_id:owner.lifeId,event_id:id,status:item.status,inbox_id:item.inbox_id,
        decision_revision:item.decision_revision??1,decision_at:item.decision_at??null,defer_until:item.defer_until??null});
    }
    return inbox;
  }
  healthEvents(owner) {
    const events=[];
    for(const notice of this.rooms.healthForLife?.({lifeId:owner.lifeId,sessionId:owner.sessionId})??[]) {
      const key='input-health:'+notice.notice_id,source='native:'+owner.lifeId+':'+owner.sessionId+':'+key;
      const prior=this.store.source(source);if(prior){events.push(prior);continue;}
      const {age_ms,...detail}=notice;
      events.push(this.emit(owner,{source_key:key,event_type:'system',occurred_at_utc:null,
        body:'Host 观察到输入或行动异常：'+notice.code+'。这是首次观察记录；请用 life_receive_message / life_action_result 核对当前事实。',
        payload:{notice:detail,observation_semantics:'first-observed; not a current semantic decision'}},{exactSessionScope:true}));
    }
    return events;
  }
  contextState(owner,events,batch) {
    const ids=new Set(events.map(event=>event.event_id)),inbox=this.rooms.recentInboxItems(owner.lifeId,owner.sessionId);
    const central=inbox.filter(item=>item.status==='pending').map(item=>roomEventId(item.room_id,item.message_id)).filter(id=>ids.has(id));
    const native=this.store.pending(owner.lifeId,{limit:1000,sessionId:owner.sessionId}).filter(event=>event.event_type!=='communication'&&ids.has(event.event_id)&&this.scoped(owner.lifeId,owner.sessionId,event)).map(event=>event.event_id);
    const pending=[...new Set([...central,...native])];
    const delivery_state=pending.map(id=>{
      const deliveries=this.store.control.prepare('SELECT rowid,batch,prepared,delivered FROM deliveries WHERE life=? AND session=? AND event=? ORDER BY rowid').all(owner.lifeId,owner.sessionId,id);
      const current=deliveries.find(row=>row.batch===batch?.batch_id);
      const rows=deliveries.filter(row=>!batch||(row.prepared<=batch.prepared_at_utc&&row.delivered<=batch.delivered_at_utc&&(!current||row.rowid<=current.rowid)));
      const item=inbox.find(item=>roomEventId(item.room_id,item.message_id)===id),last=rows.filter(row=>row.batch!==batch?.batch_id).at(-1);
      const status=last?this.store.batchStatus(owner.lifeId,last.batch):null,result=status?.result;
      return {event_id:id,delivery_count:rows.length,last_batch_id:last?.batch??null,last_turn_status:status?.turn_status??null,
        last_ack:result?{disposition:result.disposition,explicitly_completed:(result.completed_event_ids??[]).includes(id),
          record_keys:(result.records??[]).filter(record=>record.evidence_event_ids?.includes(id)).map(record=>record.key)}:null,
        input_decision:item?{status:item.status,last_decision:item.last_decision??null,decision_at:item.decision_at??null}:null,
        effect_result:item?.effect_result??null};
    });
    return {active_tasks:this.rooms.tasks?.recentForSession(owner)??[],pending_event_ids:pending,delivery_state,
      deferred:Object.fromEntries(events.map(event=>[event.event_id,this.store.mark(owner.lifeId,event.event_id).deferred]).filter(([,value])=>value)),outward_recovery:this.outwardResults(owner,pending)};
  }
  outwardResults(owner,eventIds) {
    const ids=new Set(eventIds),plans=[];
    const candidates=new Map();
    for(const eventId of ids)for(const row of this.store.control.prepare("SELECT b.id,b.data,b.status,d.data AS draft FROM deliveries v JOIN batches b ON b.id=v.batch JOIN dispatch d ON d.kind='draft' AND d.id=b.id WHERE v.life=? AND v.session=? AND v.event=? AND json_extract(b.status,'$.turn_status') IN ('failed','interrupted')").all(owner.lifeId,owner.sessionId,eventId))candidates.set(row.id,row);
    for(const [id,row] of candidates) {
      const draft=JSON.parse(row.draft),batch=JSON.parse(row.data),status=JSON.parse(row.status);
      if(draft.life_id!==owner.lifeId||draft.session_id!==owner.sessionId||!batch||
        !['failed','interrupted'].includes(status?.turn_status)||!batch.event_ids.some(id=>ids.has(id)))continue;
      const sends=(draft.result?.actions??[]).map((action,index)=>({action,index})).filter(({action})=>action.type==='send_message');
      if(!sends.length)continue;
      // Revocation cannot turn the recovery report into a private-content leak.
      if(!batch.events.every(event=>this.scoped(owner.lifeId,owner.sessionId,event))) {plans.push({batch_id:id,scope_revoked:true});continue;}
      plans.push({batch_id:id,native_turn_status:status.turn_status,
        effects:sends.map(({index})=>{
          const ref=draft.outward_aliases?.[index]??{message_id:'batch-action:'+id+':'+index,...draft.resolved_targets?.[index]?{room_id:draft.resolved_targets[index]}:{}};
          try{return this.rooms.actionResultForLife({lifeId:owner.lifeId,sessionId:owner.sessionId,...ref});}
          catch(error){return {...ref,status:'unknown',kind:'room_message',reason:error.code??'ACTION_RESULT_UNAVAILABLE'};}
        })});
    }
    return plans;
  }
  prepare(owner,input) {
    const {lifeId,sessionId}=owner;
    if(typeof input.wake_id!=='string'||!input.wake_id.startsWith(sessionId+':')||!Array.isArray(input.trigger_messages)||input.trigger_messages.length>500)fail('RECENT_WAKE_ID_REQUIRED');
    const cutoff=canonicalUtc(input.cutoff_at_utc),existing=this.store.batchForWake(lifeId,input.wake_id);
    const sources=this.sync(lifeId,sessionId);this.rooms.refreshDeferred?.({lifeId});
    this.reconcileAcknowledged(owner);const inbox=this.projectInputs(owner),health=this.healthEvents(owner);
    if(existing) {
      let batch=this.batch(owner,existing.batch_id);
      if(batch.delivered_at_utc===null)batch=this.store.deliverBatch({life_id:lifeId,batch_id:batch.batch_id,wake_id:batch.wake_id});
      const savedSnapshot=this.state.snapshots[batch.batch_id];
      const frozenIds=Array.isArray(savedSnapshot)?savedSnapshot:savedSnapshot?.event_ids;
      const candidates=frozenIds?frozenIds.map(id=>this.store.event(id)).filter(Boolean):this.store.recent(lifeId,{limit:recentPolicy.highWaterEvents,before:batch.snapshot_cutoff_seq,sessionId});
      const events=candidates.filter(event=>this.scoped(lifeId,sessionId,event)&&event.seq<=batch.snapshot_cutoff_seq&&
        (frozenIds||batch.event_ids.includes(event.event_id)||Date.parse(event.payload?.available_at_utc??event.observed_at_utc)<=Date.parse(cutoff)&&(event.payload?.historical_import||event.from_actor_id===lifeId||this.store.delivered(lifeId,event.event_id,sessionId))));
      return {batch,events,context_state:this.contextState(owner,events,batch),delivery_history:this.deliveryHistory(owner,batch,events),char_budget:recentPolicy.highWaterChars,loaded_sources:loadedSources};
    }
    const selected=new Set(health.map(event=>event.event_id)),nativeSources=new Set();
    for(const message of input.trigger_messages) {
      const source=message?.source;if(!source||snapshots.has(source.kind))continue;
      const ids=source.inboxIds??(source.inboxId?[source.inboxId]:[]);
      for(const id of ids) {const row=inbox.find(item=>item.inbox_id===id);if(row)selected.add(roomEventId(row.room_id,row.message_id));}
      const known=[...sources.filter(row=>row.message.message_id===source.messageId||row.message.message_id===source.rpcId),...this.rooms.recentMessageById?.(lifeId,sessionId,[source.messageId,source.rpcId])??[]];
      for(const row of known)selected.add(roomEventId(row.room.room_id,row.message.message_id));
      if(ids.length||known.length||source.kind==='room-inbox-batch'||source.kind==='room-inbox')continue;
      const body=text(message);if(!body.trim())continue;
      const scheduler=/schedule|resident|wake/.test(source.kind??'')||String(source.rpcId??'').startsWith('resident:');
      const completion=/subagent|task.*result|task.*complet/.test(source.kind??'');
      // The native role user is not an authenticated human identity. Unknown
      // sources stay Host stimuli with explicit provenance, never "用户".
      const key='stimulus:'+(source.rpcId??message.id??digest(stableJson(message)));
      const event=this.emit(owner,{source_key:key,event_type:scheduler?'scheduler':completion?'task_completion':'system',
        occurred_at_utc:source.occurredAt??source.occurred_at_utc??null,body,payload:{native_source_kind:source.kind??null,native_message_id:message.id??null,
          identity_semantics:'host-native-input; role=user alone grants no human identity'}});
      selected.add(event.event_id);nativeSources.add(event.event_id);
    }
    // A real native wake carries all scoped unfinished communication. A prior
    // attempt or implicit old ACK cannot consume the receiver's semantic input.
    const pendingInputs=inbox.filter(item=>item.status==='pending').map(item=>this.store.event(roomEventId(item.room_id,item.message_id))).filter(Boolean);
    const otherPending=this.store.pending(lifeId,{limit:1000,sessionId}).filter(event=>event.event_type!=='communication');
    const pendingEvents=[...new Map([...pendingInputs,...otherPending].map(event=>[event.event_id,event])).values()].filter(event=>this.scoped(lifeId,sessionId,event)&&Date.parse(event.payload?.available_at_utc??event.observed_at_utc)<=Date.parse(cutoff));
    for(const event of pendingInputs)if(pendingEvents.includes(event))selected.add(event.event_id);
    const pending=new Set(pendingEvents.map(event=>event.event_id));
    const currentEvents=[...selected].map(id=>this.store.event(id)).filter(event=>{
      if(!event||!this.scoped(lifeId,sessionId,event))return false;
      const mark=this.store.mark(lifeId,event.event_id);return !mark.handled&&!mark.deferred;
    });
    const eventIds=[...new Set([...currentEvents,...pendingEvents.filter(event=>event.event_type==='communication'||!event.payload?.historical_import)].map(event=>event.event_id))];
    const tail=this.store.recent(lifeId,{limit:recentPolicy.highWaterEvents,sessionId});
    // A fresh Session starts with the bounded recent tail. Its zero cursor is
    // not a request to replay the first thousand entries of the old archive.
    const delta=Number.isSafeInteger(input.after)&&input.after>0?this.store.listVisible(lifeId,{after:input.after,limit:1000}):[];
    let events=[...new Map([...tail,...delta,...currentEvents,...pendingEvents].map(event=>[event.event_id,event])).values()].filter(event=>this.scoped(lifeId,sessionId,event)&&
      (selected.has(event.event_id)||Date.parse(event.payload?.available_at_utc??event.observed_at_utc)<=Date.parse(cutoff))&&
      (event.payload?.historical_import||event.from_actor_id===lifeId||this.store.delivered(lifeId,event.event_id,sessionId)||eventIds.includes(event.event_id))).sort((a,b)=>a.seq-b.seq);
    let batch=this.store.createBatch({life_id:lifeId,authority_session_id:sessionId,wake_id:input.wake_id,event_ids:eventIds});
    this.commit({snapshots:{[batch.batch_id]:{event_ids:events.map(event=>event.event_id),
      input_decision_revisions:Object.fromEntries(inbox.filter(item=>eventIds.includes(roomEventId(item.room_id,item.message_id))).map(item=>[item.inbox_id,item.decision_revision]))}}});
    batch=this.store.deliverBatch({life_id:lifeId,batch_id:batch.batch_id,wake_id:input.wake_id});
    return freeze({batch,events,context_state:this.contextState(owner,events,batch),delivery_history:this.deliveryHistory(owner,batch,events),char_budget:recentPolicy.highWaterChars,loaded_sources:loadedSources});
  }
  recordResult(owner,batch,result,{validateOnly=false}={}) {
    // Validate every key and reference before saving any record. All provenance
    // is Host-bound; the model's related_task is a reference, not a task update.
    const inputs=(result.records??[]).map(record=>{
      if(record.related_task&&!this.rooms.tasks.recentForSession(owner,{includeCompleted:true}).some(task=>task.task_id===record.related_task))fail('TURN_RECORD_TASK_NOT_VISIBLE');
      for(const id of record.evidence_event_ids??[]) {
        const evidence=this.store.event(id);
        if(!evidence||!this.scoped(owner.lifeId,owner.sessionId,evidence))fail('TURN_RECORD_EVIDENCE_NOT_VISIBLE');
      }
      const source='native:'+owner.lifeId+':'+owner.sessionId+':record:'+record.key;
      const existing=this.store.source(source);
      if(existing&&stableJson(existing.payload?.record)!==stableJson(record))fail('TURN_RECORD_IDEMPOTENCE_CONFLICT');
      return {source_key:'record:'+record.key,event_type:'self_record',occurred_at_utc:record.occurred_at_utc,body:record.summary,
        payload:{record:copy(record),source_kind:'agent-self-report',result_batch_id:existing?.payload.result_batch_id??batch.batch_id,
          evidence_semantics:'本人陈述的事实/结果；保存不证明外部行动成功或原生回合完成'}};
    });
    return validateOnly?inputs:inputs.map(event=>this.emit(owner,event).event_id);
  }
  receiverDeferred(owner,batch,result) {
    const defers=new Map(result.actions.filter(action=>action.type==='defer').map(action=>[action.event_id,{event_id:action.event_id,until:action.until}]));
    if(result.disposition==='deferred'&&defers.size===0)for(const id of batch.event_ids)defers.set(id,{event_id:id,until:null});
    for(const item of this.rooms.recentInboxItems(owner.lifeId,owner.sessionId).filter(item=>item.status==='deferred')) {
      const event=batch.events.find(event=>event.conversation_id===item.room_id&&event.payload?.message_id===item.message_id);
      if(event)defers.set(event.event_id,{event_id:event.event_id,until:canonicalUtc(item.defer_until,{nullable:true})});
    }
    const completed=new Set(result.completed_event_ids??[]);return [...defers.values()].filter(value=>!completed.has(value.event_id));
  }
  validateDecision(batch,result,{historical=false}={}) {
    const completed=result.completed_event_ids??[];
    for(const [index,id] of completed.entries())if(!batch.event_ids.includes(id)) {
      const event=this.store.event(id),delivery=this.store.delivered(batch.life_id,id,batch.authority_session_id);
      if(!event||event.seq>batch.snapshot_cutoff_seq||!this.scoped(batch.life_id,batch.authority_session_id,event)||!delivery||delivery.delivered>batch.delivered_at_utc)
        invalid('COMPLETED_EVENT_NOT_IN_CURRENT_BATCH',{field:'completed_event_ids['+index+']',event_id:id,reason:'requires_visible_delivery_to_this_session_before_current_batch'});
    }
    const deferred=new Set();
    for(const action of result.actions) {
      if(action.type==='send_message') {if(!historical)fail('SEND_MESSAGE_USE_NATIVE_TOOL');continue;}
      if(action.type!=='defer'||!batch.event_ids.includes(action.event_id))invalid('DEFER_EVENT_NOT_IN_CURRENT_BATCH',{field:'actions',event_id:action.event_id??null});
      if(deferred.has(action.event_id))fail('DUPLICATE_DEFER_EVENT');deferred.add(action.event_id);
      if(!historical&&action.until!==null&&Date.parse(action.until)<=this.now())fail('DEFER_REQUIRES_FUTURE_TIME');
    }
    if(result.disposition==='deferred'&&!deferred.size)for(const id of batch.event_ids)deferred.add(id);
    if(completed.some(id=>deferred.has(id)))fail('COMPLETED_DEFERRED_EVENT_CONFLICT');
  }
  completionBatch(batch,result) {
    const extra=(result.completed_event_ids??[]).filter(id=>!batch.event_ids.includes(id));
    return extra.length?{...batch,events:[...batch.events,...extra.map(id=>this.store.event(id))],event_ids:[...batch.event_ids,...extra]}:batch;
  }
  legacyEffects(owner,batch,result) {
    const draft=this.state.drafts[batch.batch_id];
    return result.actions.flatMap((action,index)=>{
      if(action.type!=='send_message')return [];
      const alias=draft?.outward_aliases?.[index],ref={message_id:alias?.message_id??'batch-action:'+batch.batch_id+':'+index};
      const roomId=alias?.room_id??draft?.resolved_targets?.[index]??action.conversation_id??action.public_area_id;if(roomId)ref.room_id=roomId;
      try{return [this.rooms.actionResultForLife({lifeId:owner.lifeId,sessionId:owner.sessionId,...ref})];}
      catch(error){return [{...ref,status:'unknown',kind:'room_message',reason:error.code??'ACTION_RESULT_UNAVAILABLE'}];}
    });
  }
  validateInputCompletion(owner,batch,result,{validateOnly=false}={}) {
    const completed=new Set(result.completed_event_ids??[]);if(!completed.size)return;
    const baseline=this.state.snapshots[batch.batch_id]?.input_decision_revisions;
    for(const item of this.rooms.recentInboxItems(owner.lifeId,owner.sessionId)) {
      const id=roomEventId(item.room_id,item.message_id);if(!completed.has(id))continue;
      if(['handled','ignored','revoked'].includes(item.status))continue;
      const changed=baseline?.[item.inbox_id]!==undefined?item.decision_revision!==baseline[item.inbox_id]:
        item.decision_at!==null&&item.decision_at!==undefined&&item.decision_at>=batch.prepared_at_utc;
      if(item.status!=='deferred'&&!(changed&&['continue','process'].includes(item.last_decision)))continue;
      const sourceKey='ack-choice-conflict:'+batch.batch_id+':'+item.inbox_id+':'+item.decision_revision;
      if(!validateOnly&&!this.store.source('native:'+owner.lifeId+':'+owner.sessionId+':'+sourceKey))this.emit(owner,{source_key:sourceKey,event_type:'system',occurred_at_utc:null,
        body:'ACK 的完成列表与本人已明确保存的输入决定冲突。原决定保留；若现在确实完成，请先用 life_message_decide complete，再提交 ACK。',
        payload:{code:'ACK_CONFLICTS_WITH_INPUT_DECISION',batch_id:batch.batch_id,inbox_id:item.inbox_id,event_id:id,decision_revision:item.decision_revision,last_decision:item.last_decision}},{exactSessionScope:true});
      invalid('ACK_CONFLICTS_WITH_INPUT_DECISION',{field:'completed_event_ids',event_id:id,inbox_id:item.inbox_id,last_decision:item.last_decision??null,reason:'use_life_message_decide_complete_first'});
    }
  }
  applyAcknowledged(owner,batch,draft) {
    if(draft.semantic_applied===true)return draft;
    const result=draft.result;if(result.actions.some(action=>action.type==='send_message'))fail('SEND_MESSAGE_USE_NATIVE_TOOL');
    this.validateDecision(batch,result,{historical:true});this.recordResult(owner,batch,result,{validateOnly:true});
    const completionBatch=this.completionBatch(batch,result);
    const inbox=this.rooms.recentInboxItems(owner.lifeId,owner.sessionId);
    const unchanged=event=>{const item=inbox.find(item=>item.room_id===event.conversation_id&&item.message_id===event.payload?.message_id);
      return !item||item.decision_revision===(draft.input_decision_revisions?.[item.inbox_id]??item.decision_revision);};
    const defers=result.actions.filter(action=>action.type==='defer');
    if(result.disposition==='deferred'&&!defers.length)for(const event of batch.events)defers.push({type:'defer',event_id:event.event_id,until:null});
    for(const action of defers) {
      const event=batch.events.find(event=>event.event_id===action.event_id);
      if(unchanged(event)&&(action.until===null||Date.parse(action.until)>this.now()))this.rooms.deferRecentEvent({lifeId:owner.lifeId,sessionId:owner.sessionId,event,until:action.until});
    }
    const eligible=new Set(completionBatch.events.filter(unchanged).map(event=>event.event_id));
    const currentResult={...result,completed_event_ids:(result.completed_event_ids??[]).filter(id=>eligible.has(id))};
    this.validateInputCompletion(owner,batch,currentResult);
    const recordIds=this.recordResult(owner,batch,result);
    this.rooms.completeRecentBatch({lifeId:owner.lifeId,sessionId:owner.sessionId,batch:completionBatch,result:currentResult});
    const deferred=this.receiverDeferred(owner,batch,result);
    this.store.acknowledgeBatch({life_id:owner.lifeId,batch_id:batch.batch_id,result,deferred_events:deferred,finish:false});
    this.projectInputs(owner);
    return this.updateDraft(batch.batch_id,{semantic_applied:true,record_event_ids:recordIds,receiver_deferred:deferred});
  }
  reconcileAcknowledged(owner,{batchId}={}) {
    const rows=this.store.control.prepare("SELECT id,data FROM dispatch WHERE kind='draft' AND json_extract(data,'$.schema_version')=2 AND json_extract(data,'$.state')='acknowledged' AND json_extract(data,'$.life_id')=? AND json_extract(data,'$.session_id')=? AND coalesce(json_extract(data,'$.semantic_applied'),0)=0"+(batchId===undefined?'':' AND id=?')).all(owner.lifeId,owner.sessionId,...batchId===undefined?[]:[batchId]);
    for(const row of rows)try{this.applyAcknowledged(owner,this.batch(owner,row.id),JSON.parse(row.data));}
    catch(error){const key='ack-reconcile:'+row.id,source='native:'+owner.lifeId+':'+owner.sessionId+':'+key;
      if(!this.store.source(source))this.emit(owner,{source_key:key,event_type:'system',occurred_at_utc:null,
        body:'Host 无法自动核对已保存的语义 ACK；输入和原行动证据均保留。请查本批记录与 life_receive_message。',
        payload:{code:'RECENT_ACK_RECONCILE_FAILED',batch_id:row.id,error_code:error.code??'UNKNOWN'}},{exactSessionScope:true});
    }
  }
  dispatch(owner,batch,result,{allowLegacy=false}={}) {
    const status=this.store.batchStatus(owner.lifeId,batch.batch_id),previous=this.state.drafts[batch.batch_id];
    if(previous&&(previous.life_id!==owner.lifeId||previous.session_id!==owner.sessionId))fail('DELIVERY_BATCH_SESSION_MISMATCH');
    if(previous&&stableJson(previous.result)!==stableJson(result))fail('AUTHORITY_ACK_IDEMPOTENCE_CONFLICT');
    // A durable identical ACK is an existing decision. Its defer deadline may
    // pass before a receipt is retried; only a new decision requires future time.
    this.validateDecision(batch,result,{historical:allowLegacy||previous?.schema_version===2});this.recordResult(owner,batch,result,{validateOnly:true});
    const legacy=previous?previous.schema_version!==2:result.completed_event_ids===undefined||result.actions.some(action=>action.type==='send_message');
    if(allowLegacy&&legacy)return freeze({acknowledged:true,result,delivery_batch_id:batch.batch_id,effect_results:this.legacyEffects(owner,batch,result)});
    if(!previous)this.validateInputCompletion(owner,batch,result);
    if(!previous&&(!status||['failed','interrupted'].includes(status.turn_status)))fail('FAILED_BATCH_REQUIRES_NEW_WAKE');
    const draft=previous??this.updateDraft(batch.batch_id,{schema_version:2,life_id:owner.lifeId,session_id:owner.sessionId,result:copy(result),
      state:'acknowledged',acknowledged_at_utc:canonicalUtc(this.now()),semantic_applied:false,
      input_decision_revisions:Object.fromEntries(this.rooms.recentInboxItems(owner.lifeId,owner.sessionId).filter(item=>this.completionBatch(batch,result).events.some(event=>event.conversation_id===item.room_id&&event.payload?.message_id===item.message_id)).map(item=>[item.inbox_id,item.decision_revision]))});
    this.applyAcknowledged(owner,batch,draft);
    return freeze({acknowledged:true,result,delivery_batch_id:batch.batch_id});
  }
  call(owner,input) {
    switch(input.operation) {
      case 'validate_ack': {
        const batch=this.batch(owner,input.batch_id);
        try {
          const result=parseActionResult(JSON.stringify(input.result));
          this.validateDecision(batch,result);this.recordResult(owner,batch,result,{validateOnly:true});
          this.validateInputCompletion(owner,batch,result,{validateOnly:true});
          return freeze({valid:true});
        }catch(error){if(!error.code)throw error;return freeze({valid:false,error:{code:error.code,...error.details?{details:error.details}:{}}});}
      }
      case 'emit':return this.emit(owner,input.event);
      case 'prepare':return this.prepare(owner,input);
      case 'inspect': {
        const state=copy(this.store.inspectLife(owner.lifeId));
        state.batches=Object.fromEntries(Object.entries(state.batches).filter(([,batch])=>batch.authority_session_id===owner.sessionId));
        state.batches=Object.fromEntries(Object.entries(state.batches).map(([id,batch])=>[id,batch.events.every(event=>this.scoped(owner.lifeId,owner.sessionId,event))?batch:{...batch,events:[],visibility_revoked:true}]));
        state.batch_status=Object.fromEntries(Object.entries(state.batch_status).filter(([id])=>Object.hasOwn(state.batches,id)));
        const visibleMark=(id,value)=>value.source==='central-inbox'?
          Boolean(this.store.event(id)&&this.scoped(owner.lifeId,owner.sessionId,this.store.event(id))):Object.hasOwn(state.batches,value.batch_id);
        state.handled=Object.fromEntries(Object.entries(state.handled).filter(([id,value])=>visibleMark(id,value)));
        state.deferred=Object.fromEntries(Object.entries(state.deferred??{}).filter(([id,value])=>visibleMark(id,value)));
        return freeze({life_id:owner.lifeId,events:this.all(owner.lifeId).filter(event=>this.scoped(owner.lifeId,owner.sessionId,event)),state,loaded_sources:loadedSources});
      }
      case 'ack':return this.dispatch(owner,this.batch(owner,input.batch_id),parseActionResult(JSON.stringify(input.result)));
      case 'finish_execution': {
        // This RPC belongs to the verified owner's Host, after it observes an
        // actual naturally completed native turn. It never synthesizes an ACK
        // or infers the Agent's input decision from a message/tool/turn end.
        this.rooms.contexts.registry.assertTarget(owner.lifeId,owner.sessionId);
        const batch=this.batch(owner,input.batch_id);
        if(!Number.isSafeInteger(input.turn)||input.turn<1||batch.wake_id!==owner.sessionId+':'+input.turn)fail('DELIVERY_WAKE_ID_MISMATCH');
        if(Object.hasOwn(input,'result'))fail('EXECUTION_FINISH_DOES_NOT_ACCEPT_AGENT_RESULT');
        if(input.turn_status!==undefined&&input.turn_status!=='completed')fail('NATIVE_COMPLETED_TURN_REQUIRED');
        const previous=this.store.batchStatus(owner.lifeId,batch.batch_id);
        if(['failed','interrupted'].includes(previous?.turn_status))fail('FAILED_BATCH_REQUIRES_NEW_WAKE');
        // A previously accepted ACK is independent semantic evidence. Retry
        // its existing checkpoint, without replaying outward actions or making
        // a failed semantic reconciliation become a native execution failure.
        this.reconcileAcknowledged(owner,{batchId:batch.batch_id});
        const status=this.store.finishBatchExecution({life_id:owner.lifeId,batch_id:batch.batch_id});
        const inbox=this.projectInputs(owner);
        const unresolved=batch.events.filter(event=>{
          if(event.event_type!=='communication')return !this.store.mark(owner.lifeId,event.event_id).handled;
          const item=inbox.find(item=>item.room_id===event.conversation_id&&item.message_id===event.payload?.message_id);
          return item?['pending','deferred'].includes(item.status):!this.store.mark(owner.lifeId,event.event_id).handled;
        }).map(event=>event.event_id);
        return freeze({execution_finished:true,delivery_batch_id:batch.batch_id,turn_status:status.turn_status,
          semantic_ack_received:status.acknowledged===true,unresolved_event_ids:unresolved});
      }
      case 'complete': {
        const batch=this.batch(owner,input.batch_id),result=parseActionResult(JSON.stringify(input.result));
        const receipt=this.dispatch(owner,batch,result,{allowLegacy:true}),draft=this.state.drafts[batch.batch_id];
        const deferred=draft?.receiver_deferred??this.receiverDeferred(owner,batch,result);
        const status=this.store.batchStatus(owner.lifeId,batch.batch_id);
        if(!['failed','interrupted'].includes(status?.turn_status)||draft?.schema_version===2)
          this.store.acknowledgeBatch({life_id:owner.lifeId,batch_id:batch.batch_id,result,deferred_events:deferred,finish:true});
        this.projectInputs(owner);
        return receipt;
      }
      case 'fail': {
        const batch=this.store.getBatch(owner.lifeId,input.batch_id);if(batch.authority_session_id!==owner.sessionId)fail('DELIVERY_BATCH_SESSION_MISMATCH');
        return this.store.failBatch({life_id:owner.lifeId,batch_id:input.batch_id,
          status:input.turn_status==='interrupted'?'interrupted':'failed',error:input.error_code??'NATIVE_TURN_FAILED'});
      }
      default:fail('UNKNOWN_RECENT_EVENT_OPERATION');
    }
  }
}
