import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {IncomingMessage,ServerResponse} from 'node:http';
import {isAbsolute,resolve} from 'node:path';
import {mkdirSync,existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';

export const inject=['connection','sessionController','agents','agentPresets'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const id=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const utc=value=>{const date=new Date(value);if(!Number.isFinite(date.valueOf()))fail('HUMAN_INPUT_TIME_INVALID');return date.toISOString();};
const key=(sessionId,requestId)=>hash(JSON.stringify([sessionId,requestId]));
function text(content) {
  if(!Array.isArray(content)||!content.length||content.some(part=>!plain(part)||part.type!=='text'||typeof part.text!=='string'||Reflect.ownKeys(part).some(name=>!['type','text'].includes(name))))return null;
  const body=content.map(part=>part.text).join('\n');return body.trim()?body:null;
}
function signature(request) {
  if(!plain(request)||!id(request.sessionId)||!id(request.requestId)||text(request.content)===null)return null;
  return JSON.stringify([request.sessionId,request.requestId,request.mode,request.clientTimeZone??null,request.content.map(part=>part.text)]);
}
function fingerprint(agent) {
  const session=agent?.session,header=session?.header;
  if(!header||!id(session.id)||header.id!==session.id||!Number.isSafeInteger(header.createdAt)||header.createdAt<0||!id(header.cwd)||header.origin==='subagent'||(header.delegationDepth??0)!==0)return null;
  return hash(JSON.stringify([header.version??null,header.id,header.createdAt,header.cwd,header.agentPreset??null,header.parentSession??null,header.isSeeded??false,header.origin??null,header.delegationDepth??0]));
}
function methodDescriptor(object,name) {
  for(let target=object;target;target=Object.getPrototypeOf(target)){const descriptor=Object.getOwnPropertyDescriptor(target,name);if(descriptor)return descriptor;}
  return null;
}
function nativeEvidence(agent,requestId) {
  const matches=message=>message?.source?.kind==='user'&&message.source.rpcId===requestId;
  if(!Array.isArray(agent.inbox?.nextTurn)||!Array.isArray(agent.inbox?.nextStep)||typeof agent.session?.snapshotEvents!=='function')fail('HUMAN_INPUT_NATIVE_EVIDENCE_REQUIRED');
  const events=[...agent.session.snapshotEvents()],pending=[...agent.inbox.nextTurn,...agent.inbox.nextStep];
  const materialized=events.filter(event=>event.type==='user/message').map(event=>event.data);
  const inserted=events.flatMap(event=>event.type==='agent/inbox/spliced'?event.data?.inserted??[]:
    event.type==='agent/inbox/inserted'&&event.data?.message?[event.data.message]:[]);
  return {seen:[...pending,...materialized,...inserted].some(matches),
    vendorIds:new Set([...pending,...materialized].filter(matches).map(message=>message.id))};
}

// Receipts prove authenticated attempts, not native admission or central events.
// The native entrance must still receive the matching original user message.
class Receipts {
  constructor(root) {
    this.path=resolve(root,'human-input-receipts.json');this.lock=this.path+'.writer';mkdirSync(root,{recursive:true});
    const bytes=this.read();this.version=bytes===null?null:hash(bytes);this.state=bytes===null?{schema_version:1,receipts:{}}:JSON.parse(bytes);
    if(!plain(this.state)||this.state.schema_version!==1||!plain(this.state.receipts)||Object.keys(this.state).some(name=>!['schema_version','receipts'].includes(name)))fail('HUMAN_INPUT_STORE_INVALID');
    for(const [storedKey,row] of Object.entries(this.state.receipts)) {
      if(!plain(row)||Object.keys(row).length!==6||Object.keys(row).some(name=>!['session_id','request_id','session_fingerprint','body_sha256','occurred_at_utc','native_message_id'].includes(name))||
        !id(row.session_id)||!id(row.request_id)||!hex(row.session_fingerprint)||!hex(row.body_sha256)||row.native_message_id!==null&&!id(row.native_message_id)||typeof row.occurred_at_utc!=='string'||utc(row.occurred_at_utc)!==row.occurred_at_utc||key(row.session_id,row.request_id)!==storedKey)fail('HUMAN_INPUT_STORE_INVALID');
    }
  }
  read(){return existsSync(this.path)?readFileSync(this.path,'utf8'):null;}
  check(){const bytes=this.read();if((bytes===null?null:hash(bytes))!==this.version)fail('HUMAN_INPUT_STORE_STALE');}
  save(row) {
    const token=randomUUID();let lease;
    for(let attempt=0;attempt<2;attempt++) {
      try{lease=openSync(this.lock,'wx',0o600);writeFileSync(lease,JSON.stringify({pid:process.pid,token}));fsyncSync(lease);break;}
      catch(error){if(lease!==undefined){closeSync(lease);lease=undefined;throw error;}if(error.code!=='EEXIST')throw error;
        const bytes=readFileSync(this.lock,'utf8');let holder;try{holder=JSON.parse(bytes);}catch{fail('HUMAN_INPUT_STORE_BUSY');}
        if(!Number.isSafeInteger(holder.pid)||holder.pid<=0)fail('HUMAN_INPUT_STORE_BUSY');
        try{process.kill(holder.pid,0);fail('HUMAN_INPUT_STORE_BUSY');}catch(alive){if(alive.code!=='ESRCH')throw alive;}
        if(readFileSync(this.lock,'utf8')!==bytes)fail('HUMAN_INPUT_STORE_BUSY');unlinkSync(this.lock);
      }
    }
    if(lease===undefined)fail('HUMAN_INPUT_STORE_BUSY');
    const temporary=this.path+'.'+token+'.tmp';let output;
    try {
      this.check();const recordKey=key(row.session_id,row.request_id),prior=this.state.receipts[recordKey];
      if(prior){if(prior.session_fingerprint!==row.session_fingerprint)fail('HUMAN_INPUT_SESSION_CONFLICT');if(prior.body_sha256!==row.body_sha256)fail('HUMAN_INPUT_BODY_CONFLICT');
        if(row.native_message_id===null||prior.native_message_id===row.native_message_id)return prior;
        if(prior.native_message_id!==null)fail('HUMAN_INPUT_MESSAGE_CONFLICT');row={...prior,native_message_id:row.native_message_id};
      }
      const next={schema_version:1,receipts:{...this.state.receipts,[recordKey]:row}},bytes=JSON.stringify(next,null,2)+'\n';
      output=openSync(temporary,'wx',0o600);writeFileSync(output,bytes);fsyncSync(output);closeSync(output);output=undefined;
      this.check();renameSync(temporary,this.path);this.state=next;this.version=hash(bytes);return row;
    }finally {
      if(output!==undefined)closeSync(output);if(existsSync(temporary))unlinkSync(temporary);closeSync(lease);
      let holder;try{holder=JSON.parse(readFileSync(this.lock,'utf8'));}catch{}
      if(holder?.token===token)unlinkSync(this.lock);
    }
  }
}

/** Wrap only the public controller; require one authenticated physical carrier. */
export function mountHumanInput(ctx,{root,now=()=>Date.now(),targetPreset='persona'}={}) {
  if(typeof root!=='string'||!isAbsolute(root)||typeof now!=='function'||!id(targetPreset)||typeof ctx?.on!=='function'||!ctx.connection?.operator||
    typeof ctx.sessionController?.resolveAgent!=='function'||typeof ctx.agents?.get!=='function'||typeof ctx.agentPresets?.composedPreset!=='function')fail('HUMAN_INPUT_MOUNT_INVALID');
  const controller=ctx.sessionController,ownDescriptor=Object.getOwnPropertyDescriptor(controller,'prompt'),descriptor=methodDescriptor(controller,'prompt');
  if(typeof descriptor?.value!=='function')fail('HUMAN_INPUT_PROMPT_REQUIRED');
  const original=descriptor.value,storage=new AsyncLocalStorage(),receipts=new Receipts(root);let enabled=true;
  const eligible=agent=>{
    try{return enabled&&agent?.session&&ctx.agents.get(agent.session.id)===agent&&ctx.agentPresets.composedPreset(agent.ctx)===targetPreset&&fingerprint(agent)!==null;}
    catch{return false;}
  };
  const frame=(receiver,request,signal,scope)=>{
    const invocation=receiver?.ctx?.invocation;
    return invocation?.service==='sessionController'&&invocation.request?.namespace==='session'&&invocation.request.method==='prompt'&&
      invocation.peer===scope.peer&&invocation.peer===ctx.connection.operator&&invocation.signal===signal&&signal?.aborted!==true&&
      signature(request)!==null&&signature(request)===signature(invocation.request.args?.request);
  };
  async function prove(receiver,request,signal,args,scope,snapshot) {
    let agent;try{const resolved=await receiver.resolveAgent(request.sessionId);agent=resolved?.agent;}catch{}
    if(enabled&&scope.active&&frame(receiver,request,signal,scope)&&signature(request)===snapshot&&eligible(agent)) {
      // Native deduplication checks only rpcId. Never retroactively attribute an
      // older unproven native message, even when its text happens to be equal.
      const prior=receipts.state.receipts[key(agent.session.id,request.requestId)],evidence=nativeEvidence(agent,request.requestId);
      if(!prior?.native_message_id&&evidence.seen)fail('HUMAN_INPUT_NATIVE_ID_UNPROVEN');
      const row=receipts.save({session_id:agent.session.id,request_id:request.requestId,session_fingerprint:fingerprint(agent),body_sha256:hash(text(request.content)),occurred_at_utc:scope.occurredAt,native_message_id:null});
      // Native deduplication omits consumed inbox history. Do not let a repeat
      // silently mint a new native identity after the entrance rejected a step.
      if(row.native_message_id&&!evidence.vendorIds.has(row.native_message_id))fail('HUMAN_INPUT_NATIVE_REPLAY_CONFLICT');
      const admission={active:true,agent,row,error:null};scope.admission=admission;
      try{const result=await Reflect.apply(original,receiver,args);if(admission.error)throw admission.error;return result;}
      finally{admission.active=false;if(scope.admission===admission)scope.admission=null;}
    }
    return Reflect.apply(original,receiver,args);
  }
  // A normal function keeps Cordis's invocation-scoped `this`; capturing an
  // already traced bound method would silently erase the Remote provenance.
  function prompt(request,signal) {
    const scope=storage.getStore();
    if(!enabled||!scope?.active||scope.consumed)return Reflect.apply(original,this,arguments);
    scope.consumed=true; // Consume before every await, including wrong targets.
    if(!frame(this,request,signal,scope))return Reflect.apply(original,this,arguments);
    return prove(this,request,signal,[...arguments],scope,signature(request));
  }
  controller.prompt=prompt;
  const bind=(agent,message)=>{
    const scope=storage.getStore(),admission=scope?.admission;
    if(!enabled||!scope?.active||!admission?.active||agent!==admission.agent||!eligible(agent)||message?.role!=='user'||message.source?.kind!=='user'||
      message.source.rpcId!==admission.row.request_id||!id(message.id)||fingerprint(agent)!==admission.row.session_fingerprint)return;
    const body=text(message.content);if(body===null||hash(body)!==admission.row.body_sha256)return;
    // Public emit listeners isolate exceptions. Carry any failed binding back
    // to the public prompt result instead of reporting an unbound admission.
    try{receipts.save({...admission.row,native_message_id:message.id});}
    catch(error){admission.error=error.code==='HUMAN_INPUT_MESSAGE_CONFLICT'?Object.assign(new Error('HUMAN_INPUT_NATIVE_REPLAY_CONFLICT'),{code:'HUMAN_INPUT_NATIVE_REPLAY_CONFLICT'}):error;}
  };
  const removeEvent=ctx.on('session/event',(session,event)=>{
    const admission=storage.getStore()?.admission;if(!admission||session!==admission.agent.session)return;
    if(event.type==='agent/inbox/spliced')for(const message of event.data.inserted??[])bind(admission.agent,message);
    else if(event.type==='user/message')bind(admission.agent,event.data);
  },{prepend:true});
  const removeInserted=ctx.on('agent/inbox/inserted',({agent,message})=>bind(agent,message),{prepend:true});
  const remove=ctx.on('connection/request',async(request,response,next)=>{
    if(!enabled||!(request instanceof IncomingMessage)||!(response instanceof ServerResponse)||response.req!==request||request.method!=='POST'||request.url!=='/api/session/prompt')return next();
    // Connection emits this public hook only after Host/Origin and auth pass.
    // Never read or buffer the body here; Gateway supplies the validated args.
    const scope={active:true,consumed:false,peer:ctx.connection.operator,occurredAt:utc(now())};
    return storage.run(scope,async()=>{try{return await next();}finally{scope.active=false;}});
  },{prepend:true});
  return Object.freeze({
    receiptFor(agent,message) {
      if(!eligible(agent)||message?.role!=='user'||message.source?.kind!=='user'||!id(message.source.rpcId))return null;
      const body=text(message.content);if(body===null)return null;
      const row=receipts.state.receipts[key(agent.session.id,message.source.rpcId)];
      if(!row||row.native_message_id!==message.id||!id(row.native_message_id)||row.session_fingerprint!==fingerprint(agent)||row.body_sha256!==hash(body))return null;
      return Object.freeze({humanPrincipalId:'human:maintainer',occurredAt:row.occurred_at_utc});
    },
    dispose(){if(!enabled)return;enabled=false;remove?.();removeEvent?.();removeInserted?.();
      // Do not remove or overwrite a wrapper installed after this one.
      if(Object.getOwnPropertyDescriptor(controller,'prompt')?.value!==prompt)return;
      if(ownDescriptor)Object.defineProperty(controller,'prompt',ownDescriptor);else delete controller.prompt;
    },
  });
}
