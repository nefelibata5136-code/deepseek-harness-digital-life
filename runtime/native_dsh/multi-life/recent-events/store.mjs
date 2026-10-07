import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, statSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SegmentedLedger} from './ledger.mjs';

export class RecentEventError extends Error {
  constructor(code) {super(code); this.name='RecentEventError'; this.code=code;}
}
const fail=code=>{throw new RecentEventError(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const copy=value=>structuredClone(value);
export function deepFreeze(value) {
  if(value&&typeof value==='object') {for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}
  return value;
}
export function stableJson(value) {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableJson(value[key])).join(',')+'}';
}
function jsonValue(value) {
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(jsonValue);
  if(value&&Object.getPrototypeOf(value)===Object.prototype) {
    const result={};for(const [key,child]of Object.entries(value)){if(child===undefined)fail('EVENT_JSON_VALUE_REQUIRED');Object.defineProperty(result,key,{value:jsonValue(child),writable:true,enumerable:true,configurable:true});}return result;
  }
  fail('EVENT_JSON_VALUE_REQUIRED');
}
const text=(value,code)=>{if(typeof value!=='string'||!value.trim())fail(code);return value;};
export function canonicalUtc(value,{nullable=false}={}) {
  if(value===null||value===undefined) {if(nullable)return null;fail('UTC_TIME_REQUIRED');}
  if(value instanceof Date) {if(!Number.isFinite(value.valueOf()))fail('INVALID_UTC_TIME');return value.toISOString();}
  if(typeof value==='number') {if(!Number.isFinite(value)||!Number.isFinite(new Date(value).valueOf()))fail('INVALID_UTC_TIME');return new Date(value).toISOString();}
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))fail('INVALID_UTC_TIME');
  const date=new Date(value);if(!Number.isFinite(date.valueOf()))fail('INVALID_UTC_TIME');
  const [year,month,day]=value.slice(0,10).split('-').map(Number);
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())fail('INVALID_UTC_TIME');
  return date.toISOString();
}
export const isDirectType=type=>['direct','private','dm','private_chat'].includes(type);
function semantic(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))fail('EVENT_OBJECT_REQUIRED');
  const members=input.visibility?.members;
  if(!Array.isArray(members)||!members.length)fail('EVENT_VISIBILITY_MEMBERS_REQUIRED');
  const event={
    occurred_at_utc:canonicalUtc(input.occurred_at_utc,{nullable:true}),
    event_type:text(input.event_type,'EVENT_TYPE_REQUIRED'),
    from_actor_id:text(input.from_actor_id,'EVENT_FROM_REQUIRED'),
    from_display_name:input.from_display_name??input.from_actor_id,
    conversation_id:text(input.conversation_id,'EVENT_CONVERSATION_REQUIRED'),
    conversation_type:text(input.conversation_type,'EVENT_CONVERSATION_TYPE_REQUIRED'),
    conversation_display_name:input.conversation_display_name??input.conversation_id,
    visibility:{members:[...new Set(members.map(x=>text(x,'EVENT_MEMBER_ID_REQUIRED')))].sort()},
    body:input.body??null,
    payload:input.payload===undefined?null:jsonValue(input.payload),
    originSessionId:input.originSessionId??null,
    originTaskId:input.originTaskId??null,
    source_key:input.source_key??null,
  };
  text(event.from_display_name,'EVENT_FROM_DISPLAY_NAME_REQUIRED');text(event.conversation_display_name,'EVENT_CONVERSATION_DISPLAY_NAME_REQUIRED');
  if(event.body!==null&&typeof event.body!=='string')fail('EVENT_BODY_STRING_REQUIRED');
  if(event.body===null&&event.payload===null)fail('EVENT_BODY_OR_PAYLOAD_REQUIRED');
  for(const field of ['originSessionId','originTaskId','source_key'])if(event[field]!==null)text(event[field],'EVENT_OPTIONAL_ID_INVALID');
  if(isDirectType(event.conversation_type)) {
    event.to_actor_id=text(input.to_actor_id,'DIRECT_EVENT_TO_REQUIRED');
    event.to_display_name=input.to_display_name??input.to_actor_id;text(event.to_display_name,'EVENT_TO_DISPLAY_NAME_REQUIRED');
    const participants=[...new Set([event.from_actor_id,event.to_actor_id])].sort();
    if(stableJson(participants)!==stableJson(event.visibility.members))fail('DIRECT_EVENT_MEMBERS_MUST_MATCH_PARTICIPANTS');
  } else if(input.to_actor_id!==undefined&&input.to_actor_id!==null)fail('NON_DIRECT_EVENT_CANNOT_HAVE_TO');
  return event;
}
function atomicFile(path,bytes,{create=false}={}) {
  if(create&&existsSync(path))fail('IMMUTABLE_EVENT_FILE_EXISTS');
  const temp=path+'.tmp-'+randomUUID();let fd;
  try {
    fd=openSync(temp,'wx');writeFileSync(fd,bytes,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;
    if(create&&existsSync(path))fail('IMMUTABLE_EVENT_FILE_EXISTS');
    renameSync(temp,path);
  } finally {if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
function readOptional(path) {try{return readFileSync(path,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const emptyState=()=>({version:1,revision:0,lives:{}});
const fileStamp=path=>{const info=statSync(path,{bigint:true});return [info.size,info.mtimeNs,info.ctimeNs,info.ino].join(':');};

/** Append-only segments are history; SQLite indexes and control rows project it.
 * Methods are synchronous; a short internal writer lease only covers filesystem mutations.
 * A stale instance must refresh explicitly. Segment rollover preserves history.
 */
export class RecentEventStore {
  constructor({root,now=()=>new Date(),canSeeEvent=()=>true,segmentEvents,fault}={}) {
    this.root=resolve(text(root,'EVENT_STORE_ROOT_REQUIRED'));this.eventsRoot=join(this.root,'events');this.statePath=join(this.root,'delivery-state.json');this.lockPath=join(this.root,'.writer-lock');
    if(typeof now!=='function'||typeof canSeeEvent!=='function')fail('EVENT_STORE_CALLBACK_INVALID');
    this.now=now;this.canSeeEvent=canSeeEvent;this.closed=false;mkdirSync(this.eventsRoot,{recursive:true});this.#recoverAbandonedLease();
    this.ledger=new SegmentedLedger({root:this.root,segmentEvents,fault,serialize:stableJson,validate:event=>{const {record_hash,...record}=event;if(record_hash!==hash(stableJson(record)))fail('EVENT_STORE_CORRUPT_EVENT_HASH');semantic(event);return event;}});this.#openControl();this.refresh();
  }
  #assertOpen(){if(this.closed)fail('EVENT_STORE_CLOSED');}
  #recoverAbandonedLease() {
    const bytes=readOptional(this.lockPath);if(bytes===null)return;
    let lease;try{lease=JSON.parse(bytes);}catch{fail('EVENT_STORE_WRITER_LOCK_CORRUPT');}
    if(!Number.isInteger(lease.pid)||lease.pid<1)fail('EVENT_STORE_WRITER_LOCK_CORRUPT');
    try{process.kill(lease.pid,0);fail('EVENT_STORE_WRITER_ACTIVE');}
    catch(error){if(error.code!=='ESRCH')throw error;}
    // Remove only the same dead owner's lease, never a replacement writer's file.
    if(readOptional(this.lockPath)!==bytes)fail('EVENT_STORE_WRITER_ACTIVE');unlinkSync(this.lockPath);
  }
  get events(){return this.ledger.all().map(deepFreeze);} // explicit history/audit only
  get lastSequence(){return this.ledger.head.lastSequence;}
  event(id){const value=this.ledger.get(id);return value?deepFreeze(value):null;}
  source(key){const value=this.ledger.bySource(key);return value?deepFreeze(value):null;}
  recent(lifeId,{limit=150,before=Number.MAX_SAFE_INTEGER,sessionId}={}) {
    // Indexed backwards pages, stopping as soon as the requested window is full.
    const result=[];let cursor=before;
    while(result.length<limit){const page=this.ledger.page(lifeId,{before:cursor,limit:Math.max(32,limit-result.length),descending:true,sessionId});if(!page.length)break;for(const event of page)if(this.#visible(lifeId,event))result.push(event);cursor=page.at(-1).seq-1;}
    return deepFreeze(result.slice(0,limit).reverse());
  }
  #verifyEvents() {
    const current=this.ledger.db.prepare('SELECT value FROM meta WHERE key=?').get('head');
    if(current?.value!==JSON.stringify(this.ledger.head))fail('EVENT_STORE_STALE_WRITE');
    const file=this.ledger.file(this.ledger.head.segment);
    if(existsSync(file)&&statSync(file).size!==this.ledger.head.offset)fail('EVENT_STORE_STALE_WRITE');
  }
  #openControl() {
    const fresh=!existsSync(join(this.root,'control.sqlite'));
    this.control=new DatabaseSync(join(this.root,'control.sqlite'));
    this.control.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('revision','0');
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,life TEXT NOT NULL,session TEXT NOT NULL,wake TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,UNIQUE(life,wake));
      CREATE INDEX IF NOT EXISTS batches_session ON batches(life,session);
      CREATE TABLE IF NOT EXISTS marks(life TEXT NOT NULL,event TEXT NOT NULL,handled TEXT,deferred TEXT,until_utc TEXT,PRIMARY KEY(life,event));
      CREATE TABLE IF NOT EXISTS pending(life TEXT NOT NULL,event TEXT NOT NULL,seq INTEGER NOT NULL,sender TEXT NOT NULL,until_utc TEXT NOT NULL DEFAULT '',own INTEGER GENERATED ALWAYS AS (life=sender) VIRTUAL,PRIMARY KEY(life,event));
      CREATE INDEX IF NOT EXISTS pending_ready ON pending(life,until_utc,seq);
      CREATE INDEX IF NOT EXISTS pending_owner ON pending(life,own,seq);
      CREATE TABLE IF NOT EXISTS deliveries(life TEXT NOT NULL,session TEXT NOT NULL,event TEXT NOT NULL,batch TEXT NOT NULL,prepared TEXT NOT NULL,delivered TEXT NOT NULL,PRIMARY KEY(life,session,event,batch));
      CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries(life,session,event,delivered);
      CREATE TABLE IF NOT EXISTS dispatch(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));`);
    const migrationRequired=!this.control.prepare("SELECT value FROM meta WHERE key='controlMigrated'").get();
    if(migrationRequired) {
      const bytes=readOptional(this.statePath),legacy=bytes===null?emptyState():JSON.parse(bytes);
      if(legacy.version!==1||!legacy.lives)fail('EVENT_STORE_CORRUPT_STATE');
      this.control.exec('BEGIN IMMEDIATE');try {
        for(const [life,row] of Object.entries(legacy.lives))this.#saveLife(life,row);
        this.control.prepare('UPDATE meta SET value=? WHERE key=?').run(String(legacy.revision),'revision');
        for(const event of this.ledger.all())for(const life of event.visibility.members){const mark=this.mark(life,event.event_id);if(!mark.handled)this.control.prepare('INSERT OR IGNORE INTO pending VALUES(?,?,?,?,?)').run(life,event.event_id,event.seq,event.from_actor_id,mark.deferred?mark.deferred.until_utc??'~':'');}
        this.control.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('pendingCursor',String(this.lastSequence));
        this.control.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('controlMigrated','1');this.control.exec('COMMIT');
      }catch(e){this.control.exec('ROLLBACK');throw e;}
    }
    this.ledger.db.exec("ATTACH DATABASE '"+join(this.root,'control.sqlite').replaceAll("'","''")+"' AS control");
  }
  #saveLife(life,row) {
    for(const [id,batch] of Object.entries(row.batches??{})){
      this.control.prepare('INSERT OR REPLACE INTO batches VALUES(?,?,?,?,?,?)').run(id,life,batch.authority_session_id,batch.wake_id,stableJson(batch),stableJson(row.batch_status[id]));
      if(batch.delivered_at_utc!==null)for(const eventId of batch.event_ids)this.control.prepare('INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?,?,?)').run(life,batch.authority_session_id,eventId,id,batch.prepared_at_utc,batch.delivered_at_utc);
    }
    for(const id of new Set([...Object.keys(row.handled??{}),...Object.keys(row.deferred??{}),...row.touched??[]])){
      this.control.prepare('INSERT OR REPLACE INTO marks VALUES(?,?,?,?,?)').run(life,id,row.handled[id]?stableJson(row.handled[id]):null,row.deferred[id]?stableJson(row.deferred[id]):null,row.deferred[id]?.until_utc??null);
      if(row.handled[id])this.control.prepare('DELETE FROM pending WHERE life=? AND event=?').run(life,id);
      else {const event=this.event(id);if(event)this.control.prepare('INSERT OR REPLACE INTO pending VALUES(?,?,?,?,?)').run(life,id,event.seq,event.from_actor_id,row.deferred[id]?row.deferred[id].until_utc??'~':'');}
    }
  }
  #readLife(life,{batchId,wakeId,sessionId,full=false}={}) {
    const row={batches:{},batch_status:{},handled:{},deferred:{},touched:[]};
    const records=full?this.control.prepare('SELECT * FROM batches WHERE life=?'+(sessionId===undefined?'':' AND session=?')).all(...sessionId===undefined?[life]:[life,sessionId]):
      batchId?this.control.prepare('SELECT * FROM batches WHERE life=? AND id=?').all(life,batchId):wakeId?this.control.prepare('SELECT * FROM batches WHERE life=? AND wake=?').all(life,wakeId):[];
    for(const record of records){row.batches[record.id]=JSON.parse(record.data);row.batch_status[record.id]=JSON.parse(record.status);}
    const ids=new Set(records.flatMap(record=>JSON.parse(record.data).event_ids));
    const marks=full?this.control.prepare('SELECT * FROM marks WHERE life=?').all(life):[...ids].map(id=>this.control.prepare('SELECT * FROM marks WHERE life=? AND event=?').get(life,id)).filter(Boolean);
    for(const mark of marks){if(mark.handled)row.handled[mark.event]=JSON.parse(mark.handled);if(mark.deferred)row.deferred[mark.event]=JSON.parse(mark.deferred);row.touched.push(mark.event);}
    return row;
  }
  get state(){const lives={};for(const row of this.control.prepare('SELECT DISTINCT life FROM batches UNION SELECT DISTINCT life FROM marks').all())lives[row.life]=this.#readLife(row.life,{full:true});return {version:1,revision:this.revision,lives};}
  refresh() {
    this.#assertOpen();this.#recoverAbandonedLease();
    this.ledger.head=JSON.parse(this.ledger.db.prepare('SELECT value FROM meta WHERE key=?').get('head').value);this.ledger.recoverTail();
    const cursor=Number(this.control.prepare("SELECT value FROM meta WHERE key='pendingCursor'").get()?.value??0);
    const suffix=this.ledger.db.prepare('SELECT record FROM events WHERE seq>? ORDER BY seq').all(cursor);
    for(const row of suffix){const event=JSON.parse(row.record);for(const life of event.visibility.members){const mark=this.mark(life,event.event_id);if(!mark.handled)this.control.prepare('INSERT OR IGNORE INTO pending VALUES(?,?,?,?,?)').run(life,event.event_id,event.seq,event.from_actor_id,mark.deferred?mark.deferred.until_utc??'~':'');}}
    this.control.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('pendingCursor',String(this.lastSequence));
    this.revision=Number(this.control.prepare('SELECT value FROM meta WHERE key=?').get('revision').value);return this;
  }
  #mutate(operation,scope={}) {
    this.#assertOpen();let lock;this.#recoverAbandonedLease();
    try{lock=openSync(this.lockPath,'wx');writeFileSync(lock,stableJson({pid:process.pid,created_at_utc:canonicalUtc(this.now())}));fsyncSync(lock);}
    catch(error){if(lock!==undefined)closeSync(lock);if(error.code==='EEXIST')fail('EVENT_STORE_WRITER_ACTIVE');throw error;}
    try {
      this.#verifyEvents();if(Number(this.control.prepare('SELECT value FROM meta WHERE key=?').get('revision').value)!==this.revision)fail('EVENT_STORE_STALE_WRITE');
      const next={lives:{}};if(scope.lifeId)next.lives[scope.lifeId]=this.#readLife(scope.lifeId,scope);
      let stateChanged=false;const result=operation(next,()=>{stateChanged=true;});
      if(stateChanged){this.control.exec('BEGIN IMMEDIATE');try{for(const [life,row]of Object.entries(next.lives))this.#saveLife(life,row);this.control.prepare('UPDATE meta SET value=? WHERE key=?').run(String(++this.revision),'revision');this.control.exec('COMMIT');}catch(e){this.control.exec('ROLLBACK');throw e;}}
      return deepFreeze(copy(result));
    }finally{closeSync(lock);unlinkSync(this.lockPath);}
  }
  batchForWake(lifeId,wakeId){return Object.values(this.#readLife(lifeId,{wakeId}).batches)[0]??null;}
  batchStatus(lifeId,batchId){return this.#readLife(lifeId,{batchId}).batch_status[batchId]??null;}
  mark(lifeId,eventId){const row=this.control.prepare('SELECT * FROM marks WHERE life=? AND event=?').get(lifeId,eventId);return {handled:row?.handled?JSON.parse(row.handled):null,deferred:row?.deferred?JSON.parse(row.deferred):null};}
  delivered(lifeId,eventId,sessionId){return this.control.prepare('SELECT batch AS id,prepared,delivered FROM deliveries WHERE life=? AND session=? AND event=? ORDER BY delivered LIMIT 1').get(lifeId,sessionId,eventId);}
  projectInputDecision({life_id,event_id,status,inbox_id,decision_revision,decision_at=null,defer_until=null}={}) {
    if(!['pending','deferred','handled','ignored','revoked'].includes(status))fail('INPUT_DISPOSITION_INVALID');
    const event=this.event(event_id);if(!event||event.event_type!=='communication'||!this.#visible(life_id,event))fail('INPUT_EVENT_NOT_VISIBLE');
    const source={batch_id:null,source:'central-inbox',inbox_id,decision_revision,decision_at,explicit:true};
    const handled=['handled','ignored','revoked'].includes(status)?{...source,disposition:status}:null;
    const deferred=status==='deferred'?{...source,until_utc:canonicalUtc(defer_until,{nullable:true}),reason:'central-inbox'}:null;
    const old=this.mark(life_id,event_id);
    if(stableJson(old.handled)===stableJson(handled)&&stableJson(old.deferred)===stableJson(deferred))return old;
    return this.#mutate((state,changed)=>{
      const life=this.#life(state,life_id);life.touched.push(event_id);
      delete life.handled[event_id];delete life.deferred[event_id];
      if(handled)life.handled[event_id]=handled;if(deferred)life.deferred[event_id]=deferred;
      changed();return {handled,deferred};
    },{lifeId:life_id});
  }
  deliveryHistory(lifeId,sessionId,events,batch) {
    return events.flatMap(event=>this.control.prepare('SELECT event AS event_id,batch AS batch_id,delivered AS delivered_at_utc FROM deliveries WHERE life=? AND session=? AND event=? AND prepared<=? AND delivered<=? ORDER BY delivered').all(lifeId,sessionId,event.event_id,batch.prepared_at_utc,batch.delivered_at_utc??batch.prepared_at_utc).map(row=>({...row})));
  }
  #visible(lifeId,event){return event.visibility.members.includes(lifeId)&&this.canSeeEvent(lifeId,event)===true;}
  #life(state,lifeId){text(lifeId,'LIFE_ID_REQUIRED');if(!own(state.lives,lifeId))Object.defineProperty(state.lives,lifeId,{value:{batches:{},batch_status:{},handled:{},deferred:{}},enumerable:true,writable:true,configurable:true});state.lives[lifeId].deferred??={};return state.lives[lifeId];}
  #getBatch(state,lifeId,batchId){const life=state.lives[lifeId];if(!life||!own(life.batches,batchId))fail('DELIVERY_BATCH_NOT_FOUND');return {life,batch:life.batches[batchId]};}
  emit(input) {
    const fields=semantic(input),id=input.event_id===undefined?(fields.source_key===null?'event-'+randomUUID():'event-'+hash(fields.source_key)):text(input.event_id,'EVENT_ID_REQUIRED');
    return this.#mutate(()=>{
      const byId=this.event(id),bySource=fields.source_key===null?null:this.source(fields.source_key),existing=byId??bySource;
      if(existing) {
        if((input.event_id!==undefined&&existing.event_id!==id)||(byId&&bySource&&byId.event_id!==bySource.event_id)||stableJson(semantic(existing))!==stableJson(fields))fail('EVENT_IDEMPOTENCE_CONFLICT');
        return existing;
      }
      const record={event_id:id,seq:this.lastSequence+1,observed_at_utc:canonicalUtc(this.now()),...fields};
      const event=deepFreeze({...record,record_hash:hash(stableJson(record))});
      this.ledger.append(event);
      for(const life of event.visibility.members)this.control.prepare('INSERT OR IGNORE INTO pending VALUES(?,?,?,?,?)').run(life,event.event_id,event.seq,event.from_actor_id,'');this.control.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('pendingCursor',String(this.lastSequence));return event;
    });
  }
  listVisible(lifeId,{after=0,limit=100}={}) {
    this.#assertOpen();text(lifeId,'LIFE_ID_REQUIRED');if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1)fail('EVENT_PAGING_INVALID');
    const result=[];let cursor=after;
    while(result.length<limit){const page=this.ledger.page(lifeId,{after:cursor,limit:Math.min(1000,limit-result.length)});if(!page.length)break;for(const event of page)if(this.#visible(lifeId,event))result.push(event);cursor=page.at(-1).seq;}
    return deepFreeze(result);
  }
  pending(lifeId,{after=0,limit=1000,includeOwn=false,sessionId}={}) {
    if(!Number.isSafeInteger(limit)||limit<1)fail('EVENT_PAGING_INVALID');
    const now=canonicalUtc(this.now()),params=[lifeId,after,now];let condition='';
    if(sessionId!==undefined){condition+=" AND (a.scope='' OR a.scope=?)";params.push(sessionId);}
    if(!includeOwn)condition+=' AND p.own=0';
    params.push(limit);
    const rows=this.ledger.db.prepare(`SELECT e.record FROM control.pending p JOIN events e ON e.seq=p.seq JOIN audience a ON a.life=p.life AND a.seq=p.seq WHERE p.life=? AND p.seq>? AND p.until_utc<=?${condition} ORDER BY p.seq LIMIT ?`).all(...params);
    this.ledger.metrics.rows+=rows.length;return deepFreeze(rows.map(row=>JSON.parse(row.record)).filter(event=>this.#visible(lifeId,event)));
  }

  createBatch({life_id,authority_session_id,wake_id,event_ids,batch_id}={}) {
    text(life_id,'LIFE_ID_REQUIRED');text(authority_session_id,'AUTHORITY_SESSION_ID_REQUIRED');text(wake_id,'WAKE_ID_REQUIRED');
    if(!Array.isArray(event_ids)||new Set(event_ids).size!==event_ids.length)fail('DELIVERY_EVENT_IDS_INVALID');event_ids.forEach(id=>text(id,'EVENT_ID_REQUIRED'));
    if(batch_id!==undefined)text(batch_id,'BATCH_ID_REQUIRED');
    return this.#mutate((state,changed)=>{
      const life=this.#life(state,life_id),existing=Object.values(life.batches).find(batch=>batch.wake_id===wake_id||(batch_id!==undefined&&batch.batch_id===batch_id));
      if(existing) {
        if(existing.wake_id!==wake_id||existing.authority_session_id!==authority_session_id||stableJson(existing.event_ids)!==stableJson(event_ids)||(batch_id!==undefined&&existing.batch_id!==batch_id))fail('DELIVERY_BATCH_IDEMPOTENCE_CONFLICT');
        return existing;
      }
      const preparedAt=canonicalUtc(this.now());
      const events=event_ids.map(id=>{const event=this.event(id);if(!event)fail('DELIVERY_EVENT_NOT_FOUND');if(!this.#visible(life_id,event))fail('DELIVERY_EVENT_NOT_VISIBLE');const mark=this.mark(life_id,id);if(mark.handled)fail('DELIVERY_EVENT_ALREADY_HANDLED');const deferred=mark.deferred;if(deferred&&(deferred.until_utc===null||Date.parse(deferred.until_utc)>Date.parse(preparedAt)))fail('DELIVERY_EVENT_DEFERRED');return event;});
      const id=batch_id??'batch-'+randomUUID();
      const previouslyDelivered=new Set(event_ids.filter(eventId=>this.delivered(life_id,eventId,authority_session_id)));
      const batch={batch_id:id,delivery_batch_id:id,life_id,authority_session_id,wake_id,prepared_at_utc:preparedAt,delivered_at_utc:null,snapshot_cutoff_seq:this.lastSequence,event_ids:copy(event_ids),events:copy(events),first_delivery_event_ids:event_ids.filter(eventId=>!previouslyDelivered.has(eventId)),redelivery_event_ids:event_ids.filter(eventId=>previouslyDelivered.has(eventId))};
      Object.defineProperty(life.batches,batch.batch_id,{value:batch,enumerable:true,writable:true,configurable:true});Object.defineProperty(life.batch_status,batch.batch_id,{value:{turn_status:'prepared',disposition:null,result:null,finished_at_utc:null},enumerable:true,writable:true,configurable:true});changed();return batch;
    },{lifeId:life_id,wakeId:wake_id});
  }
  deliverBatch({life_id,batch_id,wake_id}={}) {
    return this.#mutate((state,changed)=>{
      const {life,batch}=this.#getBatch(state,life_id,batch_id);if(batch.wake_id!==wake_id)fail('DELIVERY_WAKE_ID_MISMATCH');
      if(batch.delivered_at_utc!==null)return batch;
      batch.delivered_at_utc=canonicalUtc(this.now());life.batch_status[batch_id].turn_status='running';changed();return batch;
    },{lifeId:life_id,batchId:batch_id});
  }
  finishBatchExecution({life_id,batch_id}={}) {
    // Host native turn/end evidence closes execution only. No Agent result is
    // invented, and input decisions/handled/deferred marks are untouched.
    return this.#mutate((state,changed)=>{
      const {life,batch}=this.#getBatch(state,life_id,batch_id),status=life.batch_status[batch_id];
      if(batch.delivered_at_utc===null)fail('DELIVERY_BATCH_NOT_DELIVERED');
      if(['failed','interrupted'].includes(status.turn_status))fail('FAILED_BATCH_REQUIRES_NEW_WAKE');
      if(status.turn_status==='ok')return status;
      life.batch_status[batch_id]={...status,turn_status:'ok',finished_at_utc:canonicalUtc(this.now())};
      changed();return life.batch_status[batch_id];
    },{lifeId:life_id,batchId:batch_id});
  }
  acknowledgeBatch({life_id,batch_id,result,deferred_events,finish=true}={}) {
    if(!result||result.status!=='ok'||!['acted','silent','deferred'].includes(result.disposition)||!Array.isArray(result.actions)||(result.disposition==='silent'&&result.actions.length!==0))fail('INVALID_AUTHORITY_ACTION_RESULT');
    const valid=jsonValue(result);
    return this.#mutate((state,changed)=>{
      const {life,batch}=this.#getBatch(state,life_id,batch_id),status=life.batch_status[batch_id];
      if(batch.delivered_at_utc===null)fail('DELIVERY_BATCH_NOT_DELIVERED');
      const completed=valid.completed_event_ids??[];
      if(!Array.isArray(completed)||new Set(completed).size!==completed.length)fail('COMPLETED_EVENT_NOT_IN_BATCH');
      for(const id of completed)if(!batch.event_ids.includes(id)) {
        const event=this.event(id),delivery=this.delivered(life_id,id,batch.authority_session_id);
        if(typeof id!=='string'||!event||event.seq>batch.snapshot_cutoff_seq||!this.#visible(life_id,event)||!delivery||delivery.delivered>batch.delivered_at_utc)fail('COMPLETED_EVENT_NOT_IN_BATCH');
        const mark=this.mark(life_id,id);if(mark.handled)life.handled[id]=mark.handled;if(mark.deferred)life.deferred[id]=mark.deferred;life.touched.push(id);
      }
      const overrides=new Map();
      if(deferred_events!==undefined) {
        if(!Array.isArray(deferred_events))fail('DEFERRED_OVERRIDE_INVALID');
        for(const override of deferred_events) {
          if(!override||typeof override!=='object'||Array.isArray(override)||Object.keys(override).some(key=>!['event_id','until'].includes(key))||!own(override,'until')||typeof override.event_id!=='string'||overrides.has(override.event_id))fail('DEFERRED_OVERRIDE_INVALID');
          if(!batch.event_ids.includes(override.event_id))fail('DEFER_EVENT_NOT_IN_BATCH');
          if(override.until!==null&&(typeof override.until!=='string'||!override.until.endsWith('Z')))fail('DEFERRED_OVERRIDE_INVALID');
          overrides.set(override.event_id,{batch_id,until_utc:canonicalUtc(override.until,{nullable:true}),reason:'life-room-decision'});
        }
      }
      if(status.result!==null&&status.result!==undefined) {
        if(stableJson(status.result)!==stableJson(valid))fail('AUTHORITY_ACK_IDEMPOTENCE_CONFLICT');
        if(!finish||['ok','failed','interrupted'].includes(status.turn_status))return status;
        life.batch_status[batch_id]={...status,turn_status:'ok',finished_at_utc:canonicalUtc(this.now())};changed();return life.batch_status[batch_id];
      }
      if(finish&&['failed','interrupted'].includes(status.turn_status))fail('FAILED_BATCH_REQUIRES_NEW_WAKE');
      life.deferred??={};const defers=new Map();
      for(const action of valid.actions.filter(value=>value?.type==='defer')){
        if(!batch.event_ids.includes(action.event_id))fail('DEFER_EVENT_NOT_IN_BATCH');
        if(defers.has(action.event_id))fail('DUPLICATE_DEFER_EVENT');
        const until=canonicalUtc(action.until_utc??action.until??null,{nullable:true});
        defers.set(action.event_id,{batch_id,until_utc:until,reason:action.reason??null});
      }
      if(valid.disposition==='deferred'&&defers.size===0)for(const id of batch.event_ids)defers.set(id,{batch_id,until_utc:null,reason:null});
      // Receiver decisions made through the existing Room tool are separate
      // evidence from the machine ACK. Commit both atomically without changing
      // that ACK's status/disposition/actions. Completed repeats cannot replay
      // stale receiver decisions over choices made after this batch.
      for(const [id,value]of overrides)defers.set(id,value);
      if(completed.some(id=>defers.has(id)))fail('COMPLETED_DEFERRED_EVENT_CONFLICT');
      for(const id of new Set([...completed,...defers.keys()])) {
        if(completed.includes(id)&&life.handled[id])continue;
        delete life.deferred[id];
        if(defers.has(id)){delete life.handled[id];Object.defineProperty(life.deferred,id,{value:defers.get(id),enumerable:true,writable:true,configurable:true});}
        else Object.defineProperty(life.handled,id,{value:{batch_id,disposition:valid.disposition,explicit:true,source:'agent-ack'},enumerable:true,writable:true,configurable:true});
      }
      life.batch_status[batch_id]={...status,turn_status:finish?'ok':status.turn_status,acknowledged:true,acknowledged_at_utc:canonicalUtc(this.now()),disposition:valid.disposition,result:valid,finished_at_utc:finish?canonicalUtc(this.now()):status.finished_at_utc,
        ...(deferred_events===undefined?{}:{deferred_events:[...defers].map(([event_id,value])=>({event_id,until:value.until_utc}))})};changed();return life.batch_status[batch_id];
    },{lifeId:life_id,batchId:batch_id});
  }
  setDeferred({life_id,event_id,until_utc=null,until,reason=null}={}) {
    const time=canonicalUtc(until??until_utc,{nullable:true});
    return this.#mutate((state,changed)=>{
      const event=this.event(event_id);if(!event||!this.#visible(life_id,event))fail('DEFER_EVENT_NOT_VISIBLE');
      const life=this.#life(state,life_id),mark=this.mark(life_id,event_id);if(mark.handled)life.handled[event_id]=mark.handled;if(mark.deferred)life.deferred[event_id]=mark.deferred;life.touched.push(event_id);const value={batch_id:life.handled[event_id]?.batch_id??life.deferred[event_id]?.batch_id??null,until_utc:time,reason:reason===null?null:String(reason)};
      if(!own(life.handled,event_id)&&stableJson(life.deferred[event_id]??null)===stableJson(value))return value;
      delete life.handled[event_id];Object.defineProperty(life.deferred,event_id,{value,enumerable:true,writable:true,configurable:true});changed();return value;
    },{lifeId:life_id});
  }
  failBatch({life_id,batch_id,status='failed',error=null}={}) {
    if(!['failed','interrupted'].includes(status))fail('BATCH_FAILURE_STATUS_INVALID');
    return this.#mutate((state,changed)=>{
      const {life}=this.#getBatch(state,life_id,batch_id),previous=life.batch_status[batch_id];if(previous.turn_status==='ok')fail('SUCCESSFUL_BATCH_CANNOT_FAIL');
      if(previous.turn_status===status&&previous.error===(error===null?null:String(error)))return previous;
      life.batch_status[batch_id]={...previous,turn_status:status,error:error===null?null:String(error),finished_at_utc:canonicalUtc(this.now())};changed();return life.batch_status[batch_id];
    },{lifeId:life_id,batchId:batch_id});
  }
  getBatch(lifeId,batchId){this.#assertOpen();return deepFreeze(copy(this.#getBatch({lives:{[lifeId]:this.#readLife(lifeId,{batchId})}},lifeId,batchId).batch));}
  inspectLife(lifeId,{sessionId}={}){this.#assertOpen();text(lifeId,'LIFE_ID_REQUIRED');const row=this.#readLife(lifeId,{full:true,sessionId});delete row.touched;return deepFreeze(row);}
  close(){if(this.closed)return;this.closed=true;this.ledger.close();this.control.close();}
}
