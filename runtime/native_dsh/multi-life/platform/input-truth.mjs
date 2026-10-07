import {createHash} from 'node:crypto';

// Input disposition belongs to the receiver. A Room write is separate evidence.
// This module is pure: the caller supplies its current durable state and commits
// migration once. It never sends, schedules, admits a model turn, or reads a file.
const copy=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const terminal=new Set(['handled','ignored','deferred','revoked']);
const rows=value=>Array.isArray(value)?value:Object.values(value?.inbox??value??{});
const membership=(values,id)=>values instanceof Set?values.has(id):Array.isArray(values)&&values.includes(id);
function explicitMark(item,marks) {
  const mark=marks[item.inbox_id]??marks[item.message_id];
  if(mark?.explicit===true)return mark;
  const ids=[item.inbox_id,item.message_id,item.event_id,item.recent_event_id].filter(Boolean);
  if(ids.some(id=>membership(marks.completed_event_ids,id)))return {explicit:true,decision:'complete'};
  if(ids.some(id=>membership(marks.ignored_event_ids,id)))return {explicit:true,decision:'ignore'};
  const deferred=marks.deferred_events?.find?.(entry=>ids.includes(entry.event_id));
  if(deferred)return {explicit:true,decision:'defer',until:deferred.until};
  return null;
}
function stripAttempt(attempt,history) {
  if(!attempt)return;
  if(Object.hasOwn(attempt.native_evidence??{},'side_effects')) {
    history.push({attempt_id:attempt.attempt_id??null,state:attempt.state??null,
      native_turn:attempt.native_evidence.turn??null,legacy_tool_call_heuristic:attempt.native_evidence.side_effects});
    delete attempt.native_evidence.side_effects;
  }
}

export function migrateInputTruth(source,{marks={}}={}) {
  const state=copy(source),provenance=[];
  for(const item of Object.values(state.inbox??{})) {
    const before=item.status,mark=explicitMark(item,marks),history=[];
    stripAttempt(item.attempt,history);
    for(const attempt of item.previous_attempts??[])stripAttempt(attempt,history);
    let reason='input-remains-receiver-owned';
    if(mark) {
      const decision=mark.decision??mark.action;
      if(['complete','completed','handled'].includes(decision)){item.status='handled';reason='explicit-agent-completion';}
      else if(['ignore','ignored'].includes(decision)){item.status='ignored';reason='explicit-agent-ignore';}
      else if(['defer','deferred'].includes(decision)){item.status='deferred';item.defer_until=mark.until??null;reason='explicit-agent-defer';}
      else item.status=terminal.has(before)&&before!=='handled'?before:'pending';
    }else if(['ignored','deferred','revoked'].includes(before)||source.schemaVersion>=3&&before==='handled')item.status=before;
    else {item.status='pending';if(before==='handled')reason='implicit-old-ack';else if(before==='replied')reason='reply-is-effect-not-completion';}
    item.requested=item.requested===true||before==='requested';
    // Execution history remains available for recovery; none is an effect result.
    if(before!==item.status||history.length) {
      if(source.schemaVersion<3&&!item.migration)item.migration={from_status:before,reason};
      provenance.push({inbox_id:item.inbox_id,message_id:item.message_id,
        from_status:before,to_status:item.status,reason,...history.length?{execution_history:history}:{}});
    }
  }
  state.schemaVersion=3;
  return {state,provenance,notices:inputHealth(state)};
}

const receiptFor=input=>input.reply_receipt??input.effect_result??input.action_result??null;
function roomValues(value){return Object.values(value?.rooms??value??{}).filter(room=>Array.isArray(room?.messages));}
function messageMetadata(message){return {message_id:message.messageId??message.message_id,
  room_id:message.conversationId??message.room_id,body_hash:message.bodyHash??message.body_hash};}

export function roomEffectResult(input,rooms) {
  const receipt=receiptFor(input),id=receipt?.message_id??receipt?.reply_message_id??input.reply_message_id;
  const roomId=receipt?.room_id??input.room_id,expected=receipt?.body_hash??input.reply_body_hash;
  if(!id&&!receipt&&input.status!=='replied')return null;
  const base={kind:'room_message',inbox_id:input.inbox_id,room_id:roomId,message_id:id??null,
    body_hash:expected??null,...receipt?.effect_id?{effect_id:receipt.effect_id}:{}};
  const room=roomValues(rooms).find(value=>(value.conversationId??value.room_id)===roomId);
  const message=room?.messages.find(value=>(value.messageId??value.message_id)===id);
  if(message) {
    const metadata=messageMetadata(message),actual=metadata.body_hash;
    const sender=message.senderPrincipalId??message.sender_id;
    const replyTo=message.replyTo??message.reply_to;
    if(!actual||typeof message.body==='string'&&hash(message.body)!==actual||expected&&actual!==expected||
      sender&&input.owner_life_id&&sender!==input.owner_life_id||replyTo&&input.message_id&&replyTo!==input.message_id)
      return {...base,status:'unknown',reason:'room-message-evidence-conflict'};
    return {...base,...metadata,status:'confirmed_success',reason:'durable-room-message-exists'};
  }
  if(receipt?.committed===false&&(receipt.rejected===true||receipt.status==='confirmed_failure'||receipt.error_code))
    return {...base,status:'confirmed_failure',reason:'host-rejected-before-commit',...receipt.error_code?{error_code:receipt.error_code}:{}};
  return {...base,status:'unknown',reason:id?'referenced-room-message-missing':'effect-outcome-not-reconciled',
    ...receipt?.error_code?{error_code:receipt.error_code}:{}};
}

