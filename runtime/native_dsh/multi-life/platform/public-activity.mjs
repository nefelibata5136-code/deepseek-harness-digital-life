import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonical,freeze,copy,fail} from '../contracts.mjs';
import {readBilling} from '../../../deepseek_billing/service/cache.mjs';

const phases=['idle','thinking','tool','private'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key));
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const publicTool=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(value)&&!/^private_/i.test(value);
const textValid=value=>typeof value==='string'&&[...value].length<=2000&&Buffer.byteLength(value,'utf8')<=8000;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Safe public state, not thoughts, a task transcript, or a Memory source. One
// Controller owns this snapshot; atomic rename and byte CAS reject stale writers.
// Private tool names are classified at ingress and never persisted. Known-secret
// screening of deliberately public self text belongs to the Host output guard.
export class PublicActivityStore {
  #state;#root;#snapshotHash;
  constructor({contexts,root,now=()=>Date.now()}) {
    if(typeof contexts?.require!=='function'||!contexts.registry||typeof now!=='function')fail('TRUSTED_PUBLIC_ACTIVITY_CONTROL_REQUIRED');
    Object.assign(this,{contexts,now});this.#root=canonical(root);contexts.registry.addControlRoot(this.#root);
    mkdirSync(this.#root,{recursive:true});
    const file=resolve(this.#root,'public-activity.json'),bytes=existsSync(file)?readFileSync(file):null;
    this.#state=bytes?JSON.parse(bytes.toString('utf8')):{schema_version:1,generation:0,lives:{}};
    this.#snapshotHash=bytes?hash(bytes):null;this.#validate(this.#state);
  }
  #time(){try{return new Date(this.now()).toISOString();}catch{fail('PUBLIC_ACTIVITY_CLOCK_INVALID');}}
  #validate(state) {
    if(!keys(state,['schema_version','generation','lives'])||state.schema_version!==1||!Number.isSafeInteger(state.generation)||state.generation<0||!object(state.lives))fail('INVALID_PUBLIC_ACTIVITY_STORE');
    for(const [lifeId,row] of Object.entries(state.lives)) {
      this.contexts.registry.life(lifeId);
      if(!keys(row,['life_id','updated_at','summary','sessions'])||row.life_id!==lifeId||!timestamp(row.updated_at)||!object(row.sessions))fail('INVALID_PUBLIC_ACTIVITY_OWNER');
      if(row.summary!==null) {
        const summary=row.summary;
        if(!keys(summary,['text','visibility','expires_at','updated_at'])||!['public','private'].includes(summary.visibility)||
          !timestamp(summary.updated_at)||(summary.expires_at!==null&&!timestamp(summary.expires_at))||
          (summary.visibility==='public'?!textValid(summary.text):summary.text!==null))fail('INVALID_PUBLIC_ACTIVITY_SUMMARY');
      }
      for(const [sessionId,session] of Object.entries(row.sessions)) {
        if(!keys(session,['session_id','life_id','phase','last_public_tool','tool_updated_at','updated_at'])||session.session_id!==sessionId||session.life_id!==lifeId||
          !phases.includes(session.phase)||!timestamp(session.updated_at)||
          (session.last_public_tool!==null&&!publicTool(session.last_public_tool))||session.phase==='private'&&session.last_public_tool!==null||
          session.tool_updated_at!==undefined&&(session.last_public_tool===null?session.tool_updated_at!==null:!timestamp(session.tool_updated_at)))fail('INVALID_PUBLIC_ACTIVITY_SESSION');
        this.contexts.registry.assertTarget(lifeId,sessionId);
      }
    }
  }
  #commit(next) {
    this.#validate(next);
    const file=resolve(this.#root,'public-activity.json'),current=existsSync(file)?hash(readFileSync(file)):null;
    if(current!==this.#snapshotHash)fail('PUBLIC_ACTIVITY_STORE_STALE_WRITE');
    next.generation=this.#state.generation+1;
    const bytes=JSON.stringify(next,null,2)+'\n',temporary=file+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx');
    try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,file);this.#snapshotHash=hash(bytes);this.#state=next;
  }
  #owner(next,lifeId,at) {
    next.lives[lifeId]??={life_id:lifeId,updated_at:at,summary:null,sessions:{}};
    return next.lives[lifeId];
  }
  publish(context,args) {
    const c=this.contexts.require(context);
    if(c.role==='delegate')fail('PUBLIC_ACTIVITY_DELEGATE_PUBLICATION_DENIED');
    return this.#publish(c.lifeId,args);
  }
  // Host-only, after WorkerGateway authenticates its owner-bound handle. The
  // Gateway supplies these ids; tool JSON cannot select the publishing life.
  // This checks durable ownership without fabricating an opaque execution.
  publishForLife(input) {
    if(!keys(input,['lifeId','sessionId','args']))fail('PUBLIC_ACTIVITY_HOST_METADATA_INVALID');
    const row=this.contexts.registry.assertTarget(input.lifeId,input.sessionId);
    if(row.status!=='ready')fail('PUBLIC_ACTIVITY_NATIVE_SESSION_REQUIRED');
    if(!['authority','activity'].includes(row.role))fail('PUBLIC_ACTIVITY_DELEGATE_PUBLICATION_DENIED');
    return this.#publish(row.lifeId,input.args);
  }
  #publish(lifeId,args) {
    if(!keys(args,['text','visibility','expiresAt'])||!textValid(args.text))fail('PUBLIC_ACTIVITY_ARGUMENTS_INVALID');
    const {text,visibility='public',expiresAt=null}=args,at=this.#time();
    if(!['public','private'].includes(visibility)||expiresAt!==null&&(!timestamp(expiresAt)||Date.parse(expiresAt)<=Date.parse(at)))fail('PUBLIC_ACTIVITY_ARGUMENTS_INVALID');
    const next=copy(this.#state),row=this.#owner(next,lifeId,at);
    row.summary={text:visibility==='public'?text:null,visibility,expires_at:expiresAt,updated_at:at};row.updated_at=at;
    this.#commit(next);return this.read(lifeId);
  }
  recordHost(args) {
    if(!keys(args,['lifeId','sessionId','phase','toolName'])||!phases.includes(args.phase))fail('PUBLIC_ACTIVITY_HOST_METADATA_INVALID');
    const {lifeId,sessionId,toolName}=args,owner=this.contexts.registry.assertTarget(lifeId,sessionId);
    if(owner.status!=='ready')fail('PUBLIC_ACTIVITY_NATIVE_SESSION_REQUIRED');
    if(toolName!==undefined&&(args.phase!=='tool'&&args.phase!=='private'||typeof toolName!=='string'||!/^private_/i.test(toolName)&&!publicTool(toolName)))fail('PUBLIC_ACTIVITY_HOST_METADATA_INVALID');
    const at=this.#time(),next=copy(this.#state),row=this.#owner(next,lifeId,at),previous=row.sessions[sessionId];
    let phase=args.phase;
    if(phase!=='idle'&&(previous?.phase==='private'||/^private_/i.test(toolName??'')))phase='private';
    let last_public_tool=previous?.last_public_tool??null,tool_updated_at=previous?.tool_updated_at??(last_public_tool?previous.updated_at:null);
    if(phase==='private'){last_public_tool=null;tool_updated_at=null;}
    else if(phase==='tool'&&toolName!==undefined){last_public_tool=toolName;tool_updated_at=at;}
    row.sessions[sessionId]={session_id:sessionId,life_id:lifeId,phase,last_public_tool,tool_updated_at,updated_at:at};row.updated_at=at;
    this.#commit(next);return this.read(lifeId);
  }
  // This view is intentionally public to any authenticated human/life. It omits
  // Session ids, private profile/state, filenames, arguments and message bodies.
  read(lifeId) {
    this.contexts.registry.life(lifeId);
    const row=this.#state.lives[lifeId],sessions=Object.values(row?.sessions??{}),running=sessions.filter(session=>session.phase!=='idle');
    const phase=running.some(session=>session.phase==='private')?'private':running.some(session=>session.phase==='tool')?'tool':running.length?'thinking':'idle';
    const summary=row?.summary,expired=summary?.expires_at!==null&&summary?.expires_at!==undefined&&Date.parse(summary.expires_at)<=Date.parse(this.#time());
    const visible=phase!=='private'&&!expired&&summary?.visibility==='public'&&summary.text.length>0;
    const last=sessions.filter(session=>session.last_public_tool!==null).sort((a,b)=>(b.tool_updated_at??b.updated_at).localeCompare(a.tool_updated_at??a.updated_at))[0];
    return freeze({life_id:lifeId,phase,busy:running.length>0,updated_at:row?.updated_at??null,last_public_tool:phase==='private'?null:last?.last_public_tool??null,
      activity_text:visible?summary.text:null,summary_source:visible?'self':'host',visibility:phase==='private'?'private':summary?.visibility??'public',
      ...this.contexts.registry.mode==='production'?{billing:readBilling(lifeId)}:{}});
  }
}
