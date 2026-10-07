import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import {parseActionResult} from '../multi-life/recent-events/action-result.mjs';

export const PRIVATE_NAMES = ['private_write', 'private_read', 'private_search', 'private_list', 'private_delete'];
export const PLACEHOLDER = '[Private Vault：私人执行内容未保存到普通会话；请使用 private_read 再次读取]';
const privateCall = data => {
  if (!data || typeof data !== 'object') return false;
  if (PRIVATE_NAMES.includes(data.name)) return true;
  return Object.values(data).some(value => value && typeof value === 'object' && privateCall(value));
};

// This exception is a terminal Host receipt, never a private-content export.
// Reuse the same strict protocol parser as the recent-event worker.
export function isPrivateCompletionAck(value) {
  try {
    if(typeof value!=='string'&&(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||
      Reflect.ownKeys(value).length!==3||Reflect.ownKeys(value).some(key=>!['status','disposition','actions'].includes(key))||
      !Array.isArray(value.actions)||value.actions.length!==0||Reflect.ownKeys(value.actions).length!==1))return false;
    return parseActionResult(typeof value==='string'?value:JSON.stringify(value)).actions.length===0;
  }catch{return false;}
}
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);
const ownerSession=(ctx,session)=>{
  const header=session?.header;if(!header||header.id!==session.id||header.origin==='subagent'||(header.delegationDepth??0)!==0)return false;
  if(ctx.multiLifeContexts?.registry){try{return ctx.multiLifeContexts.registry.owner(session.id).role!=='delegate';}catch{return false;}}
  return true;
};
function safeAckResult(data,call) {
  const message=data?.message;
  if(!call||data.turn!==call.turn||data.step!==call.step||data.error!==undefined||message?.role!=='tool'||message.isError!==false||message.toolCallId!==call.callId||
    message.source?.kind!=='tool'||message.source.callId!==call.callId||!Array.isArray(message.content)||message.content.length!==1||message.content[0].type!=='text')return null;
  let wrapper;try{wrapper=JSON.parse(message.content[0].text);if(JSON.stringify(wrapper)!==message.content[0].text)return null;}catch{return null;}
  if(!wrapper||typeof wrapper!=='object'||Array.isArray(wrapper)||Object.keys(wrapper).length!==3||Object.keys(wrapper).some(key=>!['acknowledged','result','delivery_batch_id'].includes(key))||
    wrapper.acknowledged!==true||!identifier(wrapper.delivery_batch_id)||!isPrivateCompletionAck(wrapper.result))return null;
  const result=parseActionResult(JSON.stringify(wrapper.result));if(JSON.stringify(result)!==JSON.stringify(call.result))return null;
  return {turn:data.turn,step:data.step,message:{...identifier(message.id)?{id:message.id}:{},role:'tool',toolCallId:call.callId,isError:false,
    source:{kind:'tool',callId:call.callId},content:[{type:'text',text:JSON.stringify({acknowledged:true,result,delivery_batch_id:wrapper.delivery_batch_id})}]}};
}

function sanitize(data) {
  const result = structuredClone(data);
  if (result.message) {
    result.message.content = result.message.content.map(block => block.type === 'tool-call'
      ? { type: 'tool-call', id: block.id, name: block.name, arguments: '{}' }
      : { type: 'text', text: PLACEHOLDER });
    if (result.message.source) delete result.message.source.replayState;
  }
  if ('stream' in result) result.stream = [];
  if ('arguments' in result) result.arguments = '{}';
  if ('error' in result) result.error = { name: 'PrivateVaultError', message: 'PRIVATE_EXECUTION_ERROR' };
  if ('failure' in result) result.failure = { code: 'PRIVATE_EXECUTION_ERROR', message: 'PRIVATE_EXECUTION_ERROR' };
  if ('meta' in result) {
    const status = result.meta?.privateVault;
    result.meta = status && PRIVATE_NAMES.includes(status.operation) && typeof status.ok === 'boolean'
      ? { privateVault: { operation: status.operation, ok: status.ok,
        ...(/^VAULT_[A-Z_]+$/.test(status.error ?? '') ? { error: status.error } : {}) } } : null;
  }
  if (result.reason?.error) result.reason = { kind: result.reason.kind, error: { message: 'PRIVATE_EXECUTION_ERROR' } };
  return result;
}

// Interpose before Session publishes its immutable event to persistence/query/UI.
// Original messages exist only in a turn-local volatile map, never in the event log.
export function installSessionPrivacy(ctx) {
  const states = new WeakMap();
  const install = session => {
    if (states.has(session)) return;
    const state = { active: false, lastPrivate: false, messages: new Map(), safeAckCalls: new Map() };
    states.set(session, state);
    const append = session.append.bind(session);
    const derive = session.deriveEventMessage.bind(session);
    session.deriveEventMessage = event => state.messages.has(event.seq)
      ? deriveEventMessage({ ...event, data: state.messages.get(event.seq) }) : derive(event);
    session.append = (type, data, ...opts) => {
      if (type === 'turn/start') state.lastPrivate = false;
      // Tool declarations in request/header are public capability inventory,
      // not invocations; only assistant settlements and started calls activate privacy.
      if (['assistant/message', 'assistant/attempt', 'tool/call'].includes(type) && privateCall(data)) {
        state.active = true; state.lastPrivate = true;
      }
      const sensitive = state.active && (/^(assistant\/|tool\/|compaction\/)/.test(type) || type === 'turn/end');
      let persisted=sensitive?sanitize(data):data;
      if(sensitive&&ownerSession(ctx,session)) {
        if(type==='assistant/message'||type==='assistant/attempt') {
          // The native v4 journal binds started calls to their declarations by
          // exact arguments. Preserve only this body-free protocol declaration.
          if(Array.isArray(data.message?.content))persisted.message.content= data.message.content.map((block,index)=>
            block.type==='tool-call'&&block.name==='life_turn_ack'&&identifier(block.id)&&isPrivateCompletionAck(block.arguments)
              ?{type:'tool-call',id:block.id,name:'life_turn_ack',arguments:JSON.stringify(parseActionResult(block.arguments))}
              :persisted.message.content[index]);
        }else if(type==='tool/call'&&data.name==='life_turn_ack'&&identifier(data.callId)&&isPrivateCompletionAck(data.arguments)) {
          const result=parseActionResult(typeof data.arguments==='string'?data.arguments:JSON.stringify(data.arguments));state.safeAckCalls.set(data.callId,{turn:data.turn,step:data.step,callId:data.callId,result});
          persisted={turn:data.turn,step:data.step,callId:data.callId,name:'life_turn_ack',arguments:JSON.stringify(result)};
        }else if(type==='tool/result')persisted=safeAckResult(data,state.safeAckCalls.get(data.message?.toolCallId))??persisted;
      }
      const event = append(type, persisted, ...opts);
      if (sensitive && data.message) state.messages.set(event.seq, structuredClone(data));
      if (type === 'turn/end') {
        state.active = false; state.messages.clear();state.safeAckCalls.clear();
        // Native derived-message cache must stop retaining private results too.
        session.derived = []; session.derivedNodes = 0;
      }
      return event;
    };
  };
  ctx.on('session/created', install);
  for (const session of ctx.sessions.list()) install(session);
  return { active: session => states.get(session)?.active === true,
    sensitive: session => states.get(session)?.lastPrivate === true };
}