function timestamp(value){const parsed=typeof value==='number'?value:Date.parse(value??'');return Number.isFinite(parsed)?parsed:null;}
export function inputHealth(inputs,{rooms=inputs?.rooms??{},now=Date.now(),pendingAgeMs=30*60*1000,
  unknownAgeMs=5*60*1000,recentDecisionMs=pendingAgeMs}={}) {
  const notices=[],duplicates=new Map(),seen=new Set();
  const notice=(code,item,detail={})=>{
    const identity=code+':'+item.inbox_id+':'+(detail.message_id??'');if(seen.has(identity))return;seen.add(identity);
    notices.push({notice_id:'input-health:'+hash(identity).slice(0,24),code,level:'warning',inbox_id:item.inbox_id,
      owner_life_id:item.owner_life_id,room_id:item.room_id,message_id:item.message_id,...detail});
  };
  for(const item of rows(inputs)) {
    if(!item||typeof item.inbox_id!=='string')continue;
    const receipt=receiptFor(item),effect=roomEffectResult(item,rooms),received=timestamp(item.received_at);
    const decision=item.last_decision??item.semantic_decision;
    const decisionAt=timestamp(item.decision_at??item.last_decision_at??decision?.at??decision?.decided_at);
    const recentDecision=decisionAt!==null&&now-decisionAt<recentDecisionMs&&
      ['continue','process','reply','defer'].includes(typeof decision==='string'?decision:decision?.action??decision?.decision??item.last_decision_action);
    if(item.status==='pending'&&received!==null&&now-received>=pendingAgeMs&&!recentDecision)
      notice('INPUT_PENDING_TOO_LONG',item,{age_ms:now-received});
    if(effect?.status==='unknown') {
      const at=timestamp(receipt?.observed_at??receipt?.created_at??item.effect_attempted_at??item.updated_at??item.received_at);
      if(at!==null&&now-at>=unknownAgeMs)notice('SIDE_EFFECT_UNKNOWN',item,{effect_message_id:effect.message_id,reason:effect.reason,age_ms:now-at});
    }
    if(receipt&&receipt.status?.startsWith('confirmed_')&&effect&&receipt.status!==effect.status||
      item.reply_message_id&&effect?.status!=='confirmed_success'||item.status==='replied'&&effect?.status!=='confirmed_success')
      notice('ACTION_RESULT_CONTRADICTION',item,{effect_message_id:effect?.message_id??null,result:effect?.status??'unknown'});
    const attempts=[item.attempt,...item.previous_attempts??[]].filter(Boolean);
    const ownRoom=roomValues(rooms).find(room=>(room.conversationId??room.room_id)===item.room_id);
    const committedReplies=(ownRoom?.messages??[]).filter(message=>(message.senderPrincipalId??message.sender_id)===item.owner_life_id&&
      (message.replyTo??message.reply_to)===item.message_id).map(message=>({message_id:message.messageId??message.message_id,reply_to:item.message_id}));
    const effects=[receipt,...item.effect_receipts??[],...committedReplies].filter(Boolean);
    for(const effectReceipt of effects) {
      const target=effectReceipt.reply_to??item.message_id,id=effectReceipt.message_id??effectReceipt.reply_message_id;
      if(!id)continue;const key=[item.owner_life_id,item.room_id,target].join(':');
      const previous=duplicates.get(key);if(previous&&previous.id!==id)notice('DUPLICATE_OUTWARD_INTENT',item,{effect_message_id:id,other_effect_message_id:previous.id});
      else duplicates.set(key,{id});
    }
    if(attempts.some(attempt=>attempt.state==='ambiguous'||attempt.native_evidence?.state==='ambiguous'||attempt.reconcile_error))
      notice('RECOVERY_RECONCILE_BLOCKED',item,{attempt_id:item.attempt?.attempt_id??null});
  }
  return notices;
}
