import {findTurnActionResult} from '../recent-events/action-result.mjs';

// Execution evidence comes from the native journal. Inbox disposition and a
// Room's durable effect receipts are separate authorities; a failed turn never
// turns an already successful tool result into a failed effect.
const readOnlyTools=new Set(['read','read_source','list_files','skill','life_action_result','life_receive_message','life_room_read','life_room_list','life_contact_list','life_event_read','life_message_timeline','observe_life','life_session_read','life_session_list','memory_search','memory_open','memory_catalog','memory_pending','memory_status','life_resource_status']);
const provenNoEffectCodes=new Set(['TOOL_NOT_STARTED','ABORTED_BEFORE_DISPATCH','UNKNOWN_TOOL','INVALID_ARGS','ROOM_ACTION_NOT_COMMITTED']);
const safeCode=code=>/^[A-Z_][A-Z0-9_]{0,127}$/.test(String(code??''))?String(code):null;

function requestFailure(reason,base) {
  const code=String(reason.error?.code??'UNKNOWN'),status=reason.error?.status??reason.error?.statusCode;
  const temporary=reason.error?.retryable===true||['TRANSPORT','RATE_LIMIT','TIMEOUT','SERVER_ERROR','OVERLOADED','NETWORK'].includes(code)||status===429||status>=500;
  return {...base,state:'failed',error_code:safeCode(code)??'PROVIDER_FAILURE',
    retryable:base.no_effect_dispatch_proven===true&&base.assistant_committed!==true&&temporary};
}

function interruptedExecution(base,durableBeforeModel) {
  // Official checkpoint policy flushes every call before its body. In a closed
  // recovered turn this proves no external effect was dispatched; it says
  // nothing about whether a Provider accepted or charged for the model request.
  const safe=durableBeforeModel&&base.turn_end_seq!==null&&base.tool_start_count===0&&!base.assistant_committed;
  return {...base,state:'interrupted',no_effect_dispatch_proven:!!safe,retryable:!!safe,
    ...(safe?{error_code:'NATIVE_TURN_INTERRUPTED_BEFORE_EFFECT'}:{})};
}

function preInputClaim(events,requestId) {
  const lists={'next-turn':[],'next-step':[]};let active=null,claim=null;
  for(const event of events) {
    if(event.type==='turn/start')active=event;
    else if(event.type==='turn/end')active=null;
    if(event.type!=='agent/inbox/spliced')continue;
    const data=event.data,list=lists[data.target];
    if(!list||!Number.isSafeInteger(data.start)||data.start<0||data.start>list.length)continue;
    const removed=list.splice(data.start,data.removedCount??0,...(data.inserted??[]).map(message=>({id:message.id,rpcId:message.source?.rpcId})));
    if(removed.some(message=>message.rpcId===requestId)&&data.outcome!=='canceled'&&active)
      claim={turn:active.data.turn,turn_start_seq:active.seq,claim_seq:event.seq};
  }
  return claim;
}

function resultForCall(event,call) {
  const message=event.data?.message;
  return event.type==='tool/result'&&(event.surfaceOp===undefined||event.surfaceOp==='append')&&
    message?.source?.kind==='tool'&&message.source.callId===call.call_id&&message.toolCallId===call.call_id&&
    event.data.turn===call.turn&&event.data.step===call.step&&
    (call.call_seq===null||event.seq>call.call_seq)&&
    (call.call_seq===null?event.data.error?.code==='TOOL_NOT_STARTED'&&event.sourceEventSeqs===undefined:
      Array.isArray(event.sourceEventSeqs)&&event.sourceEventSeqs.length===1&&event.sourceEventSeqs[0]===call.call_seq);
}

function explicitEffectResult(event) {
  const statuses=new Set(['confirmed_success','confirmed_failure','unknown']);
  const meta=event.data.meta?.effect_result;
  if(statuses.has(meta?.status))return meta;
  const blocks=event.data.message?.content??[];
  if(blocks.some(block=>block.type!=='text'||typeof block.text!=='string'))return null;
  try {
    const value=JSON.parse(blocks.map(block=>block.text).join('\n'));
    return statuses.has(value?.effect_result?.status)?value.effect_result:null;
  }catch{return null;}
}

