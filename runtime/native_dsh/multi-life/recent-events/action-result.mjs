// A machine ACK is an explicit protocol result, never the absence of speech.
// This module reads native evidence only. Explicit input choices commit at a
// durable ACK; turn/end subsequently finalizes execution history.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const allowed=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const MAX_ACK_BYTES=2*1024*1024;
function fail(code='ACTION_RESULT_ACK_INVALID',details) {throw Object.assign(new Error(details?code+': '+JSON.stringify(details):code==='ACTION_RESULT_ACK_MISSING'?'A machine action result ACK is required.':'The machine action result ACK is invalid.'),{code,...details?{details}:{}});}
function identifier(value) {return typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);}
function unwrap(text) {
  if(typeof text!=='string'||!text.trim())fail('ACTION_RESULT_ACK_MISSING');
  if(Buffer.byteLength(text)>MAX_ACK_BYTES)fail();
  const trimmed=text.trim(),fence=trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u);
  return fence?fence[1].trim():trimmed;
}
// JSON.parse accepts duplicate object keys. Reject them so contradictory status
// fields cannot disappear before the protocol validator sees them.
function rejectDuplicateKeys(text) {
  let offset=0;
  const space=()=>{while(/\s/u.test(text[offset]??'')&&offset<text.length)offset++;};
  function string() {
    const start=offset++;
    while(offset<text.length) {const char=text[offset++];if(char==='\\')offset++;else if(char==='"')return JSON.parse(text.slice(start,offset));}
    fail();
  }
  function value(depth=0) {
    if(depth>64)fail();space();const char=text[offset];
    if(char==='{') {offset++;space();const keys=new Set();if(text[offset]==='}') {offset++;return;}
      for(;;) {space();const key=string();if(keys.has(key))fail();keys.add(key);space();offset++;value(depth+1);space();if(text[offset++]==='}')return;}
    }
    if(char==='[') {offset++;space();if(text[offset]===']') {offset++;return;}for(;;){value(depth+1);space();if(text[offset++]===']')return;}}
    if(char==='"') {string();return;}
    const match=text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u);if(!match)fail();offset+=match[0].length;
  }
  value();space();if(offset!==text.length)fail();
}
function strictJson(text) {
  const raw=unwrap(text);let result;try{result=JSON.parse(raw);}catch{fail();}rejectDuplicateKeys(raw);return result;
}
function utc(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value))fail();
  const milliseconds=Date.parse(value);if(!Number.isFinite(milliseconds))fail();const normalized=new Date(milliseconds).toISOString();
  if(normalized!==value&&normalized.replace('.000Z','Z')!==value)fail();return normalized;
}
function normalize(value) {
  if(!allowed(value,['status','disposition','actions','records','completed_event_ids'])||value.status!=='ok'||!['acted','silent','deferred'].includes(value.disposition)||!Array.isArray(value.actions)||value.actions.length>100)fail();
  if(value.disposition==='silent'&&value.actions.length)fail();
  const actions=value.actions.map(action=>{
    if(action?.type==='send_message') {
      const targets=['conversation_id','to_actor_id','public_area_id'].filter(key=>Object.hasOwn(action,key));
      if(!allowed(action,['type','conversation_id','to_actor_id','public_area_id','body','reply_to'])||targets.length!==1||!identifier(action[targets[0]])||typeof action.body!=='string'||!action.body.trim()||Buffer.byteLength(action.body)>1024*1024||action.reply_to!==undefined&&!identifier(action.reply_to))fail();
      return Object.freeze({type:'send_message',[targets[0]]:action[targets[0]],body:action.body,...action.reply_to===undefined?{}:{reply_to:action.reply_to}});
    }
    if(action?.type==='defer') {
      if(!allowed(action,['type','event_id','until'])||!identifier(action.event_id)||!Object.hasOwn(action,'until'))fail();
      return Object.freeze({type:'defer',event_id:action.event_id,until:action.until===null?null:utc(action.until)});
    }
    fail();
  });
  const completed=value.completed_event_ids;
  if(completed!==undefined&&(!Array.isArray(completed)||completed.length>100||new Set(completed).size!==completed.length||completed.some(id=>!identifier(id))))fail();
  if(completed!==undefined&&actions.some(action=>action.type==='defer'&&completed.includes(action.event_id)))fail('ACTION_RESULT_ACK_CONFLICT');
  const records=value.records===undefined?undefined:normalizeTurnRecords(value.records);
  return Object.freeze({status:'ok',disposition:value.disposition,actions:Object.freeze(actions),...(records===undefined?{}:{records}),...(completed===undefined?{}:{completed_event_ids:Object.freeze([...completed])})});
}

