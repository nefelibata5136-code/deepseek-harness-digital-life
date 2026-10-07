import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonical,freeze,copy,fail} from '../contracts.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const own=(value,key)=>Object.hasOwn(value,key);
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
function compact(value) {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+Array.from(value,compact).join(',')+']';
  if(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))) {
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+compact(value[key])).join(',')+'}';
  }
  fail('INVALID_TASK_JSON_VALUE');
}

// One Host owns this snapshot. Synchronous atomic rename prevents torn reads;
// the byte CAS catches stale instances. This is not a cross-process lock or an
// OS privacy sandbox. All model-facing reads are scoped to authentic contexts.
export class TaskStore {
  #state;#root;#snapshotHash;
  constructor({contexts,root,now=()=>Date.now()}) {
    if(!contexts?.require||!contexts.registry||!root)fail('TRUSTED_TASK_CONTROL_REQUIRED');
    Object.assign(this,{contexts,now});this.#root=canonical(root);mkdirSync(this.#root,{recursive:true});
    const file=resolve(this.#root,'tasks.json'),bytes=existsSync(file)?readFileSync(file):null;
    this.#state=bytes?JSON.parse(bytes.toString('utf8')):{schemaVersion:1,generation:0,tasks:{},sessions:{},inboxes:{}};
    this.#snapshotHash=bytes?hash(bytes):null;this.#validate(this.#state);
  }
  #time(){const result=new Date(this.now()).toISOString();if(!timestamp(result))fail('TASK_CLOCK_INVALID');return result;}
  #target(record) {
    const row=this.contexts.registry.assertTarget(record.owner_life_id,record.execution_session_id);
    if(row.role!==record.kind||(row.parentSessionId??null)!==record.native_parent_session_id)fail('TASK_NATIVE_LINEAGE_CHANGED');
    return row;
  }
  #validate(state) {
    if(state.schemaVersion!==1||!Number.isSafeInteger(state.generation)||state.generation<0||
      !state.tasks||!state.sessions||!state.inboxes||[state.tasks,state.sessions,state.inboxes].some(v=>typeof v!=='object'||Array.isArray(v)))fail('INVALID_TASK_STORE');
    for(const [id,row] of Object.entries(state.tasks)) {
      if(!identifier(id)||row.task_id!==id||!identifier(row.owner_life_id)||!identifier(row.execution_session_id)||!identifier(row.root_task_id)||
        !['authority','activity','delegate'].includes(row.kind)||!['active','completed'].includes(row.status)||
        !['owner','room'].includes(row.result_scope)||typeof row.shared!=='boolean'||
        row.result_scope!==(row.shared?'room':'owner')||row.shared&&!identifier(row.origin_room_id)||
        row.parent_task_id!==null&&!identifier(row.parent_task_id)||row.origin_room_id!==null&&!identifier(row.origin_room_id)||
        row.native_parent_session_id!==null&&!identifier(row.native_parent_session_id)||!timestamp(row.created_at)||
        !Number.isSafeInteger(row.revision)||row.revision<1||state.sessions[row.execution_session_id]!==id)fail('INVALID_TASK_RECORD');
      this.#target(row);
    }
    for(const [sessionId,taskId] of Object.entries(state.sessions))if(state.tasks[taskId]?.execution_session_id!==sessionId)fail('INVALID_TASK_SESSION_INDEX');
    const roots=new Map(),visiting=new Set();
    const rootOf=id=>{
      if(roots.has(id))return roots.get(id);if(visiting.has(id))fail('TASK_LINEAGE_CYCLE');
      const row=state.tasks[id];if(!row)fail('TASK_PARENT_NOT_FOUND');visiting.add(id);
      if(row.kind==='delegate'&&!row.parent_task_id)fail('DELEGATE_PARENT_TASK_REQUIRED');
      let root=id;
      if(row.parent_task_id) {
        const parent=state.tasks[row.parent_task_id];if(!parent)fail('TASK_PARENT_NOT_FOUND');
        if(parent.owner_life_id!==row.owner_life_id)fail('TASK_PARENT_OWNER_MISMATCH');
        if(parent.origin_room_id!==row.origin_room_id||parent.shared!==row.shared)fail('TASK_ORIGIN_LINEAGE_MISMATCH');
        root=rootOf(parent.task_id);
      }
      if(row.root_task_id!==root)fail('TASK_ROOT_LINEAGE_CHANGED');visiting.delete(id);roots.set(id,root);return root;
    };
    for(const id of Object.keys(state.tasks))rootOf(id);
    const completed=new Set();
    for(const [lifeId,inbox] of Object.entries(state.inboxes)) {
      this.contexts.registry.life(lifeId);if(!Array.isArray(inbox))fail('INVALID_TASK_INBOX');
      let seq=0;
      for(const entry of inbox) {
        const task=state.tasks[entry.task_id];
        if(entry.seq!==++seq||!task||task.owner_life_id!==lifeId||entry.owner_life_id!==lifeId||task.status!=='completed'||
          entry.execution_session_id!==task.execution_session_id||entry.result_hash!==hash(compact(entry.result))||
          entry.evidence_hash!==hash(compact(entry.native_evidence))||!timestamp(entry.completed_at)||
          entry.acknowledged_at!==null&&!timestamp(entry.acknowledged_at)||completed.has(entry.task_id))fail('TASK_RESULT_EVIDENCE_CHANGED');
        this.#evidence(task,entry.native_evidence);completed.add(entry.task_id);
      }
    }
    for(const task of Object.values(state.tasks))if((task.status==='completed')!==completed.has(task.task_id))fail('TASK_COMPLETION_INBOX_MISMATCH');
  }
  #commit(next) {
    this.#validate(next);
    const target=resolve(this.#root,'tasks.json'),current=existsSync(target)?hash(readFileSync(target)):null;
    if(current!==this.#snapshotHash)fail('TASK_STORE_STALE_WRITE');
    next.generation=this.#state.generation+1;
    const bytes=JSON.stringify(next,null,2)+'\n',temporary=target+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx');
    try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,target);this.#state=next;this.#snapshotHash=hash(bytes);
  }
  #task(taskId){const task=this.#state.tasks[taskId];if(!task)fail('TASK_NOT_VISIBLE');this.#target(task);return task;}
  #context(context){return this.contexts.require(context);}
  #visible(context,taskId){const c=this.#context(context),task=this.#task(taskId);if(task.owner_life_id!==c.lifeId)fail('TASK_NOT_VISIBLE');return task;}
  #result(task){return (this.#state.inboxes[task.owner_life_id]??[]).find(row=>row.task_id===task.task_id);}
  #evidence(task,evidence) {
    if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)||!Number.isSafeInteger(evidence.seq)||evidence.seq<0)fail('TASK_NATIVE_COMPLETION_EVIDENCE_REQUIRED');
    for(const key of ['sessionId','session_id','execution_session_id'])if(own(evidence,key)&&evidence[key]!==task.execution_session_id)fail('TASK_COMPLETION_SESSION_MISMATCH');
    compact(evidence);
  }
  ensureSession(args) {
    if(!args||typeof args!=='object'||!identifier(args.lifeId)||!identifier(args.sessionId)||!['authority','activity','delegate'].includes(args.role)||
      Object.keys(args).some(key=>!['lifeId','sessionId','role','parentTaskId','originRoomId','shared','taskId'].includes(key)))fail('INVALID_TASK_BINDING');
    const owner=this.contexts.registry.assertTarget(args.lifeId,args.sessionId);
    if(owner.role!==args.role)fail('TASK_ROLE_OWNER_MISMATCH');
    const existingId=this.#state.sessions[args.sessionId];
    if(existingId) {
      const old=this.#task(existingId);
      if(old.owner_life_id!==args.lifeId||old.kind!==args.role||
        own(args,'taskId')&&args.taskId!==old.task_id||own(args,'parentTaskId')&&args.parentTaskId!==old.parent_task_id||
        own(args,'originRoomId')&&args.originRoomId!==old.origin_room_id||own(args,'shared')&&args.shared!==old.shared)fail('TASK_BINDING_IMMUTABLE');
      return freeze(copy(old));
    }
    const {parentTaskId=null,originRoomId=null,shared=false,taskId=randomUUID()}=args;
    if(!identifier(taskId)||this.#state.tasks[taskId]||parentTaskId===taskId)fail('TASK_ID_CONFLICT');
    if(typeof shared!=='boolean'||originRoomId!==null&&!identifier(originRoomId)||parentTaskId!==null&&!identifier(parentTaskId)||shared&&!identifier(originRoomId))fail('INVALID_TASK_ORIGIN');
    if(args.role==='delegate'&&!parentTaskId)fail('DELEGATE_PARENT_TASK_REQUIRED');
    let rootTaskId=taskId;
    if(parentTaskId) {
      const parent=this.#task(parentTaskId);
      if(parent.owner_life_id!==args.lifeId)fail('TASK_PARENT_OWNER_MISMATCH');
      if(parent.origin_room_id!==originRoomId||parent.shared!==shared)fail('TASK_ORIGIN_LINEAGE_MISMATCH');
      if(parent.shared&&(!own(args,'shared')||!own(args,'originRoomId')))fail('TASK_SHARED_ORIGIN_MUST_BE_EXPLICIT');
      rootTaskId=parent.root_task_id;
    }
    const record={task_id:taskId,owner_life_id:args.lifeId,parent_task_id:parentTaskId,root_task_id:rootTaskId,
      origin_room_id:originRoomId,execution_session_id:args.sessionId,native_parent_session_id:owner.parentSessionId??null,
      kind:owner.role,status:'active',shared,result_scope:shared?'room':'owner',created_at:this.#time(),revision:1};
    const next=copy(this.#state);next.tasks[taskId]=record;next.sessions[args.sessionId]=taskId;next.inboxes[args.lifeId]??=[];
    this.#commit(next);return freeze(copy(record));
  }
  forSession(sessionId) {const id=this.#state.sessions[sessionId];return id?freeze(copy(this.#task(id))):null;}
  // Trusted World context view: current task lineage only, never another
  // independent activity's tasks merely because it shares the same life.
  recentForSession({lifeId,sessionId},{includeCompleted=false}={}) {
    const owner=this.contexts.registry.assertTarget(lifeId,sessionId),root=this.forSession(sessionId);
    if(!['authority','activity'].includes(owner.role)||!root||root.owner_life_id!==lifeId)fail('TASK_RECENT_OWNER_REQUIRED');
    return Object.values(this.#state.tasks).filter(task=>task.owner_life_id===lifeId&&task.root_task_id===root.root_task_id&&(includeCompleted||task.status==='active')).map(task=>freeze(copy(task)));
  }
  list(context) {const c=this.#context(context);return Object.values(this.#state.tasks).filter(row=>row.owner_life_id===c.lifeId).map(row=>{this.#target(row);return freeze(copy(row));});}
  get(context,{taskId}) {return freeze(copy(this.#visible(context,taskId)));}
  complete({taskId,result,nativeEvidence}) {
    const task=this.#task(taskId),owner=this.#target(task);if(owner.status!=='ready')fail('TASK_NATIVE_SESSION_NOT_READY');
    this.#evidence(task,nativeEvidence);
    const resultJson=compact(result),evidenceJson=compact(nativeEvidence);
    if(Buffer.byteLength(resultJson)+Buffer.byteLength(evidenceJson)>1024*1024)fail('TASK_RESULT_TOO_LARGE');
    const resultHash=hash(resultJson),evidenceHash=hash(evidenceJson),old=this.#result(task);
    if(old) {
      if(old.result_hash!==resultHash||old.evidence_hash!==evidenceHash)fail('TASK_COMPLETION_CONFLICT');
      return freeze({task:copy(task),result:copy(old),duplicate:true});
    }
    const next=copy(this.#state),inbox=next.inboxes[task.owner_life_id]??=[];
    const entry={seq:inbox.length+1,task_id:task.task_id,owner_life_id:task.owner_life_id,execution_session_id:task.execution_session_id,
      result:JSON.parse(resultJson),native_evidence:JSON.parse(evidenceJson),result_hash:resultHash,evidence_hash:evidenceHash,
      completed_at:this.#time(),acknowledged_at:null};
    inbox.push(entry);next.tasks[task.task_id].status='completed';next.tasks[task.task_id].revision++;
    this.#commit(next);return freeze({task:copy(next.tasks[task.task_id]),result:copy(entry),duplicate:false});
  }
  readResults(context,{after=0,limit=50}={}) {
    const c=this.#context(context);
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('EXPLICIT_TASK_RESULT_PAGE_REQUIRED');
    const eligible=(this.#state.inboxes[c.lifeId]??[]).filter(row=>row.seq>after),results=eligible.slice(0,limit).map(row=>freeze(copy(row)));
    return freeze({results,nextAfter:results.at(-1)?.seq??after,hasMore:eligible.length>results.length});
  }
  acknowledgeResult(context,{taskId}) {
    const task=this.#visible(context,taskId),old=this.#result(task);if(!old)fail('TASK_RESULT_NOT_FOUND');
    if(old.acknowledged_at!==null)return freeze({task_id:taskId,acknowledged_at:old.acknowledged_at,duplicate:true});
    const next=copy(this.#state),entry=next.inboxes[task.owner_life_id].find(row=>row.task_id===taskId);entry.acknowledged_at=this.#time();
    this.#commit(next);return freeze({task_id:taskId,acknowledged_at:entry.acknowledged_at,duplicate:false});
  }
}