// A result can prove tool success. A mutation error cannot prove rollback:
// transport, EPERM, output projection failure and lost ACK may follow a commit.
function effectResults(range) {
  const calls=new Map();
  for(const event of range) {
    if(event.type==='assistant/message')for(const block of event.data.message?.content??[])if(block.type==='tool-call') {
      if(!calls.has(block.id))calls.set(block.id,{call_id:block.id,tool_name:block.name,turn:event.data.turn,step:event.data.step,call_seq:null});
    }
    if(event.type==='tool/call') {
      const key=event.data.callId??'seq:'+event.seq,prior=calls.get(key);
      calls.set(key,{call_id:event.data.callId??null,tool_name:event.data.name,
        turn:event.data.turn,step:event.data.step,call_seq:event.seq,
        ambiguous:prior?.ambiguous===true||prior?.call_seq!=null});
    }
  }
  return [...calls.values()].map(call=>{
    const results=range.filter(event=>resultForCall(event,call)),result=results.length===1?results[0]:null;
    const errorCode=safeCode(result?.data.error?.code),isError=result?.data.message?.isError===true||result?.data.error!==undefined;
    const explicit=result?explicitEffectResult(result):null;
    let status='unknown';
    if(call.ambiguous)return {call_id:call.call_id,tool_name:call.tool_name,call_seq:call.call_seq,result_seq:null,status:'unknown',kind:'native_tool_return',reason:'NATIVE_CALL_ID_AMBIGUOUS'};
    if(explicit)status=explicit.status;
    else if(result&&!isError)status='confirmed_success';
    else if(result&&errorCode!=='TOOL_OUTCOME_UNKNOWN'&&(provenNoEffectCodes.has(errorCode)||readOnlyTools.has(call.tool_name)))status='confirmed_failure';
    return {call_id:call.call_id,tool_name:call.tool_name,call_seq:call.call_seq,result_seq:result?.seq??null,status,
      kind:explicit?'effect_result':'native_tool_return',
      ...(errorCode?{error_code:errorCode}:{}),...(results.length>1?{error_code:'MULTIPLE_NATIVE_TOOL_RESULTS'}:{})};
  });
}

// Read one owned Session's objective tool receipt. Absence is unknown, never
// proof that an outward action failed. Arguments and rendered bodies stay in
// the native journal and are deliberately excluded from this metadata view.
export function nativeToolResultForCall({events,callId}) {
  const unknown=reason=>({status:'unknown',kind:'native_tool_return',reason});
  if(!Array.isArray(events)||typeof callId!=='string'||!callId)return unknown('NATIVE_CALL_NOT_FOUND');
  const starts=events.filter(event=>event.type==='tool/call'&&event.data?.callId===callId);
  if(starts.length>1)return unknown('NATIVE_CALL_ID_AMBIGUOUS');
  const requests=events.filter(event=>event.type==='assistant/message'&&event.data?.message?.content?.some(block=>block.type==='tool-call'&&block.id===callId));
  if(!starts.length&&requests.length!==1)return unknown(requests.length?'NATIVE_CALL_ID_AMBIGUOUS':'NATIVE_CALL_NOT_FOUND');
  const anchor=starts[0]??requests[0],range=events.filter(event=>event.data?.turn===anchor.data.turn&&event.data?.step===anchor.data.step);
  return effectResults(range).find(result=>result.call_id===callId)??unknown('NATIVE_CALL_NOT_FOUND');
}

function turnEvidence(events,start,end) {
  const next=events.find(event=>event.type==='turn/start'&&event.seq>start.seq);
  const range=events.filter(event=>event.seq>=start.seq&&event.seq<=(end?.seq??Infinity)&&(!next||event.seq<next.seq));
  const toolCalls=range.filter(event=>event.type==='tool/call'),assistantCommitted=range.some(event=>event.type==='assistant/message');
  return {turn:start.data.turn,turn_start_seq:start.seq,turn_end_seq:end?.seq??null,
    assistant_committed:assistantCommitted,tool_call_count:toolCalls.length,tool_start_count:toolCalls.length,
    no_effect_dispatch_proven:!!end&&toolCalls.length===0,effect_results:effectResults(range)};
}

