// Single control-plane writer. Durable reservations precede native publication.
import {mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonical,contains,privatePaths,CONTRACT_VERSION,copy,freeze,fail,validateManifest} from './contracts.mjs';

export class LifeRegistry {
  #state; #root; #lock; #closed=false; #controls=new Set();
  constructor({root,mode}) {
    if(!['fixture','production'].includes(mode))fail('EXPLICIT_REGISTRY_MODE_REQUIRED');
    Object.defineProperty(this,'mode',{value:mode,enumerable:true});this.#root=canonical(root);this.#controls.add(this.#root);mkdirSync(this.#root,{recursive:true});
    const env=resolve(this.#root,'environment.json');
    if(existsSync(env)) {if(JSON.parse(readFileSync(env,'utf8')).mode!==mode)fail('REGISTRY_ENVIRONMENT_MISMATCH');}
    else {writeFileSync(env,JSON.stringify({schemaVersion:CONTRACT_VERSION,mode}),{flag:'wx'});}
    // SQLite's OS-backed transaction lock dies with its process; no PID guessing,
    // stale lock deletion, or force takeover. Registry contents remain atomic JSON.
    try {this.#lock=new DatabaseSync(resolve(this.#root,'writer-lock.sqlite'),{open:false});this.#lock.open();this.#lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}
    catch(e){if(this.#lock?.isOpen)this.#lock.close();this.#lock=null;if(e.code==='ERR_SQLITE_ERROR'&&/locked|busy/.test(e.message))fail('REGISTRY_WRITER_ALREADY_ACTIVE');throw e;}
    try {
      const file=resolve(this.#root,'registry.json');
      this.#state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{schemaVersion:CONTRACT_VERSION,mode,generation:0,lives:{},sessions:{}};
      if(this.#state.schemaVersion!==CONTRACT_VERSION||this.#state.mode!==mode||!Number.isSafeInteger(this.#state.generation)||this.#state.generation<0||
        !this.#state.lives||typeof this.#state.lives!=='object'||Array.isArray(this.#state.lives)||!this.#state.sessions||typeof this.#state.sessions!=='object'||Array.isArray(this.#state.sessions))fail('INVALID_REGISTRY_STATE');
      const loaded=this.#state;this.#state={...loaded,lives:{},sessions:{}};
      for(const [key,m] of Object.entries(loaded.lives)){if(key!==m.lifeId)fail('INVALID_REGISTRY_MAP_KEY');this.#validateAndInsert(m);}
      for(const [key,row] of Object.entries(loaded.sessions)){if(key!==row.sessionId)fail('INVALID_REGISTRY_MAP_KEY');this.#validateOwner(row);this.#state.sessions[row.sessionId]=freeze(copy(row));}
    }catch(e){this.close();throw e;}
  }
  #assertOpen(){if(this.#closed)fail('REGISTRY_CLOSED');}
  #persist(next) {
    this.#assertOpen();next.generation=this.#state.generation+1;
    const tmp=resolve(this.#root,'registry.'+randomUUID()+'.tmp'),fd=openSync(tmp,'wx');
    try {writeFileSync(fd,JSON.stringify(next,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(tmp,resolve(this.#root,'registry.json'));this.#state=next;
  }
  #validateAndInsert(input) {
    const m=validateManifest(input,this.mode);
    for(const path of privatePaths(m))for(const control of this.#controls) {
      const privateRoot=canonical(path);
      if(contains(control,privateRoot)||contains(privateRoot,control))fail('CONTROL_ROOT_OVERLAPS_PRIVATE_STATE');
    }
    const authorityOwner=this.#state.sessions[m.authoritySessionId];
    if(authorityOwner&&(authorityOwner.lifeId!==m.lifeId||authorityOwner.role!=='authority'))fail('AUTHORITY_SESSION_ALREADY_OWNED');
    for(const other of Object.values(this.#state.lives)) {
      if(other.lifeId===m.lifeId)fail('LIFE_ALREADY_REGISTERED');
      if(other.authoritySessionId===m.authoritySessionId)fail('AUTHORITY_SESSION_ALREADY_OWNED');
      for(const a of privatePaths(m))for(const b of privatePaths(other)) {
        const x=canonical(a),y=canonical(b);
        if(contains(x,y)||contains(y,x))fail('PRIVATE_RESOURCE_OWNER_COLLISION');
      }
      if(other.deployment.presetId===m.deployment.presetId)fail('STATEFUL_PRESET_ALREADY_BOUND');
    }
    this.#state.lives[m.lifeId]=m;return m;
  }
  #validateOwner(row) {
    const m=this.life(row.lifeId);
    if(!row.sessionId||!row.reservationId||!['reserved','ready'].includes(row.status)||!['authority','activity','delegate'].includes(row.role))fail('INVALID_SESSION_OWNER');
    if(row.status==='ready'&&!/^[a-f0-9]{64}$/.test(row.nativeIdentityHash??''))fail('NATIVE_IDENTITY_FINGERPRINT_REQUIRED');
    for(const life of Object.values(this.#state.lives))if(life.lifeId!==row.lifeId&&life.authoritySessionId===row.sessionId)fail('AUTHORITY_SESSION_RESERVED_BY_OTHER_LIFE');
    if(row.presetId!==m.deployment.presetId||row.cwd!==canonical(m.deployment.workspace))fail('SESSION_DEPLOYMENT_MISMATCH');
    if(row.role==='authority'&&row.sessionId!==m.authoritySessionId||row.role!=='authority'&&row.sessionId===m.authoritySessionId)fail('AUTHORITY_BINDING_MISMATCH');
    if(row.legacyHeaderPresetAbsentVerified&&m.kind!=='legacy'&&this.mode!=='fixture')fail('UNLABELLED_PRESET_LEGACY_ONLY');
    if(row.sourceSessionId) {
      const source=this.#state.sessions[row.sourceSessionId];
      if(row.role!=='activity'||!source||source.lifeId!==row.lifeId||source.role==='delegate')fail('FORK_SOURCE_OWNER_MISMATCH');
    }
    if(row.role==='delegate') {
      const parent=this.#state.sessions[row.parentSessionId];
      if(!parent||parent.lifeId!==row.lifeId)fail('DELEGATION_OWNER_MISMATCH');
    }else if(row.parentSessionId!==null)fail('ROOT_SESSION_HAS_PARENT');
  }
  register(input) {
    this.#assertOpen();const before=this.#state;this.#state=copy(before);
    let m;try {m=this.#validateAndInsert(input);const next=this.#state;this.#state=before;this.#persist(next);return m;}
    catch(e){this.#state=before;throw e;}
  }
  life(lifeId){this.#assertOpen();const m=this.#state.lives[lifeId];if(!m)fail('UNKNOWN_LIFE');return freeze(copy(m));}
  owner(sessionId){this.#assertOpen();const row=this.#state.sessions[sessionId];if(!row)fail('UNKNOWN_SESSION_OWNER');return freeze(copy(row));}
  list(){this.#assertOpen();return Object.values(this.#state.lives).map(x=>freeze(copy(x)));}
  get controlRoot(){return this.#root;}
  get controlRoots(){this.#assertOpen();return Object.freeze([...this.#controls]);}
  addControlRoot(path) {
    this.#assertOpen();path=canonical(path);
    for(const m of this.list())for(const privatePath of privatePaths(m)) {
      const privateRoot=canonical(privatePath);
      if(contains(path,privateRoot)||contains(privateRoot,path))fail('CONTROL_ROOT_OVERLAPS_PRIVATE_STATE');
    }
    this.#controls.add(path);return path;
  }
  sessions(lifeId){this.life(lifeId);return Object.values(this.#state.sessions).filter(x=>x.lifeId===lifeId).map(x=>freeze(copy(x)));}
  reserve({lifeId,sessionId,role='activity',parentSessionId=null,sourceSessionId=null,legacyHeaderPresetAbsentVerified=false}) {
    this.#assertOpen();const m=this.life(lifeId),old=this.#state.sessions[sessionId];
    for(const life of Object.values(this.#state.lives))if(life.lifeId!==lifeId&&life.authoritySessionId===sessionId)fail('AUTHORITY_SESSION_RESERVED_BY_OTHER_LIFE');
    if(old){if(old.lifeId!==lifeId||old.role!==role||old.parentSessionId!==parentSessionId||(old.sourceSessionId??null)!==sourceSessionId||Boolean(old.legacyHeaderPresetAbsentVerified)!==legacyHeaderPresetAbsentVerified)fail('SESSION_OWNER_IMMUTABLE');return this.owner(sessionId);}
    const row={sessionId,lifeId,role,parentSessionId,...sourceSessionId?{sourceSessionId}:{},...legacyHeaderPresetAbsentVerified?{legacyHeaderPresetAbsentVerified:true}:{},status:'reserved',presetId:m.deployment.presetId,cwd:canonical(m.deployment.workspace),reservationId:randomUUID(),observedAt:new Date().toISOString()};
    this.#validateOwner(row);const next=copy(this.#state);next.sessions[sessionId]=row;this.#persist(next);return freeze(copy(row));
  }
  assertNative(sessionId,header,presetId) {
    const row=this.owner(sessionId);
    presetId??=header.agentPreset??(row.legacyHeaderPresetAbsentVerified?row.presetId:undefined);
    if(header.id!==sessionId||canonical(header.cwd)!==row.cwd||presetId!==row.presetId)fail('NATIVE_OWNER_BINDING_MISMATCH');
    if(row.role==='delegate') {if(header.parentSession!==row.parentSessionId||(header.delegationDepth??0)<1)fail('NATIVE_DELEGATION_MISMATCH');}
    else if(row.sourceSessionId) {
      if(header.parentSession!==row.sourceSessionId||header.isSeeded!==true||(header.delegationDepth??0)!==0)fail('NATIVE_FORK_LINEAGE_MISMATCH');
    }else if(header.parentSession||(header.delegationDepth??0)!==0||header.origin==='subagent'||header.isSeeded===true)fail('NATIVE_ROOT_OWNER_MISMATCH');
    if(row.nativeIdentityHash&&row.nativeIdentityHash!==this.#nativeHash(header))fail('NATIVE_SESSION_IDENTITY_CHANGED');
    return row;
  }
  complete(sessionId,header,presetId) {
    this.assertNative(sessionId,header,presetId);const row=this.owner(sessionId);
    if(row.status==='ready')return row;
    const next=copy(this.#state);next.sessions[sessionId]={...row,status:'ready',nativeIdentityHash:this.#nativeHash(header)};this.#persist(next);return this.owner(sessionId);
  }
  #nativeHash(header){return createHash('sha256').update(JSON.stringify({id:header.id,cwd:canonical(header.cwd),createdAt:header.createdAt,initialPreset:header.agentPreset??null,parentSession:header.parentSession??null,delegationDepth:header.delegationDepth??0})).digest('hex');}
  assertTarget(lifeId,sessionId){this.life(lifeId);const row=this.owner(sessionId);if(row.lifeId!==lifeId)fail('SESSION_OWNER_MISMATCH');return row;}
  close(){if(this.#closed)return;this.#closed=true;if(this.#lock){this.#lock.exec('ROLLBACK');this.#lock.close();this.#lock=null;}}
}