// Self-authored factual results, not reasoning and not automatic long-term memory.
// The Host attaches actor, audience, Session, batch and task; none is model-selectable.
export function normalizeTurnRecords(records) {
  if(!Array.isArray(records)||records.length>64)fail('TURN_RECORDS_INVALID');
  const keys=new Set();
  return Object.freeze(records.map((record,index)=>{
    const invalid=(field,reason)=>fail('TURN_RECORDS_INVALID',{field:'records['+index+'].'+field,record_key:identifier(record?.key)?record.key:null,reason});
    if(record?.state!==undefined&&record.state_key===undefined)invalid('state_key','required_when_state_is_set');
    if(!allowed(record,['key','kind','summary','importance','related_task','follow_up','state_key','state','evidence_event_ids','occurred_at_utc'])||
      !identifier(record.key)||keys.has(record.key)||!['finding','change','outcome','issue','decision','communication','state'].includes(record.kind)||
      typeof record.summary!=='string'||!record.summary.trim()||Buffer.byteLength(record.summary)>8000||
      record.importance!==undefined&&!['normal','persistent'].includes(record.importance)||
      record.state!==undefined&&!['open','waiting','blocked','done','cancelled'].includes(record.state)||
      record.state_key!==undefined&&!identifier(record.state_key)||record.state!==undefined&&record.state_key===undefined)invalid('record','invalid_shape_value_or_duplicate_key');
    keys.add(record.key);
    for(const field of ['related_task','follow_up'])if(record[field]!==undefined&&record[field]!==null&&(typeof record[field]!=='string'||Buffer.byteLength(record[field])>4000))invalid(field,'invalid_type_or_size');
    if(record.evidence_event_ids!==undefined&&(!Array.isArray(record.evidence_event_ids)||record.evidence_event_ids.length>64||new Set(record.evidence_event_ids).size!==record.evidence_event_ids.length||record.evidence_event_ids.some(id=>!identifier(id))))invalid('evidence_event_ids','invalid_or_duplicate_identifier');
    return Object.freeze({...record,importance:record.importance??'normal',occurred_at_utc:record.occurred_at_utc==null?null:utc(record.occurred_at_utc),...(record.evidence_event_ids===undefined?{}:{evidence_event_ids:Object.freeze([...record.evidence_event_ids])})});
  }));
}

