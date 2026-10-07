import {mkdirSync,existsSync,readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {communicationEventId} from './social.mjs';
import {freezeMessage} from '@deepseek-ai/dsh-llm';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {canonical,copy,freeze,fail} from '../contracts.mjs';
import {nativeInboxEvidence,batchInboxSelection} from './inbox-recovery.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key));
const safeCode=error=>/^[A-Z_]{1,128}$/.test(error?.code??'')?error.code:/already has active work/.test(error?.message??'')?'LIFE_BUSY':'LEGACY_INBOX_DELIVERY_FAILED';
const revoked=code=>['INBOX_MEMBERSHIP_REVOKED','CONVERSATION_NOT_VISIBLE','CONVERSATION_MEMBERSHIP_REQUIRED','DELIVERY_SESSION_BINDING_CHANGED'].includes(code);
const senderType=item=>item.message?.sender_type??item.message?.sender?.sender_type;
const pendingMessages=agent=>[...agent.inbox.nextTurn,...agent.inbox.nextStep];
const terminalStates=new Set(['completed','failed','interrupted','cancelled','ambiguous']);
// Match the central reconciler's stored projection. This is a no-op check,
// never permission to retry an execution or reinterpret an outward effect.
export function deliveryEvidenceUnchanged(attempt,evidence) {
  const observed={...evidence};delete observed.side_effects;
  return attempt.state===observed.state&&JSON.stringify(attempt.native_evidence)===JSON.stringify(observed);
}

/** Idle admission policy only. Central input decisions and native Session
 * evidence own the durable truths; this controller has no receipt state machine. */
export async function mountLegacyRoomInbox({ctx,bridge,lifeId,authoritySessionId,root,intervalMs=1000,initialPolicy,defaultPolicy=initialPolicy??{peer_idle:true,human_idle:false,rest:false},batchLimit,maxBatchItems=batchLimit??20,debounceMs,coalesceMs=debounceMs??250}) {
  if(!/^life-[a-f0-9-]{36}$/.test(lifeId)||typeof authoritySessionId!=='string'||!authoritySessionId||typeof ctx?.agents?.get!=='function'||
    typeof ctx?.sessions?.flush!=='function'||typeof ctx?.on!=='function'||['inspect','selectBatch','authorizeBatch','acknowledgeBatch','reconcileDelivery'].some(name=>typeof bridge?.[name]!=='function'))fail('TRUSTED_LEGACY_INBOX_BRIDGE_REQUIRED');
  if(!Number.isInteger(intervalMs)||intervalMs<10||intervalMs>60000||!Number.isSafeInteger(maxBatchItems)||maxBatchItems<1||maxBatchItems>100||!Number.isSafeInteger(coalesceMs)||coalesceMs<0||coalesceMs>60000)fail('INBOX_BATCH_POLICY_INVALID');
  const directory=canonical(root),file=resolve(directory,'room-inbox-policy.json');mkdirSync(directory,{recursive:true});
  const bytes=existsSync(file)?readFileSync(file):null,old=bytes?JSON.parse(bytes.toString('utf8')):null;
  let versionHash=bytes?hash(bytes):null,state=old?{schema_version:2,life_id:old.life_id,authority_session_id:old.authority_session_id,revision:old.revision,policy:copy(old.policy)}:
    {schema_version:2,life_id:lifeId,authority_session_id:authoritySessionId,revision:1,policy:{peer_idle:true,human_idle:false,rest:false,...copy(defaultPolicy)}};
  let enabled=true,timer=null,job=null,lastError=null,lastTick=null,rows=[],batchWakes=0,modelRequests=0;
  const closedEvidence=new Map();let evidenceSession=null,eventCount=0;
  let timing=null,metrics={ticks:0,inspect_calls:0,evidence_computations:0,evidence_cache_hits:0,reconcile_calls:0,reconcile_skipped:0};
  const installs=new WeakSet(),disposers=[],lifetime=new AbortController();
  function validate(value) {
    if(!fields(value,['schema_version','life_id','authority_session_id','revision','policy'])||value.schema_version!==2||value.life_id!==lifeId||value.authority_session_id!==authoritySessionId||
      !Number.isSafeInteger(value.revision)||value.revision<1||!fields(value.policy,['peer_idle','human_idle','rest'])||Object.keys(value.policy).length!==3||Object.values(value.policy).some(v=>typeof v!=='boolean'))fail('LEGACY_INBOX_POLICY_BINDING_MISMATCH');
  }
  function save(next) {
    validate(next);if((existsSync(file)?hash(readFileSync(file)):null)!==versionHash)fail('LEGACY_INBOX_POLICY_STALE_WRITE');
    const content=JSON.stringify(next,null,2)+'\n',temporary=file+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx',0o600);
    try{writeFileSync(fd,content);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,file);versionHash=hash(content);state=next;
  }
  validate(state);
  if(old) {
    if(![1,2].includes(old.schema_version))fail('LEGACY_INBOX_POLICY_BINDING_MISMATCH');
    if(old.schema_version===1) {
      // Retire only the copied receipt projection. Exact old bytes remain an
      // audit archive; central inputs, attempts and native history are untouched.
      const archive=resolve(directory,'room-inbox-policy.schema1.'+versionHash+'.json');
      if(existsSync(archive)){if(hash(readFileSync(archive))!==versionHash)fail('LEGACY_INBOX_POLICY_ARCHIVE_CONFLICT');}
      else {const fd=openSync(archive,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
      save(state);
    }else validate(old);
  }else save(state);
  function current() {
    const agent=ctx.agents.get(authoritySessionId),status=bridge.status?.();
    if(!enabled||!agent||agent.session?.id!==authoritySessionId||agent.session.header?.id!==authoritySessionId||status?.life_id&&status.life_id!==lifeId||
      status?.registered_session_id&&status.registered_session_id!==authoritySessionId)fail('LEGACY_INBOX_AUTHORITY_REQUIRED');
    if(status&&status.ready!==true)fail('LEGACY_WORKER_NOT_READY');return agent;
  }
  function busy(agent){const tasks=ctx.personaTasks??ctx.get?.('personaTasks');return agent.status==='running'||tasks?.running?.().includes(authoritySessionId)===true;}
  function allowed(item){const type=senderType(item),explicit=item.requested===true||item.status==='requested'||
    ['prepared','pending','absent'].includes(item.attempt?.state)&&item.attempt.requested_inbox_ids?.includes(item.inbox_id);
    return !state.policy.rest&&['life','human'].includes(type)&&(explicit||(type==='life'?state.policy.peer_idle:state.policy.human_idle));}
  function policy(args,exec) {
    if(current()!==exec?.agent)fail('LEGACY_INBOX_AUTHORITY_REQUIRED');
    if(!fields(args,['peer_idle','human_idle','rest'])||Object.values(args).some(value=>typeof value!=='boolean'))fail('LEGACY_INBOX_POLICY_ARGUMENT_INVALID');
    if(Object.keys(args).length){const next=copy(state);Object.assign(next.policy,args);next.revision++;save(next);}
    return freeze({life_id:lifeId,revision:state.revision,...copy(state.policy),choices_are_optional:true,conversation_round_limit:null,
      delivery:{batch_mode:true,batch_limit:maxBatchItems,debounce_ms:coalesceMs,batch_wakes:batchWakes,model_requests:modelRequests,
        model_request_observation:'llm/stream hook entries; not provider dispatch or billing',error_code:lastError,truth:'central-input-and-native-session'}});
  }
  function install(agent) {
    if(agent!==ctx.agents.get(authoritySessionId)||agent.session?.id!==authoritySessionId||installs.has(agent))return;
    if(typeof agent.ctx?.tools?.register!=='function'||typeof agent.ctx?.systemPrompt?.section!=='function')fail('LEGACY_INBOX_SCOPED_SERVICES_REQUIRED');
    disposers.push(agent.ctx.tools.register(defineTool({name:'life_inbox_policy',description:'读取或修改你自己的空闲收件策略。peer_idle 允许自动接收主体来信，human_idle 默认关闭以避免已有原生人类入口重复。明确选择 process/continue 的来信仍可处理；rest=true 暂停全部空闲投递。任务是否还需继续由你决定，发送成功不会自动完成输入。',
      parameters:{peer_idle:{type:'boolean'},human_idle:{type:'boolean'},rest:{type:'boolean'}},isConcurrencySafe:()=>true,
      output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,exec){return policy(args,exec);}})));
    disposers.push(agent.ctx.systemPrompt.section({name:'life:legacy-inbox-policy',order:91,interpolate:false,text:()=>enabled?
      '正式 Room 来信在你空闲且收件策略允许时接入 Harness 原生持久 Inbox。life_inbox_policy 管理 peer_idle/human_idle/rest；明确 process/continue 可以请求继续处理，rest 暂停空闲投递。你决定输入是否仍需继续；现实发送结果与执行 attempt 是独立证据，执行失败不等于没有发生副作用。':''}));installs.add(agent);
  }
  async function pages() {
    const items=[];let after=0;
    for(;;){metrics.inspect_calls++;const view=await (bridge.inspectInbox??bridge.inspect).call(bridge,{after,limit:100,includeTerminal:true,includeUnsettledTerminal:true}),inbox=view?.inbox;
      if(inbox?.owner_life_id!==lifeId||!Array.isArray(inbox.items))fail('TRUSTED_SELF_INBOX_REQUIRED');items.push(...inbox.items);
      if(!inbox.hasMore)return items;if(!Number.isSafeInteger(inbox.nextAfter)||inbox.nextAfter<=after)fail('LEGACY_INBOX_PAGE_INVALID');after=inbox.nextAfter;}
  }
  async function removePending(agent,requestId) {
    await agent.runMaintenance(async()=>{for(const message of pendingMessages(agent))if(message.source?.rpcId===requestId)agent.inbox.remove(message.id);await ctx.sessions.flush(agent.session);});
  }
  async function reconcile(agent,items) {
    const events=[...agent.session.ownEvents()],pending=pendingMessages(agent),evidence=new Map();
    // Closed native turns are append-only. Cache their evidence only in this
    // process; restart/replaced/truncated Session always recomputes from journal.
    if(evidenceSession!==agent.session||events.length<eventCount)closedEvidence.clear();
    evidenceSession=agent.session;eventCount=events.length;
    const liveAttempts=new Set(items.map(row=>row.attempt?.attempt_id));
    for(const key of closedEvidence.keys())if(!liveAttempts.has(key))closedEvidence.delete(key);
    for(const row of items.filter(item=>item.attempt?.session_id===authoritySessionId)) {
      const attempt=row.attempt,key=attempt.attempt_id;
      if(!evidence.has(key)){
        const cached=closedEvidence.get(key),hasPending=pending.some(message=>message.source?.rpcId===attempt.request_id);
        if(cached?.requestId===attempt.request_id&&!hasPending){evidence.set(key,cached.evidence);metrics.evidence_cache_hits++;}
        else {
          const native=nativeInboxEvidence({events,pending,requestId:attempt.request_id,running:false,
            durableBeforeModel:attempt.model_admission_durability==='journal-flushed-before-provider'});
          metrics.evidence_computations++;evidence.set(key,native);
          if(native.turn_end_seq!=null&&terminalStates.has(native.state)&&!hasPending)closedEvidence.set(key,{requestId:attempt.request_id,evidence:native});
        }
      }
      const native=evidence.get(key);
      // Missing journal material cannot overturn an already observed terminal
      // attempt. In particular it never authorizes a new wake for old success.
      if(['completed','failed','interrupted','cancelled','ambiguous'].includes(attempt.state)&&['absent','pending'].includes(native.state)){
        if(attempt.state==='completed'&&pending.some(message=>message.source?.rpcId===attempt.request_id))await removePending(agent,attempt.request_id);
        continue;
      }
      // Consumed RPCs are never replayed from stale pending projections. Lost
      // ACK with unclaimed durable pending input is preserved for same-ID retry.
      if(native.user_message_seq!==undefined&&native.state!=='running'&&pending.some(message=>message.source?.rpcId===attempt.request_id))await removePending(agent,attempt.request_id);
      if(deliveryEvidenceUnchanged(attempt,native)){metrics.reconcile_skipped++;continue;}
      // A closed central attempt cannot be changed to another terminal state by
      // reconcileWorkerDelivery. Avoid that rejected no-op too; keep evidence.
      if(['completed','failed','cancelled','interrupted'].includes(attempt.state)&&attempt.state!==native.state){metrics.reconcile_skipped++;continue;}
      metrics.reconcile_calls++;
      await bridge.reconcileDelivery({inbox_id:row.inbox_id,attempt_id:key,evidence:native});
    }
    return evidence;
  }
  async function deliver(agent,selected) {
    const revision=state.revision;let attempt,message,queued=false;
    try{return await agent.runMaintenance(async signal=>{
      const check=()=>{signal.throwIfAborted();lifetime.signal.throwIfAborted();if(current()!==agent||busy(agent)||state.revision!==revision||selected.some(row=>!allowed(row)))fail('LIFE_BUSY');};check();
      const result=await bridge.selectBatch({items:selected.map(row=>({inbox_id:row.inbox_id,expectedRevision:row.revision}))}),ids=selected.map(row=>row.inbox_id),raw=result?.native_message;attempt=result?.attempt;
      if(attempt?.session_id!==authoritySessionId||typeof attempt.attempt_id!=='string'||raw?.source?.rpcId!==attempt.request_id||raw.source.receiverLifeId!==lifeId||raw.source.kind!=='room-inbox-batch'||
        JSON.stringify(raw.source.inboxIds)!==JSON.stringify(ids)||!Array.isArray(result.items)||result.items.length!==ids.length)fail('TRUSTED_STABLE_ROOM_ENVELOPE_REQUIRED');
      const payload=JSON.parse(raw.content?.[0]?.text??'null');
      if(!Array.isArray(payload?.items)||payload.items.length!==ids.length||payload.items.some((item,index)=>(item.event_id!==undefined?item.event_id!==communicationEventId(selected[index].room_id,selected[index].message_id):item.inbox_id!==ids[index]||item.message?.message_id!==selected[index].message_id)||item.message?.body_hash!==selected[index].message.body_hash||item.message?.sender_id!==selected[index].message.sender_id))fail('TRUSTED_STABLE_ROOM_ENVELOPE_REQUIRED');
      message=freezeMessage(copy(raw));
      const authorize=async()=>{check();const value=await bridge.authorizeBatch({inbox_ids:ids,attempt_id:attempt.attempt_id});if(value?.authorized!==true||value.attempt_id!==attempt.attempt_id)fail('DELIVERY_AUTHORIZATION_INVALID');};
      await authorize();const existing=pendingMessages(agent).filter(item=>item.source?.rpcId===attempt.request_id);
      if(existing.length>1||existing.some(item=>item.id!==message.id||hash(JSON.stringify(item))!==hash(JSON.stringify(message))))fail('NATIVE_DELIVERY_AMBIGUOUS');
      if(!existing.length)agent.send(message,'next-turn',false);queued=true;
      await ctx.sessions.flush(agent.session);await authorize();
      const receipt=await bridge.acknowledgeBatch({inbox_ids:ids,attempt_id:attempt.attempt_id});
      if(receipt?.attempt_id!==attempt.attempt_id)fail('DELIVERY_ACKNOWLEDGEMENT_INVALID');await authorize();
      // The public native wake seam is send(). Maintenance holds its wake until
      // the exact envelope has central ACK and its final journal flush.
      agent.inbox.remove(message.id);agent.send(message,'next-turn',true);await ctx.sessions.flush(agent.session);
      batchWakes++;lastError=null;return {state:'admitted',inbox_ids:ids,attempt_id:attempt.attempt_id,count:ids.length};
    });}catch(error){const code=safeCode(error);lastError=code;
      if(message&&revoked(code))await removePending(agent,attempt.request_id);
      return {state:code==='LIFE_BUSY'?'busy':queued?'pending':'failed',error_code:code,...attempt?{attempt_id:attempt.attempt_id}:{}};
    }
  }
  async function run() {
    const began=performance.now();metrics.ticks++;lastTick=new Date().toISOString();timing={started_at:lastTick,inspect_ms:0,reconcile_ms:0,delivery_ms:0,total_ms:0};
    try {
    const agent=current();install(agent);if(busy(agent))return {state:'busy'};
    let at=performance.now();rows=(await pages()).filter(row=>row.execution_session_id===authoritySessionId);timing.inspect_ms+=performance.now()-at;
    at=performance.now();const previousCalls=metrics.reconcile_calls,evidence=await reconcile(agent,rows);timing.reconcile_ms=performance.now()-at;
    // Refresh revisions only when reconciliation actually changed central data.
    if(metrics.reconcile_calls>previousCalls){at=performance.now();rows=(await pages()).filter(row=>row.execution_session_id===authoritySessionId);timing.inspect_ms+=performance.now()-at;}
    if(state.policy.rest)return {state:'rest'};
    const recovering=rows.find(row=>row.attempt?.session_id===authoritySessionId&&['prepared','pending','running','absent'].includes(row.attempt.state)&&['absent','pending'].includes(evidence.get(row.attempt.attempt_id)?.state)&&allowed(row));
    let selected;
    if(recovering){const attempt=recovering.attempt,ids=attempt.inbox_ids??[recovering.inbox_id];selected=ids.map(id=>rows.find(row=>row.inbox_id===id&&row.attempt?.attempt_id===attempt.attempt_id));
      if(selected.some(row=>!row))return {state:'pending',error_code:'DELIVERY_BATCH_SCOPE_UNAVAILABLE'};
    }else {const choice=batchInboxSelection(rows,{...state.policy,maxItems:maxBatchItems,coalesceMs});selected=choice.items;if(!selected.length){lastError=null;return {state:choice.reason};}}
    if(selected.some(row=>!allowed(row)))return {state:'idle'};at=performance.now();try{return await deliver(agent,selected);}finally{timing.delivery_ms=performance.now()-at;}
    }finally{timing.total_ms=performance.now()-began;}
  }
  function arm(){if(!enabled)return;timer=setTimeout(()=>{timer=null;facade.tick().finally(arm);},intervalMs);timer.unref();}
  function attempts(){return [...new Map(rows.filter(row=>row.attempt).map(row=>[row.attempt.attempt_id,row.attempt])).values()];}
  const facade=Object.freeze({
    tick(){if(!enabled)return Promise.resolve({state:'disposed'});if(job)return job;job=run().catch(error=>{lastError=safeCode(error);return {state:'failed',error_code:lastError};}).finally(()=>{job=null;});return job;},
    status:()=>freeze({enabled,life_id:lifeId,authority_session_id:authoritySessionId,policy:copy(state.policy),policy_revision:state.revision,active_inbox_id:null,
      batch_mode:true,batch_wakes:batchWakes,model_requests:modelRequests,modelWakes:batchWakes,batches:batchWakes,envelopes:attempts().length,batch_limit:maxBatchItems,debounce_ms:coalesceMs,
      model_request_observation:'llm/stream hook entries; not provider dispatch or billing',
      envelopes_admitted:attempts().filter(attempt=>attempt.state==='pending').length,materialized_recovered:attempts().filter(attempt=>attempt.state==='completed').length,
      needs_review:0,failed_receipts:attempts().filter(attempt=>attempt.state==='failed').length,receipt_projection_removed:true,
      execution_counts:Object.fromEntries(['prepared','pending','running','completed','failed','interrupted','ambiguous'].map(name=>[name,attempts().filter(attempt=>attempt.state===name).length])),
      execution_counts_scope:bridge.inspectInbox?'scheduler-relevant-inputs':'full-inbox',
      performance:{...metrics,last_tick:timing?{...timing}:null,closed_evidence_entries:closedEvidence.size},
      error_code:lastError,last_tick_at:lastTick,conversation_round_limit:null}),
    async drain(){if(job)await job;return facade.status();},
    dispose(){if(!enabled)return;enabled=false;lifetime.abort();if(timer)clearTimeout(timer);timer=null;for(const dispose of disposers)dispose();}
  });
  disposers.push(ctx.on('agent/created',({agent})=>{try{install(agent);}catch(error){lastError=safeCode(error);}}));
  disposers.push(ctx.on('llm/stream',async function*(options,next){if(options.sessionId===authoritySessionId)modelRequests++;yield* next();},{prepend:true}));
  if(typeof ctx.effect==='function')ctx.effect(()=>()=>facade.dispose(),'idle native Room inbox policy');
  const agent=ctx.agents.get(authoritySessionId);if(agent)install(agent);arm();return facade;
}
export const mountRoomInbox=mountLegacyRoomInbox;
