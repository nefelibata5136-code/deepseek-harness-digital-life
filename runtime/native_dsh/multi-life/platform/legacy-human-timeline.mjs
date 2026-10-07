import {mkdirSync,existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonical,copy,freeze,fail} from '../contracts.mjs';
import {createDetector} from '../../../key_output_guard/detector.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const code=error=>/^[A-Z_]{1,128}$/.test(error?.code??'')?error.code:'HUMAN_TIMELINE_OPERATION_FAILED';
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key));
const safeCode=value=>value===null||/^[A-Z_]{1,128}$/.test(value??'');
const validId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const privateName=name=>typeof name==='string'&&/^private_/i.test(name);
const time=value=>{const at=new Date(value);if(!Number.isFinite(at.getTime()))fail('HUMAN_TIMELINE_EVENT_TIME_REQUIRED');return at.toISOString();};
// These are explicit, non-trigger context records emitted by the existing
// legacy life plugin. They acquire no human identity. Unknown wake/request
// sources must never be promoted to a human merely because their role is user.
const snapshot=source=>['life-recent-events','life-recent-events-retired','life-recent-retired'].includes(source?.kind)||source?.kind==='persona-state-retired'||source?.kind==='persona-state'&&source.form==='snapshot'&&
  Array.isArray(source.sections)&&source.sections.length>0&&source.sections.every(section=>typeof section.name==='string'&&section.name.startsWith('persona:'));

/**
 * Persist authenticated human ingress provenance before native admission.
 * Native assistant text remains native output. Only life_send_message publishes
 * Room speech. Old automatic reply intents are reconciled read-only, never sent.
 * No native prompt/create/resume/wakeup, output-body read, or Core operation.
 * The root is an owner-private control journal, not a public report directory.
 * occurred_at retains the Host human receipt / original native reply event
 * time and reaches the trusted central transport; observed_at stays separate.
 */
