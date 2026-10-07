import {readFile,mkdir,open,rename,unlink,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonical,contains,fail} from '../contracts.mjs';
import {assertOwnerPath} from './paths.mjs';

export const hashText = text => text===null ? null : createHash('sha256').update(text,'utf8').digest('hex');
const readOptional=async path=>{try{return await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}};
async function atomic(path,text) {
  await mkdir(resolve(path,'..'),{recursive:true});
  const temporary=path+'.'+randomUUID()+'.tmp';let handle;
  try {handle=await open(temporary,'wx',0o600);await handle.writeFile(text,'utf8');await handle.sync();await handle.close();handle=null;await rename(temporary,path);}
  finally {await handle?.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}

// Only these owner documents are accepted. This is not an arbitrary path API.
export class LifeDocuments {
  constructor({contexts,locks,now,requireAuthority=context=>contexts.requireAuthority(context)}) {Object.assign(this,{contexts,locks,now,requireAuthority});}
  path(context,kind) {
    const c=this.contexts.require(context),d=c.manifest.deployment;
    const path=kind==='core'?d.core:kind==='continuity'?resolve(d.workspace,'memory/continuity.md'):fail('UNKNOWN_SELF_DOCUMENT');
    if(!contains(canonical(d.workspace),canonical(path)))fail('SELF_DOCUMENT_OUTSIDE_WORKSPACE');
    assertOwnerPath(this.contexts,c,path);
    return path;
  }
  async read(context,kind) {
    const path=this.path(context,kind),text=await readOptional(path);this.contexts.require(context);
    return {lifeId:context.lifeId,kind,path,text,hash:hashText(text),exists:text!==null};
  }
  async write(context,{kind,text,expectedHash,signal=new AbortController().signal,restoreOf=null,remove=false}) {
    const c=this.requireAuthority(context,'document:'+kind),path=this.path(c,kind);
    if(remove?text!==null:typeof text!=='string'||Buffer.byteLength(text,'utf8')>(kind==='continuity'?8000:262144))fail('SELF_DOCUMENT_SIZE_OR_TYPE');
    if(expectedHash!==null&&!/^[a-f0-9]{64}$/.test(expectedHash??''))fail('EXPECTED_DOCUMENT_HASH_REQUIRED');
    if(!c.callId)fail('OWN_CALL_PROVENANCE_REQUIRED');
    const lease=await this.locks.acquire(canonical(path).replaceAll('\\','/'),c.sessionId,signal);
    try {
      signal.throwIfAborted();this.requireAuthority(c,'document:'+kind);this.path(c,kind);
      const before=await readOptional(path);
      if(hashText(before)!==expectedHash)fail('STALE_SELF_DOCUMENT');
      const versionId=randomUUID(),versionRoot=resolve(c.manifest.deployment.recovery,'self-documents');
      assertOwnerPath(this.contexts,c,versionRoot);
      const record={schemaVersion:1,versionId,lifeId:c.lifeId,kind,path,beforeHash:hashText(before),afterHash:hashText(text),beforeText:before,afterText:text,
        provenance:{sessionId:c.sessionId,callId:c.callId,runId:c.runId,at:new Date(this.now()).toISOString()},restoreOf};
      await mkdir(versionRoot,{recursive:true});
      // The immutable record lands before the target changes, including dirty bytes.
      await writeFile(resolve(versionRoot,versionId+'.json'),JSON.stringify(record)+'\n',{flag:'wx',mode:0o600});
      this.requireAuthority(c,'document:'+kind);this.path(c,kind);
      if(hashText(await readOptional(path))!==expectedHash)fail('STALE_SELF_DOCUMENT');
      if(remove)await unlink(path);else await atomic(path,text);
      await writeFile(resolve(versionRoot,versionId+'.applied.json'),JSON.stringify({versionId,afterHash:record.afterHash})+'\n',{flag:'wx',mode:0o600});
      return {lifeId:c.lifeId,kind,path,hash:record.afterHash,versionId,restoreOf,originSessionId:c.sessionId,originCallId:c.callId};
    }finally{lease.release();}
  }
  async restore(context,{versionId,expectedHash,apply=false,signal}) {
    const c=this.contexts.require(context);
    if(!/^[a-f0-9-]{36}$/.test(versionId??''))fail('INVALID_DOCUMENT_VERSION');
    assertOwnerPath(this.contexts,c,resolve(c.manifest.deployment.recovery,'self-documents'));
    const record=JSON.parse(await readFile(resolve(c.manifest.deployment.recovery,'self-documents',versionId+'.json'),'utf8'));
    this.requireAuthority(c,'document:'+record.kind);
    if(record.schemaVersion!==1||record.lifeId!==c.lifeId||record.versionId!==versionId||record.path!==this.path(c,record.kind)||
      hashText(record.beforeText)!==record.beforeHash||hashText(record.afterText)!==record.afterHash)fail('DOCUMENT_VERSION_OWNER_OR_HASH_MISMATCH');
    const current=await this.read(c,record.kind);
    const matches=current.hash===expectedHash&&current.hash===record.afterHash;
    if(!apply)return {lifeId:c.lifeId,versionId,kind:record.kind,currentHash:current.hash,restoreHash:record.beforeHash,canApply:matches,
      originalAbsent:record.beforeText===null,requiresWriterCoordination:true};
    if(!matches)fail('STALE_SELF_DOCUMENT');
    return this.write(c,{kind:record.kind,text:record.beforeText,expectedHash,signal,restoreOf:versionId,remove:record.beforeText===null});
  }
}