export function parseActionResult(text) {return normalize(strictJson(text));}
// Only the native finish tool uses defaults. Arbitrary assistant text remains
// strictly validated and never substitutes for a genuine tool receipt.
export function normalizeFinishArguments(value) {
  if(!allowed(value,['status','disposition','actions','records','completed_event_ids']))fail();
  if(value.status!==undefined&&value.disposition!==undefined&&value.actions!==undefined)return normalize(value);
  return normalize({status:'ok',disposition:'acted',actions:[],records:[],completed_event_ids:[],...value});
}
export function isMachineActionResult(text) {try{parseActionResult(text);return true;}catch{return false;}}
// Publication guard: an invalid ACK is still protocol material and must not be
// echoed to a human as the life deciding to speak.
export function looksLikeActionResult(text) {
  if(typeof text!=='string')return false;
  return /"(?:status|disposition)"\s*:/u.test(text)&&/\{/u.test(text)||/^\s*status\s*:/mu.test(text)&&/^\s*disposition\s*:/mu.test(text);
}

function messageText(message,{assistant=false}={}) {
  if(!Array.isArray(message?.content)||message.content.some(block=>block?.type!=='text'&&!(assistant&&block?.type==='reasoning')))return null;
  const text=message.content.filter(block=>block.type==='text').map(block=>typeof block.text==='string'?block.text:null);
  return text.some(value=>value===null)?null:text.join('\n');
}
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const executionEvents=new Set(['assistant/attempt','assistant/message','tool/call','tool/result']);

/** Find an explicit ACK in a single native turn window.
 * The return value is an ACK candidate, not proof of overall turn success.
 * A failed/interrupted turn remains a failure even after a successful ACK tool.
 */
export function findTurnActionResult(events,{turn,startSeq=0,endSeq=Infinity}={}) {
  if(!Array.isArray(events)||!Number.isSafeInteger(turn)||turn<0||!Number.isSafeInteger(startSeq)||startSeq<0||endSeq!==Infinity&&(!Number.isSafeInteger(endSeq)||endSeq<startSeq))fail();
  const range=events.filter(event=>Number.isSafeInteger(event?.seq)&&event.seq>=startSeq&&event.seq<=endSeq&&event.data?.turn===turn).sort((left,right)=>left.seq-right.seq);
  const calls=new Map(),candidates=[];
  for(const event of range) {
    if(event.type==='tool/call'&&event.data.name==='life_turn_ack') {
      const id=event.data.callId;if(!identifier(id)||calls.has(id))fail('ACTION_RESULT_ACK_AMBIGUOUS');calls.set(id,event);continue;
    }
    if(event.type!=='tool/result')continue;
    const message=event.data.message,call=calls.get(message?.source?.callId);
    if(!call||message?.source?.kind!=='tool'||message?.role!=='tool'||message.toolCallId!==call.data.callId||event.seq<=call.seq||event.data.step!==call.data.step)continue;
    if(event.sourceEventSeqs!==undefined&&(!Array.isArray(event.sourceEventSeqs)||event.sourceEventSeqs.length!==1||event.sourceEventSeqs[0]!==call.seq))continue;
    if(message.isError===true||event.data.error!==undefined)continue;
    const text=messageText(message);if(text===null)fail();const wrapper=strictJson(text);
    if(!plain(wrapper)||wrapper.acknowledged!==true||!Object.hasOwn(wrapper,'result'))fail();
    const result=normalize(wrapper.result),argumentsResult=normalizeFinishArguments(strictJson(call.data.arguments));
    if(!equal(result,argumentsResult))fail('ACTION_RESULT_ACK_CONFLICT');
    candidates.push({result,source:'tool',machine_ack:true,event_seq:event.seq,call_id:call.data.callId});
  }
  const final=range.findLast(event=>event.type==='assistant/message');
  if(final&&!final.data.interrupted&&final.data.message?.role==='assistant') {
    const text=messageText(final.data.message,{assistant:true});
    if(text!==null&&looksLikeActionResult(text))candidates.push({result:parseActionResult(text),source:'assistant',machine_ack:true,event_seq:final.seq});
  }
  if(!candidates.length)return null;
  if(candidates.some(candidate=>!equal(candidate.result,candidates[0].result)))fail('ACTION_RESULT_ACK_CONFLICT');
  // The first successful tool ACK must be terminal. A later matching ACK cannot
  // hide intervening model/tool work. Native lifecycle/checkpoint metadata is
  // not another execution, and other turns are outside this evidence window.
  const terminal=candidates.find(candidate=>candidate.source==='tool')??candidates.at(-1);
  if(range.some(event=>event.seq>terminal.event_seq&&executionEvents.has(event.type)))fail('ACTION_RESULT_ACK_NOT_TERMINAL');
  return Object.freeze(terminal);
}