export async function mountLegacyHumanTimeline({ctx,bridge,lifeId,authoritySessionId,roomId,root,sanitizeText}) {
  if(!/^life-[a-f0-9-]{36}$/.test(lifeId)||!validId(authoritySessionId)||typeof roomId!=='string'||!roomId||
    typeof ctx?.agents?.get!=='function'||typeof ctx?.on!=='function'||typeof bridge?.postHuman!=='function'||
    sanitizeText!==undefined&&typeof sanitizeText!=='function')fail('EXPLICIT_HUMAN_TIMELINE_BINDING_REQUIRED');
  const detector=createDetector(),screen=sanitizeText??(text=>detector.sanitize(text));
  const directory=canonical(root),file=resolve(directory,'human-timeline.json');mkdirSync(directory,{recursive:true});
  let bytes=existsSync(file)?readFileSync(file):null,versionHash=bytes?digest(bytes):null;
  let state=bytes?JSON.parse(bytes.toString('utf8')):{schema_version:1,life_id:lifeId,authority_session_id:authoritySessionId,room_id:roomId,native_header_hash:null,generation:0,requests:{},turns:{}};
  let enabled=true,lastError=null,metadataError=null,queue=Promise.resolve(),retryTimer=null;
  const disposers=[],recording=new WeakMap();
  function validate(value) {
    if(!keys(value,['schema_version','life_id','authority_session_id','room_id','native_header_hash','generation','requests','turns'])||value.schema_version!==1||value.life_id!==lifeId||value.authority_session_id!==authoritySessionId||value.room_id!==roomId||
      !Number.isSafeInteger(value.generation)||value.generation<0||!record(value.requests)||!record(value.turns)||
      value.native_header_hash!==null&&!/^[a-f0-9]{64}$/.test(value.native_header_hash??''))fail('HUMAN_TIMELINE_JOURNAL_BINDING_MISMATCH');
    for(const [id,row] of Object.entries(value.requests))if(!keys(row,['request_id','message_id','room_id','input_hash','text','occurred_at','central_state','error_code','native_turn','native_message_id'])||
      !validId(id)||row.request_id!==id||row.message_id!==id||row.room_id!==roomId||!safeCode(row.error_code)||
      typeof row.text!=='string'||Buffer.byteLength(row.text)>1024*1024||!/^[a-f0-9]{64}$/.test(row.input_hash??'')||!['pending','saved'].includes(row.central_state)||
      !Number.isFinite(Date.parse(row.occurred_at))||row.native_turn!==undefined&&(!Number.isSafeInteger(row.native_turn)||row.native_turn<0)||
      row.native_message_id!==undefined&&(typeof row.native_message_id!=='string'||!row.native_message_id))fail('INVALID_HUMAN_TIMELINE_RECEIPT');
    for(const [turn,row] of Object.entries(value.turns)) {
      if(!keys(row,['turn','origin_request_ids','occurred_at','native_end_seq','error_code','central_state','suppression_code','message_id','reply_to','text','native_assistant_seq','effect_result'])||
        !/^[0-9]+$/.test(turn)||!Number.isSafeInteger(row.turn)||row.turn!==Number(turn)||!safeCode(row.error_code)||
        !Number.isSafeInteger(row.native_end_seq)||row.native_end_seq<0||!Array.isArray(row.origin_request_ids)||!row.origin_request_ids.length||row.origin_request_ids.some(id=>!value.requests[id])||
        !['pending','saved','suppressed'].includes(row.central_state)||!Number.isFinite(Date.parse(row.occurred_at)))fail('INVALID_HUMAN_TIMELINE_REPLY_RECEIPT');
      if(row.central_state!=='suppressed'&&(typeof row.text!=='string'||!row.text||Buffer.byteLength(row.text)>1024*1024||
        typeof row.message_id!=='string'||row.reply_to!==row.origin_request_ids.at(-1)))fail('INVALID_HUMAN_TIMELINE_REPLY_RECEIPT');
      if(row.central_state==='suppressed'&&(!safeCode(row.suppression_code)||Object.hasOwn(row,'text')))fail('PRIVATE_TEXT_IN_HUMAN_TIMELINE_JOURNAL');
    }
  }
  validate(state);
  function commit(next) {
    validate(next);const actual=existsSync(file)?digest(readFileSync(file)):null;if(actual!==versionHash)fail('HUMAN_TIMELINE_STALE_WRITE');
    next.generation=state.generation+1;const content=JSON.stringify(next,null,2)+'\n',temporary=file+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx',0o600);
    try{writeFileSync(fd,content);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,file);versionHash=digest(content);state=next;
  }
  const update=fn=>{const next=copy(state);fn(next);commit(next);};
  function own(session) {
    const agent=ctx.agents.get(authoritySessionId);
    if(!enabled||!agent||agent.session!==session||session?.id!==authoritySessionId||session.header?.id!==authoritySessionId)return false;
    const bound=bridge.status?.();if(bound?.life_id&&bound.life_id!==lifeId||bound?.registered_session_id&&bound.registered_session_id!==authoritySessionId)return false;
    const header=session.header,key=digest(JSON.stringify({id:header.id,cwd:canonical(header.cwd),createdAt:header.createdAt,agentPreset:header.agentPreset??null}));
    if(state.native_header_hash===null)update(next=>{next.native_header_hash=key;});
    else if(state.native_header_hash!==key)fail('HUMAN_TIMELINE_NATIVE_INCARNATION_CHANGED');return true;
  }
  function collect(session,end,{live=false,all,start,endIndex}={}) {
    if(state.turns[String(end.data.turn)])return;
    if(!all) {
      all=[...session.ownEvents()];start=all.findLastIndex(event=>event.type==='turn/start'&&event.data.turn===end.data.turn&&event.seq<end.seq);
      endIndex=all.length-1;
    }
    if(start<0)return;
    const ids=[],seen=new Set(),nativeBindings=[];
    let mixed=false,sourceMismatch=false,lastAssistantSeq;
    for(let index=start;index<=endIndex;index++) {
      const event=all[index];if(event.seq>end.seq)continue;
      if(event.type==='user/message') {
        const source=event.data.source;
        if(source?.kind==='user'&&state.requests[source.rpcId]) {
          if(!seen.has(source.rpcId)){ids.push(source.rpcId);seen.add(source.rpcId);}
          const receipt=state.requests[source.rpcId];
          if(receipt.native_turn!==undefined&&receipt.native_turn!==end.data.turn||
            receipt.native_message_id!==undefined&&receipt.native_message_id!==event.data.id)sourceMismatch=true;
          else nativeBindings.push({requestId:source.rpcId,messageId:event.data.id});
        }else if(!snapshot(source))mixed=true;
      }
      if(event.type==='assistant/message')lastAssistantSeq=event.seq;
    }
    if(!ids.length)return;
    const occurred_at=time(end.time),base={turn:end.data.turn,origin_request_ids:ids,occurred_at,native_end_seq:end.seq,error_code:null};
    const reason=sourceMismatch?'HUMAN_SOURCE_IDENTITY_MISMATCH':mixed?'MIXED_TRIGGER_SOURCE_SUPPRESSED':'NATIVE_TEXT_IS_NOT_ROOM_SEND';
    update(next=>{
      for(const binding of nativeBindings)Object.assign(next.requests[binding.requestId],{native_turn:end.data.turn,native_message_id:binding.messageId});
      next.turns[String(end.data.turn)]={...base,central_state:'suppressed',suppression_code:reason,
        ...lastAssistantSeq!==undefined?{native_assistant_seq:lastAssistantSeq}:{}};
    });
  }
  async function saveHuman(requestId) {
    const row=state.requests[requestId];if(row.central_state==='saved')return;
    if(!enabled)fail('HUMAN_TIMELINE_DISPOSED');
    try {
      const message=await bridge.postHuman({args:{room_id:roomId,message_id:row.message_id,body:row.text},occurredAt:row.occurred_at});
      if(message?.message_id!==row.message_id||message?.sender_id!=='human:maintainer')fail('HUMAN_TIMELINE_CENTRAL_ACK_MISMATCH');
      update(next=>{next.requests[requestId].central_state='saved';next.requests[requestId].error_code=null;});lastError=null;
    }catch(error) {
      lastError=code(error);try{update(next=>{next.requests[requestId].error_code=lastError;});}catch(error){lastError=code(error);}
      fail(lastError);
    }
  }
  async function flush() {
    if(!enabled)return;
    // Human dependencies retain their authenticated input ID. Saving this
    // record never admits a native prompt or sends any Agent speech.
    for(const row of Object.values(state.requests).filter(row=>row.central_state==='pending')) {
      try{await saveHuman(row.request_id);}catch{return;}
    }
    for(const [turn,row] of Object.entries(state.turns).filter(([,row])=>row.central_state!=='suppressed')) {
      let result={status:'unknown',kind:'room_message',room_id:roomId,message_id:row.message_id,reply_to:row.reply_to,
        body_hash:digest(row.text),reason:'LEGACY_REPLY_READBACK_UNAVAILABLE'};
      if(typeof bridge.actionResult==='function')try {
        let actual=await bridge.actionResult({room_id:roomId,message_id:row.message_id,reply_to:row.reply_to});
        if(actual?.status!=='confirmed_success')actual=await bridge.actionResult({room_id:roomId,reply_to:row.reply_to});
        if(actual?.status==='confirmed_success'&&actual.room_id===roomId&&actual.reply_to===row.reply_to&&actual.body_hash===digest(row.text))
          result={status:'confirmed_success',kind:'room_message',room_id:roomId,message_id:actual.message_id,reply_to:row.reply_to,
            body_hash:actual.body_hash,...actual.observed_at?{observed_at:actual.observed_at}:{}};
        else result.reason='LEGACY_REPLY_NOT_CONFIRMED';
      }catch(error){result.error_code=code(error);}
      if(JSON.stringify(row.effect_result)!==JSON.stringify(result))update(next=>{
        next.turns[turn].effect_result=result;if(result.status==='confirmed_success')next.turns[turn].central_state='saved';
      });
    }
  }
  function scheduleRetry() {
    if(!enabled||retryTimer||!Object.values(state.requests).some(row=>row.central_state==='pending'))return;
    retryTimer=setTimeout(()=>{retryTimer=null;kick();},30000);retryTimer.unref();
  }
  function kick() {
    if(!enabled)return queue;
    queue=queue.then(flush).catch(error=>{lastError=code(error);}).finally(scheduleRetry);return queue;
  }
  function admitHuman(requestId) {
    // Admission waits for this exact screened human record, not all historical
    // retries. Keep the same serialization/CAS boundary as background repair.
    const saved=queue.then(()=>saveHuman(requestId));
    queue=saved.catch(error=>{lastError=code(error);}).finally(scheduleRetry);return saved;
  }
  function recover(session) {
    if(!Object.keys(state.requests).length||!own(session))return;
    // Native ownEvents is ordered. Inspect only event/source metadata once;
    // old user-role records without an authenticated admission receipt are
    // neither human identities nor candidates for a public reply. A candidate
    // reuses this array and its exact turn interval, without copying history.
    const all=[],starts=new Map();let lastRegistered=-1;
    for(const event of session.ownEvents()) {
      const index=all.length;all.push(event);
      if(event.type==='turn/start')starts.set(event.data.turn,index);
      else if(event.type==='user/message'&&event.data.source?.kind==='user'&&state.requests[event.data.source.rpcId])lastRegistered=index;
      else if(event.type==='turn/end'&&!state.turns[String(event.data.turn)]) {
        const start=starts.get(event.data.turn);
        if(start!==undefined&&all[start].seq<event.seq&&lastRegistered>=start)collect(session,event,{all,start,endIndex:index});
      }
    }
    kick();
  }
  function activity(session,event) {
    if(typeof bridge.recordActivity!=='function')return;
    const input=event.type==='turn/start'?{phase:'thinking'}:event.type==='turn/end'?{phase:'idle'}:
      event.type==='tool/call'?{phase:privateName(event.data.name)?'private':'tool',toolName:event.data.name}:null;
    if(!input)return;
    // Metadata is independently serialized, without holding up the native
    // event publisher, the model loop, or another owner's execution context.
    const previous=recording.get(session)??Promise.resolve(),next=previous.then(()=>bridge.recordActivity(input)).then(result=>{
      metadataError=result?.error_code??null;
    }).catch(error=>{metadataError=code(error);});recording.set(session,next);
  }
  const facade=Object.freeze({
    async recordHumanTurn({requestId,text,occurredAt}) {
      if(!enabled)fail('HUMAN_TIMELINE_DISPOSED');
      if(!validId(requestId)||typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>1024*1024)fail('EXPLICIT_AUTHENTICATED_HUMAN_REQUEST_REQUIRED');
      if(occurredAt!==undefined&&(typeof occurredAt!=='string'||!Number.isFinite(Date.parse(occurredAt))||time(occurredAt)!==occurredAt))
        fail('HUMAN_TIMELINE_EVENT_TIME_REQUIRED');
      const input_hash=digest(text),old=state.requests[requestId];if(old&&old.input_hash!==input_hash)fail('HUMAN_REQUEST_ID_CONFLICT');
      try {
        if(!old) {
          const safeText=screen(text);if(typeof safeText!=='string'||Buffer.byteLength(safeText)>1024*1024)fail('HUMAN_TIMELINE_SCREENING_FAILED');
          update(next=>{next.requests[requestId]={request_id:requestId,message_id:requestId,room_id:roomId,input_hash,text:safeText,
            occurred_at:occurredAt??new Date().toISOString(),central_state:'pending',error_code:null};});
        }
      }catch(error){lastError=code(error);fail(lastError);}
      await admitHuman(requestId);if(!enabled)fail('HUMAN_TIMELINE_DISPOSED');
      const row=state.requests[requestId];if(row.central_state!=='saved')fail('HUMAN_TIMELINE_CENTRAL_SAVE_REQUIRED');
      return {state:row.central_state,local_state:'saved',central_state:row.central_state,request_id:requestId,
        message_id:row.message_id,occurred_at:row.occurred_at,...row.error_code?{error_code:row.error_code}:{}};
    },
    status:()=>freeze({enabled,life_id:lifeId,authority_session_id:authoritySessionId,room_id:roomId,
      human_receipts:Object.keys(state.requests).length,human_pending:Object.values(state.requests).filter(row=>row.central_state==='pending').length,
      reply_pending:Object.values(state.turns).filter(row=>row.central_state==='pending').length,replies_saved:Object.values(state.turns).filter(row=>row.central_state==='saved').length,
      replies_suppressed:Object.values(state.turns).filter(row=>row.central_state==='suppressed').length,
      health_notices:Object.values(state.turns).filter(row=>row.central_state!=='suppressed'&&row.effect_result?.status!=='confirmed_success').map(row=>({
        notice_id:'legacy-reply-unknown:'+authoritySessionId+':'+row.turn,code:'LEGACY_REPLY_EFFECT_UNKNOWN',life_id:lifeId,session_id:authoritySessionId,
        room_id:roomId,message_id:row.message_id,reply_to:row.reply_to,result:'unknown'})),
      error_code:lastError,activity_error_code:metadataError,timestamp_semantics:'actual-host-source-time+central-observed-at',automatic_wakeup:false,automatic_room_reply:false}),
    async drain() {
      try{const session=ctx.agents.get(authoritySessionId)?.session;if(session)recover(session);}catch(error){lastError=code(error);}
      await kick();const session=ctx.agents.get(authoritySessionId)?.session;if(session)await recording.get(session);return facade.status();
    },
    dispose() {if(!enabled)return;enabled=false;if(retryTimer)clearTimeout(retryTimer);retryTimer=null;for(const dispose of disposers)dispose();}
  });
  disposers.push(ctx.on('session/event',(session,event)=>{
    try {
      if(!own(session))return;activity(session,event);
      if(event.type==='turn/end'){collect(session,event,{live:true});kick();}
    }catch(error){lastError=code(error);}
  }));
  disposers.push(ctx.on('agent/created',({agent})=>{try{if(agent?.session?.id===authoritySessionId)recover(agent.session);}catch(error){lastError=code(error);}}));
  if(typeof ctx.effect==='function')ctx.effect(()=>()=>facade.dispose(),'legacy authenticated human timeline journal');
  try{const session=ctx.agents.get(authoritySessionId)?.session;if(session)recover(session);else kick();}catch(error){lastError=code(error);}
  return facade;
}