export function nativeInboxEvidence({events,pending=[],requestId,running=false,durableBeforeModel=false}) {
  const matching=pending.filter(message=>message.source?.rpcId===requestId),empty={effect_results:[]};
  if(matching.length>1)return {...empty,state:'ambiguous',error_code:'MULTIPLE_NATIVE_PENDING_COPIES'};
  const input=events.filter(event=>event.type==='user/message'&&event.data.source?.rpcId===requestId);
  if(input.length>1)return {...empty,state:'ambiguous',error_code:'MULTIPLE_MATERIALIZED_NATIVE_INPUTS'};
  // A stale pending projection cannot override a durable consumed RPC.
  if(!input.length&&matching.length)return {...empty,state:'pending',native_message_id:matching[0].id};
  if(!input.length) {
    const claim=preInputClaim(events,requestId);
    if(claim) {
      const start=events.find(event=>event.seq===claim.turn_start_seq),end=events.find(event=>event.type==='turn/end'&&event.data.turn===claim.turn&&event.seq>claim.claim_seq);
      const base={...turnEvidence(events,start,end),...claim,pre_input:true,model_execution_proven:false};
      if(end?.data.reason?.kind==='error')return requestFailure(end.data.reason,base);
      if(end?.data.reason?.kind==='aborted')return {...base,state:'cancelled',retryable:false,cancel_kind:end.data.reason.reason?.kind??'unknown'};
      if(!end&&running)return {...base,state:'running'};
      if(end&&end.data.reason?.kind!=='interrupted')return {...base,state:'failed',error_code:'MODEL_PREPARATION_BLOCKED',retryable:false};
      if(end)return interruptedExecution(base,durableBeforeModel);
      return {...base,state:'ambiguous',error_code:'PRE_INPUT_CLAIM_OUTCOME_UNKNOWN',retryable:false};
    }
    const inserted=events.some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted?.some(message=>message.source?.rpcId===requestId));
    return {...empty,state:inserted&&!durableBeforeModel?'ambiguous':'absent',model_execution_proven:false};
  }
  const message=input[0],start=events.findLast(event=>event.type==='turn/start'&&event.seq<message.seq);
  if(!start)return {...empty,state:'ambiguous',error_code:'MATERIALIZED_INPUT_WITHOUT_TURN'};
  const end=events.find(event=>event.type==='turn/end'&&event.data.turn===start.data.turn&&event.seq>message.seq);
  const base={...turnEvidence(events,start,end),native_message_id:message.data.id??null,user_message_seq:message.seq};
  if(!end)return {...base,state:running?'running':'interrupted',retryable:false};
  const reason=end.data.reason;
  if(reason?.kind==='completed') {
    // The ACK records the Agent's decision. ACK parsing or turn failure cannot
    // invalidate successful effect receipts; retain those results separately.
    try {
      const ack=findTurnActionResult(events,{turn:start.data.turn,startSeq:start.seq,endSeq:end.seq});
      return {...base,state:'completed',retryable:false,...ack?{action_result:ack.result,machine_ack:true,ack_event_seq:ack.event_seq}:{}};
    }catch(error) {return {...base,state:'completed',retryable:false,ack_error_code:error.code??'ACTION_RESULT_ACK_INVALID'};}
  }
  if(reason?.kind==='aborted')return {...base,state:'cancelled',retryable:false,cancel_kind:reason.reason?.kind??'unknown'};
  if(reason?.kind==='interrupted')return interruptedExecution(base,durableBeforeModel);
  if(reason?.kind==='error')return requestFailure(reason,base);
  return {...base,state:'failed',error_code:reason?.kind==='max-tokens'?'MODEL_OUTPUT_LIMIT':'MODEL_TURN_BLOCKED',retryable:false};
}

export function batchInboxSelection(items,{human_idle=false,peer_idle=true,rest=false,now=Date.now(),maxItems=20,maxBytes=128*1024,coalesceMs=250}={}) {
  if(rest)return {items:[],reason:'rest'};
  const explicit=item=>item.status==='pending'&&item.requested===true||item.status==='requested';
  const firstOrSafeRetry=item=> {
    // A human input already saved into its trusted native Session has its own
    // continuation. It is visible here, but must not enter a second idle wake.
    if(!item.attempt&&item.native_ingress)return false;
    if(item.status==='pending') {
      if(!item.attempt)return item.migration?.from_status===undefined||['queued','pending'].includes(item.migration.from_status);
      // Existing absent/pending attempts are resumed by the native controller
      // with their original MessageId, not selected into a new batch.
      return ['failed','interrupted'].includes(item.attempt.state)&&item.attempt.retryable===true&&Date.parse(item.attempt.retry_after??item.retry_after??0)<=now;
    }
    // Old rows are accepted only while their durable migration is in flight.
    return item.status==='queued'||item.status==='failed'&&item.attempt?.retryable===true&&
      item.attempt.native_evidence?.no_effect_dispatch_proven===true&&item.attempt.native_evidence?.assistant_committed!==true&&Date.parse(item.attempt.retry_after??item.retry_after??0)<=now;
  };
  const eligible=items.filter(item=>!['prepared','absent','pending','running'].includes(item.attempt?.state)&&
    (explicit(item)||firstOrSafeRetry(item)&&
    (item.message?.sender_type==='human'?human_idle:item.message?.sender_type==='life'&&peer_idle))).sort((a,b)=>a.inbox_seq-b.inbox_seq);
  if(!eligible.length)return {items:[],reason:'idle'};
  if(!explicit(eligible[0])&&!eligible[0].attempt&&now-Date.parse(eligible[0].received_at)<coalesceMs)return {items:[],reason:'coalescing'};
  let bytes=0;const selected=[];
  for(const item of eligible) {
    const size=Buffer.byteLength(JSON.stringify(item.message));
    if(selected.length>=maxItems||selected.length&&bytes+size>maxBytes)break;
    selected.push(item);bytes+=size;
  }
  return {items:selected,bytes,reason:'selected'}; // Whole records, never truncate.
}
