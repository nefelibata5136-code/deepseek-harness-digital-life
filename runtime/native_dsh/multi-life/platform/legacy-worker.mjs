import {request} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {attachSocialCapabilities} from '../../digital-life/social-preset.mjs';
import {canonical,copy,freeze,fail} from '../contracts.mjs';
import {recentWorkerTools} from '../recent-events/worker.mjs';
import {nativeToolResultForCall} from './inbox-recovery.mjs';
import {socialView,speechParameters,speechDescription} from './social.mjs';

const loadedSources=Object.freeze(Object.fromEntries(['legacy-worker.mjs','legacy-room-inbox.mjs','inbox-recovery.mjs','social.mjs','../../digital-life/social-preset.mjs'].map(name=>
  [name,createHash('sha256').update(readFileSync(resolve(import.meta.dirname,name))).digest('hex')])));

export const legacyWorkerTools=Object.freeze(['life_contact_list','life_event_read','life_send_message','life_receive_message','life_message_decide','life_action_result','life_message_timeline','observe_life','life_activity_publish',...recentWorkerTools]);
const headerFields=['version','id','cwd','createdAt','agentPreset','parentSession','isSeeded','origin','delegationDepth'];
const routes=new Set(['registerSession','post','inbox','decide','list','read','timeline','observe','activity','activityEvent','humanMessage','selectDelivery','authorizeDelivery','acknowledgeDelivery','failDelivery','selectBatch','authorizeBatch','acknowledgeBatch','reconcileDelivery','heartbeat','resourceAcquire','resourceRelease']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function containsSecret(value,secret) {
  const remaining=[value];
  while(remaining.length) {
    const item=remaining.pop();if(typeof item==='string'&&item.includes(secret))return true;
    if(item&&typeof item==='object')for(const [key,child] of Object.entries(item)){if(key.includes(secret))return true;remaining.push(child);}
  }
  return false;
}
function fields(value,allowed) {
  if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('LEGACY_WORKER_ARGUMENT_SCOPE_INVALID');
  return copy(value);
}
const string=(required=false)=>({type:'string',...required?{required:true}:{}});
const integer=(required=false)=>({type:'integer',...required?{required:true}:{}});

// Host-only loopback control transport. The legacy budget gate freezes fetch
// and permits only paid-provider Messages; never widen or replace that gate.
// This private transport has a fixed address and fixed non-model RPC routes,
// does not follow redirects, and never returns request diagnostics or tokens.
export function createWorkerControlTransport(supervisorUrl,lifeId,token) {
  let base;try{base=new URL(supervisorUrl);}catch{fail('LOOPBACK_SUPERVISOR_REQUIRED');}
  if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.username||base.password||base.search||base.hash||base.pathname!=='/')fail('LOOPBACK_SUPERVISOR_REQUIRED');
  if(typeof token!=='string'||token.length<16||token.length>4096||/[\r\n]/.test(token))fail('LEGACY_WORKER_TOKEN_REQUIRED');
  return (operation,input={},signal)=>new Promise((accept,reject)=>{
    if(!routes.has(operation))return reject(Object.assign(new Error('UNKNOWN_WORKER_ROUTE'),{code:'UNKNOWN_WORKER_ROUTE'}));
    let payload;try{payload=JSON.stringify(input);}catch{return reject(Object.assign(new Error('LEGACY_WORKER_ARGUMENT_SCOPE_INVALID'),{code:'LEGACY_WORKER_ARGUMENT_SCOPE_INVALID'}));}
    if(Buffer.byteLength(payload)>1024*1024)return reject(Object.assign(new Error('INPUT_BODY_LIMIT'),{code:'INPUT_BODY_LIMIT'}));
    const error=code=>Object.assign(new Error(code),{code});
    if(signal?.aborted)return reject(error('LEGACY_WORKER_REQUEST_ABORTED'));
    let settled=false;
    const finish=(failure,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);failure?reject(failure):accept(value);};
    const req=request({hostname:'127.0.0.1',port:base.port,path:'/internal/worker/'+operation,method:'POST',
      headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload),'x-life-id':lifeId,authorization:'Bearer '+token}},res=>{
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024){finish(error('LEGACY_WORKER_RESPONSE_LIMIT'));res.destroy();req.destroy();}else chunks.push(chunk);});
      res.on('error',()=>finish(error('LEGACY_WORKER_TRANSPORT_FAILED')));
      res.on('end',()=>{
        if(settled)return;
        try {
          const text=Buffer.concat(chunks).toString('utf8');if(text.includes(token))return finish(error('LEGACY_WORKER_SECRET_IN_OUTPUT'));
          const result=JSON.parse(text);
          if(containsSecret(result,token))return finish(error('LEGACY_WORKER_SECRET_IN_OUTPUT'));
          if(res.statusCode!==200)return finish(error(/^[A-Z_]{1,128}$/.test(result?.error??'')?result.error:'LEGACY_WORKER_CHANNEL_FAILED'));
          if(!object(result)||!Object.hasOwn(result,'value'))return finish(error('LEGACY_WORKER_RESPONSE_INVALID'));
          finish(undefined,result.value);
        }catch{finish(error('LEGACY_WORKER_RESPONSE_INVALID'));}
      });
    });
    const abort=()=>{finish(error('LEGACY_WORKER_REQUEST_ABORTED'));req.destroy();};
    signal?.addEventListener('abort',abort,{once:true});
    req.setTimeout(15000,()=>{finish(error('LEGACY_WORKER_TRANSPORT_TIMEOUT'));req.destroy();});
    req.on('error',()=>finish(error('LEGACY_WORKER_TRANSPORT_FAILED')));req.end(payload);
  });
}

