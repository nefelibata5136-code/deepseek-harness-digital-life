// Transport receipts complement native tool/result events; no social memory.
// SQLite claims are durable before HTTP dispatch and shared across worker restarts.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const stable=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(stable).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
export class ActionLedger {
 constructor(stateRoot,lifeId){
  if(!/^life-[a-f0-9-]{36}$/i.test(lifeId??''))fail('MOLTBOOK_OWNER_REQUIRED');
  this.lifeId=lifeId;mkdirSync(stateRoot,{recursive:true});
  this.db=new DatabaseSync(resolve(stateRoot,'actions.sqlite'));
  this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS actions(owner TEXT,id TEXT,type TEXT,hash TEXT,outcome TEXT,prepared_at TEXT,finished_at TEXT,receipt TEXT,PRIMARY KEY(owner,id)); CREATE INDEX IF NOT EXISTS action_payload ON actions(owner,type,hash);');
 }
 read(actionId){
  if(!identifier(actionId))fail('MOLTBOOK_ACTION_ID_INVALID');
  const row=this.db.prepare('SELECT * FROM actions WHERE owner=? AND id=?').get(this.lifeId,actionId);
  if(!row)return {ok:true,found:false,life_owner:this.lifeId,action_id:actionId};
  return {ok:row.outcome==='succeeded',found:true,life_owner:this.lifeId,action_id:row.id,action_type:row.type,
   payload_hash:row.hash,outcome:row.outcome==='prepared'?'unknown':row.outcome,prepared_at:row.prepared_at,
   finished_at:row.finished_at,...row.receipt?JSON.parse(row.receipt):{},requires_reconciliation:row.outcome==='prepared'||row.outcome==='unknown'};
 }
 async run({actionId,type,payload},operation){
  if(!identifier(actionId)||!identifier(type))fail('MOLTBOOK_ACTION_ID_INVALID');
  const digest=hash(payload),now=new Date().toISOString();let prior;
  this.db.exec('BEGIN IMMEDIATE');
  try{
   prior=this.db.prepare('SELECT * FROM actions WHERE owner=? AND id=?').get(this.lifeId,actionId);
   if(prior&& (prior.hash!==digest||prior.type!==type))fail('MOLTBOOK_ACTION_ID_CONTENT_CONFLICT');
   if(!prior){
    const unsettled=this.db.prepare("SELECT id FROM actions WHERE owner=? AND type=? AND hash=? AND outcome IN ('prepared','unknown') LIMIT 1").get(this.lifeId,type,digest);
    if(unsettled)fail('MOLTBOOK_IDENTICAL_ACTION_ALREADY_RECORDED');
    const duplicate=this.db.prepare("SELECT id,rowid FROM actions WHERE owner=? AND type=? AND hash=? AND outcome='succeeded' ORDER BY rowid DESC LIMIT 1").get(this.lifeId,type,digest);
    if(duplicate){
     // A later, definitively successful inverse is a new state transition.
     // This permits follow -> unfollow -> follow and up -> down -> up, while
     // never reinterpreting an unknown write or permitting duplicate content.
     const inverseType=type==='follow'?'unfollow':type==='unfollow'?'follow':type==='vote'?'vote':null;
     const inversePayload=type==='vote'&&['up','down'].includes(payload?.direction)?{...payload,direction:payload.direction==='up'?'down':'up'}:payload;
     const reversed=inverseType&&this.db.prepare("SELECT id FROM actions WHERE owner=? AND type=? AND hash=? AND outcome='succeeded' AND rowid>? LIMIT 1").get(this.lifeId,inverseType,hash(inversePayload),duplicate.rowid);
     if(!reversed)fail('MOLTBOOK_IDENTICAL_ACTION_ALREADY_RECORDED');
    }
    this.db.prepare("INSERT INTO actions VALUES(?,?,?,?,'prepared',?,NULL,NULL)").run(this.lifeId,actionId,type,digest,now);
   }
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  if(prior)return {...this.read(actionId),duplicate_prevented:true,body_retained:false,advice:'Read remote object/conversation using its id. Unknown writes must be reconciled; changing action_id cannot resend identical content.'};
  let result;
  try{result=await operation();}catch{result={ok:false,outcome:'unknown',error_code:'MOLTBOOK_WRITE_OUTCOME_UNKNOWN'};}
  const outcome=['succeeded','failed','unknown'].includes(result?.outcome)?result.outcome:'unknown';
  // Metadata allowlist: never persist full post/comment/DM payload or response.
  const remote=result?.data,remoteId=remote?.post?.id??remote?.comment?.id??remote?.message?.id??remote?.conversation?.id??remote?.conversation_id??remote?.id;
  const safe={};
  if(identifier(remoteId))safe.remote_object_id=remoteId;
  for(const k of ['error_code','status','retry_after_seconds','visibility_confirmed','requires_verification']){
   const v=result?.[k];if(typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||k==='error_code'&&/^[A-Z0-9_:-]{1,100}$/.test(v??''))safe[k]=v;
  }
  this.db.prepare('UPDATE actions SET outcome=?,finished_at=?,receipt=? WHERE owner=? AND id=?').run(outcome,new Date().toISOString(),JSON.stringify(safe),this.lifeId,actionId);
  return {...result,outcome,ok:outcome==='succeeded'&&result?.ok===true,life_owner:this.lifeId,action_id:actionId,...safe};
 }
 close(){this.db.close();}
}