/**
 * Attach formal Room tools to one explicitly Host-bound legacy authority.
 * Resolves that existing Session through this Host's public controller only;
 * never creates an Agent, sends a prompt, wakes a turn, or edits Core/history.
 * Cold/replaced Agents must pass exact registry identity and native header
 * verification again. Secondary activities do not inherit authority tools.
 */
export async function mountLegacyWorker(ctx,{lifeId,authoritySessionId,workspace,presetId='persona',role='authority',sourceSessionId=null,supervisorUrl,token}) {
  if(!/^life-[a-f0-9-]{36}$/.test(lifeId)||typeof authoritySessionId!=='string'||!authoritySessionId||typeof presetId!=='string'||!presetId||!['authority','activity'].includes(role)||
    typeof ctx?.agents?.get!=='function'||typeof ctx?.sessionController?.resolveAgent!=='function')fail('EXPLICIT_LEGACY_WORKER_BINDING_REQUIRED');
  const workspaceKey=canonical(workspace),rpc=createWorkerControlTransport(supervisorUrl,lifeId,token);
  let enabled=true,readyAgent=null,registeredSessionId=null,lastError=null,recent=null,nativePreset=false;
  const pending=new WeakMap(),disposers=new Set();
  const ownDisposer=dispose=>{if(typeof dispose==='function')disposers.add(dispose);};
  function verify(agent) {
    const header=agent?.session?.header;
    if(!enabled||!agent||ctx.agents.get(authoritySessionId)!==agent||agent.session.id!==authoritySessionId||header?.id!==authoritySessionId)fail('LEGACY_WORKER_AUTHORITY_AGENT_REQUIRED');
    if(canonical(header.cwd)!==workspaceKey||header.agentPreset!==undefined&&header.agentPreset!==presetId||header.origin==='subagent'||(header.delegationDepth??0)!==0||!Number.isSafeInteger(header.createdAt)||header.createdAt<0||
      (sourceSessionId===null?(Boolean(header.parentSession)||header.isSeeded===true):(role!=='activity'||header.parentSession!==sourceSessionId||header.isSeeded!==true)))fail('LEGACY_WORKER_AUTHORITY_HEADER_MISMATCH');
    if(typeof agent.ctx?.tools?.register!=='function'||typeof agent.ctx?.systemPrompt?.section!=='function')fail('LEGACY_WORKER_SCOPED_SERVICES_REQUIRED');
    return header;
  }
  function requireExecution(exec) {
    const header=verify(exec?.agent);if(readyAgent!==exec.agent||registeredSessionId!==header.id)fail('LEGACY_WORKER_NOT_READY');
    if(exec.signal?.aborted)fail('LEGACY_WORKER_REQUEST_ABORTED');return exec.agent;
  }
  function ensure(agent) {
    verify(agent);if(pending.has(agent))return pending.get(agent);
    const promise=(async()=>{
      const header=verify(agent),safeHeader=Object.fromEntries(headerFields.filter(key=>header[key]!==undefined).map(key=>[key,copy(header[key])]));
      const registered=await rpc('registerSession',{header:safeHeader,presetId,role,...sourceSessionId===null?{}:{sourceSessionId},...header.agentPreset===undefined?{legacyHeaderPresetAbsentVerified:true}:{}});
      verify(agent);
      if(registered?.life_id!==lifeId||registered?.session_id!==authoritySessionId||registered?.role!==role||registered?.status!=='ready'||registered?.preset_id!==presetId)fail('LEGACY_WORKER_REGISTRATION_MISMATCH');
      const preset=ctx.agentPresets?.serviceFor(agent,'digitalLifeSocial');
      if(ctx.agentPresets&&!preset?.nativePreset)fail('DIGITAL_LIFE_SOCIAL_PRESET_REQUIRED');
      nativePreset=preset?.nativePreset===true;
      readyAgent=agent;registeredSessionId=authoritySessionId;lastError=null;
      recent?.dispose();
      const binding={lifeId,sessionId:authoritySessionId,role,rpc,verify,requireExecution,ownDisposer,enabled:()=>enabled&&readyAgent===agent};
      recent=preset?preset.attach(agent,binding):attachSocialCapabilities(agent,binding,ctx);
    })().catch(error=>{if(readyAgent===agent)readyAgent=null;lastError=/^[A-Z_]+$/.test(error.code??'')?error.code:'LEGACY_WORKER_INITIALIZATION_FAILED';throw error;});
    pending.set(agent,promise);return promise;
  }
  function dispose() {
    if(!enabled)return;enabled=false;readyAgent=null;
    for(const fn of disposers){try{fn();}catch{}}disposers.clear();
  }
  const facade=Object.freeze({
    status:()=>freeze({ready:enabled&&readyAgent!==null&&ctx.agents.get(authoritySessionId)===readyAgent,life_id:lifeId,
      input_truth_protocol:3,social_native_preset:nativePreset,loaded_sources:loadedSources,
      registered_session_id:registeredSessionId,tools:[...legacyWorkerTools],
      visible_tools:readyAgent&&typeof ctx.tools?.schemas==='function'?ctx.tools.schemas(readyAgent).map(t=>t.name).filter(name=>legacyWorkerTools.includes(name)||name==='life_inbox_policy'):null,
      automatic_wakeup:false,recent_events:recent?.status()??null,...lastError?{error_code:lastError}:{}}),
    recentStatus:()=>recent?.status()??null,
    async drainRecent(){await recent?.drain();return recent?.status()??null;},
    async inspect(args={}) {
      const input=fields(args,['after','limit','includeTerminal','includeUnsettledTerminal']),agent=ctx.agents.get(authoritySessionId);verify(agent);await ensure(agent);verify(agent);
      const [rooms,inbox]=await Promise.all([rpc('list'),rpc('inbox',input)]);verify(agent);return {status:facade.status(),rooms,inbox};
    },
    // Scheduler needs the inbox, not Room summaries or capability snapshots.
    async inspectInbox(args={}) {
      const input=fields(args,['after','limit','includeTerminal','includeUnsettledTerminal']),agent=ctx.agents.get(authoritySessionId);verify(agent);await ensure(agent);verify(agent);
      const inbox=await rpc('inbox',{...input,sessionId:authoritySessionId,executionOnly:true});verify(agent);return {inbox};
    },
    // Only the authenticated desktop Host may call this facade. Model tools
    // do not receive it or the human principal selector. The Supervisor also
    // verifies that this worker may record precisely this human's messages.
    async postHuman({args,occurredAt}) {
      if(!enabled)fail('LEGACY_WORKER_NOT_READY');
      const input=fields(args,['room_id','conversationId','body','reply_to','replyTo','message_id','messageId']);
      return rpc('humanMessage',{args:input,principalId:'human:maintainer',...occurredAt===undefined?{}:{occurredAt}});
    },
    async recordActivity(input) {
      const args=fields(input,['phase','toolName']);verify(ctx.agents.get(authoritySessionId));
      if(registeredSessionId!==authoritySessionId)fail('LEGACY_WORKER_NOT_READY');
      return rpc('activityEvent',{sessionId:authoritySessionId,...args});
    },
    async actionResult(input) {
      const agent=ctx.agents.get(authoritySessionId);requireExecution({agent});
      const args=fields(input,['room_id','message_id','reply_to','inbox_id']);
      const result=await rpc('timeline',{action_result:{sessionId:authoritySessionId,...args}});requireExecution({agent});return result;
    },
    async postOwn({args,occurredAt}) {
      const agent=ctx.agents.get(authoritySessionId);requireExecution({agent});
      const input=fields(args,['room_id','conversationId','body','reply_to','replyTo','message_id','messageId']);
      const result=await rpc('post',{sessionId:authoritySessionId,args:input,...occurredAt===undefined?{}:{occurredAt}});requireExecution({agent});return result;
    },
    async selectDelivery(input) {
      requireExecution({agent:ctx.agents.get(authoritySessionId)});
      return rpc('selectDelivery',{sessionId:authoritySessionId,...fields(input,['inbox_id','expectedRevision'])});
    },
    async authorizeDelivery(input) {
      requireExecution({agent:ctx.agents.get(authoritySessionId)});
      return rpc('authorizeDelivery',{sessionId:authoritySessionId,...fields(input,['inbox_id','attempt_id'])});
    },
    async acknowledgeDelivery(input) {
      requireExecution({agent:ctx.agents.get(authoritySessionId)});
      return rpc('acknowledgeDelivery',{sessionId:authoritySessionId,...fields(input,['inbox_id','attempt_id','native_state'])});
    },
    async failDelivery(input) {
      requireExecution({agent:ctx.agents.get(authoritySessionId)});
      return rpc('failDelivery',{sessionId:authoritySessionId,...fields(input,['inbox_id','attempt_id','error_code'])});
    },
    async selectBatch(input){requireExecution({agent:ctx.agents.get(authoritySessionId)});return rpc('selectBatch',{sessionId:authoritySessionId,...fields(input,['items'])});},
    async authorizeBatch(input){requireExecution({agent:ctx.agents.get(authoritySessionId)});return rpc('authorizeBatch',{sessionId:authoritySessionId,...fields(input,['inbox_ids','attempt_id'])});},
    async acknowledgeBatch(input){requireExecution({agent:ctx.agents.get(authoritySessionId)});return rpc('acknowledgeBatch',{sessionId:authoritySessionId,...fields(input,['inbox_ids','attempt_id'])});},
    async reconcileDelivery(input){requireExecution({agent:ctx.agents.get(authoritySessionId)});return rpc('reconcileDelivery',{sessionId:authoritySessionId,...fields(input,['inbox_id','attempt_id','evidence'])});},
    dispose
  });
  try {
    if(typeof ctx.on==='function') {
      ownDisposer(ctx.on('agent/created',({agent})=>agent?.session?.id===authoritySessionId?ensure(agent):undefined));
      ownDisposer(ctx.on('agent/disposed',({agent})=>{if(readyAgent===agent)readyAgent=null;}));
    }
    const live=ctx.agents.get(authoritySessionId),resolved=live??await ctx.sessionController.resolveAgent(authoritySessionId);
    if(resolved?.error)fail('LEGACY_WORKER_PRIMARY_RESOLUTION_FAILED');
    const primary=resolved?.agent??resolved;
    await ensure(primary);if(typeof ctx.effect==='function')ctx.effect(()=>dispose,'legacy authority formal Room worker');return facade;
  }catch(error){dispose();throw error;}
}
export const mountRoomWorker=mountLegacyWorker;
