// Owner-bound candidate maintenance. Node permissions constrain candidate
// file/child-process access; they are not an OS sandbox or malicious-code cage.
// Candidate modules are NEVER imported/evaluated in the credential-bearing Host.
import {readFile,writeFile,mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';

export const recentReviewFiles=Object.freeze(['store.mjs','store.test.mjs','ledger.mjs','policy.mjs','render.mjs','render.test.mjs','social-view.mjs','action-result.mjs','action-result.test.mjs']);
export const recentReviewOperations=Object.freeze(['describe','prepare','status','test','checkpoint','seal','accept','rollback_preview','rollback_apply']);
const sourcePrefix='runtime/native_dsh/multi-life/recent-events/';
const labPrefix='development/experiments/recent-events-lab';
const childTimeoutMs=60000,outputLimit=65536,totalSourceLimit=16*1024*1024;
const basicEnv=new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','PROGRAMFILES','PROGRAMDATA']);
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const comparable=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
const inside=(root,path)=>{const rel=relative(root,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));};
export class RecentReviewError extends Error{constructor(code){super(code);this.name='RecentReviewError';this.code=code;}}
const fail=code=>{throw new RecentReviewError(code);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const fields=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key));
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
const alive=signal=>{if(signal?.aborted)fail('RECENT_REVIEW_CANCELLED');};
async function stat(path){try{return await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function realDirectory(path){
  if(typeof path!=='string'||!isAbsolute(path))fail('RECENT_REVIEW_ABSOLUTE_WORKSPACE_REQUIRED');
  const info=await stat(path);if(!info?.isDirectory()||info.isSymbolicLink()||comparable(await realpath(path))!==comparable(path))fail('RECENT_REVIEW_LINK_OR_DIRECTORY_INVALID');
}
async function safePath(root,path,{required=false,directory=false}={}){
  root=resolve(root);path=resolve(path);if(!inside(root,path))fail('RECENT_REVIEW_PATH_ESCAPE');
  await realDirectory(root);
  const rel=relative(root,path);let at=root;
  for(const part of rel.split(sep).filter(Boolean)){
    if(part==='.'||part==='..'||/[:\0]|[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))fail('RECENT_REVIEW_PATH_INVALID');
    at=join(at,part);const info=await stat(at);
    if(info&&(info.isSymbolicLink()||comparable(await realpath(at))!==comparable(at)||info.isFile()&&info.nlink>1))fail('RECENT_REVIEW_LINK_REFUSED');
    if(info&&at!==path&&!info.isDirectory())fail('RECENT_REVIEW_PATH_INVALID');
  }
  const info=await stat(path);if(required&&!info)fail('RECENT_REVIEW_PATH_MISSING');
  if(info&&(directory?!info.isDirectory():!info.isFile()))fail('RECENT_REVIEW_PATH_INVALID');
  return path;
}
async function readJson(root,path){await safePath(root,path,{required:true});try{return JSON.parse(await readFile(path,'utf8'));}catch{fail('RECENT_REVIEW_METADATA_INVALID');}}
function request(input){
  if(!fields(input,['operation','lab_id','checkpoint_id'])||!recentReviewOperations.includes(input.operation))fail('RECENT_REVIEW_ARGUMENT_INVALID');
  if(input.operation==='describe'){if(Object.hasOwn(input,'lab_id')||Object.hasOwn(input,'checkpoint_id'))fail('RECENT_REVIEW_ARGUMENT_INVALID');return input;}
  if(!id(input.lab_id))fail('RECENT_REVIEW_LAB_ID_INVALID');
  const anchored=['checkpoint','seal','accept','rollback_preview','rollback_apply'].includes(input.operation);
  if(anchored?!id(input.checkpoint_id):Object.hasOwn(input,'checkpoint_id'))fail('RECENT_REVIEW_CHECKPOINT_ID_INVALID');
  return input;
}
function environment(temp){const result=Object.fromEntries(Object.entries(process.env).filter(([key])=>basicEnv.has(key.toUpperCase())));result.PYTHONDONTWRITEBYTECODE='1';if(temp){result.TEMP=temp;result.TMP=temp;result.TMPDIR=temp;}return result;}
async function child(args,{cwd,signal,temp}={}){
  alive(signal);
  return new Promise((accept,reject)=>{
    let proc,finished=false,stopCode=null,timer;const stdout=[],stderr=[];let bytes=0;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    const stop=code=>{
      if(finished||stopCode)return;stopCode=code;
      if(process.platform==='win32'&&proc?.pid){
        execFile('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,env:environment(),timeout:5000},()=>{try{proc.kill();}catch{}});
      }else try{proc?.kill('SIGKILL');}catch{}
    };
    const abort=()=>stop('RECENT_REVIEW_CANCELLED');
    try{proc=spawn(process.execPath,args,{cwd,env:environment(temp),windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{reject(new RecentReviewError('RECENT_REVIEW_CHILD_SPAWN_FAILED'));return;}
    const collect=(chunks,data)=>{if(stopCode)return;bytes+=data.length;if(bytes>outputLimit){stop('RECENT_REVIEW_CHILD_OUTPUT_LIMIT');return;}chunks.push(data);};
    proc.stdout.on('data',data=>collect(stdout,data));proc.stderr.on('data',data=>collect(stderr,data));
    proc.once('error',()=>{if(finished)return;finished=true;cleanup();reject(new RecentReviewError('RECENT_REVIEW_CHILD_SPAWN_FAILED'));});
    proc.once('close',(code,reason)=>{if(finished)return;finished=true;cleanup();if(stopCode){reject(new RecentReviewError(stopCode));return;}accept({exit_code:code,signal:reason,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),output_truncated:false});});
    timer=setTimeout(()=>stop('RECENT_REVIEW_CHILD_TIMEOUT'),childTimeoutMs);timer.unref();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}

export function createRecentReviewRunner(options){
  if(!fields(options,['workspace','lifeId','sourceRoot','changeScript'])||typeof options.lifeId!=='string'||!options.lifeId||typeof options.workspace!=='string'||!isAbsolute(options.workspace))fail('RECENT_REVIEW_CONFIGURATION_INVALID');
  for(const key of ['sourceRoot','changeScript'])if(options[key]!==undefined&&(typeof options[key]!=='string'||!isAbsolute(options[key])))fail('RECENT_REVIEW_CONFIGURATION_INVALID');
  const workspace=resolve(options.workspace),lifeId=options.lifeId,sourceRoot=options.sourceRoot?resolve(options.sourceRoot):null;
  const changeScript=resolve(options.changeScript??join(workspace,'tools/self-maintenance/change.mjs'));
  const root=resolve(workspace,labPrefix);let busy=false,disposed=false;const shutdown=new AbortController();
  async function source(){
    const sourceDirectory=resolve(workspace,'development/runtime-source');
    const pointer=await readJson(workspace,resolve(sourceDirectory,'CURRENT.json'));
    if(!fields(pointer,['generation','root','manifest'])||!/^[a-f0-9]{64}$/.test(pointer.generation??'')||typeof pointer.root!=='string'||typeof pointer.manifest!=='string'||!isAbsolute(pointer.root)||!isAbsolute(pointer.manifest))fail('RECENT_REVIEW_SOURCE_POINTER_INVALID');
    const snapshot=resolve(sourceDirectory,pointer.generation);
    if(comparable(pointer.root)!==comparable(snapshot)||comparable(pointer.manifest)!==comparable(resolve(snapshot,'manifest.json')))fail('RECENT_REVIEW_SOURCE_POINTER_ESCAPE');
    await safePath(workspace,snapshot,{required:true,directory:true});
    const manifest=await readJson(workspace,pointer.manifest);
    if(manifest.version!==1||manifest.generation!==pointer.generation||!plain(manifest.files)||typeof manifest.sourceRoot!=='string'||!isAbsolute(manifest.sourceRoot))fail('RECENT_REVIEW_SOURCE_MANIFEST_INVALID');
    if(sourceRoot&&comparable(manifest.sourceRoot)!==comparable(sourceRoot))fail('RECENT_REVIEW_SOURCE_ORIGIN_MISMATCH');
    const sorted=Object.keys(manifest.files).sort().map(key=>JSON.stringify(key)+': '+JSON.stringify(manifest.files[key]));
    if(hash(Buffer.from('{'+sorted.join(', ')+'}'))!==pointer.generation)fail('RECENT_REVIEW_SOURCE_GENERATION_INVALID');
    const files=[];let bytes=0;
    for(const name of recentReviewFiles){
      const key=sourcePrefix+name,path=resolve(snapshot,key);await safePath(workspace,path,{required:true});
      const data=await readFile(path);bytes+=data.length;if(bytes>totalSourceLimit)fail('RECENT_REVIEW_SOURCE_TOO_LARGE');
      if(!/^[a-f0-9]{64}$/.test(manifest.files[key]??'')||hash(data)!==manifest.files[key])fail('RECENT_REVIEW_SOURCE_HASH_MISMATCH');
      if(sourceRoot){const formal=resolve(sourceRoot,key);await safePath(sourceRoot,formal,{required:true});if(hash(await readFile(formal))!==hash(data))fail('RECENT_REVIEW_TRUSTED_SOURCE_HASH_MISMATCH');}
      files.push({name,source_relative:key,sha256:hash(data),data});
    }
    return {generation:pointer.generation,manifest_path:pointer.manifest,manifest_sha256:hash(await readFile(pointer.manifest)),files,change_sha256:manifest.files['runtime/self_maintenance/change.mjs']};
  }
  async function lab(labId){
    const directory=resolve(root,labId);await safePath(workspace,directory,{required:true,directory:true});
    const metadata=await readJson(workspace,resolve(directory,'lab.json'));
    if(!plain(metadata)||metadata.schema_version!==1||metadata.life_id!==lifeId||metadata.lab_id!==labId||typeof metadata.workspace!=='string'||comparable(metadata.workspace)!==comparable(workspace)||!Array.isArray(metadata.files)||metadata.files.length!==recentReviewFiles.length)fail('RECENT_REVIEW_LAB_OWNER_MISMATCH');
    for(let index=0;index<recentReviewFiles.length;index++)if(metadata.files[index].name!==recentReviewFiles[index]||!/^[a-f0-9]{64}$/.test(metadata.files[index].sha256??''))fail('RECENT_REVIEW_LAB_METADATA_INVALID');
    const candidate=resolve(directory,'candidate');await safePath(workspace,candidate,{required:true,directory:true});
    return {directory,candidate,metadata,store:resolve(directory,'.checkpoints')};
  }
  async function hashes(candidate){const result={};for(const name of recentReviewFiles){const path=resolve(candidate,name);await safePath(workspace,path,{required:true});const info=await lstat(path);if(info.size>totalSourceLimit)fail('RECENT_REVIEW_CANDIDATE_TOO_LARGE');result[name]=hash(await readFile(path));}return result;}
  async function anchor(selected,checkpointId,{requireSeal=false}={}){
    const directory=resolve(selected.store,checkpointId);await safePath(workspace,directory,{required:true,directory:true});
    const expected=recentReviewFiles.map(name=>relative(workspace,resolve(selected.candidate,name)).replaceAll('\\','/'));
    const checkpoint=await readJson(workspace,resolve(directory,'checkpoint.json'));
    const exactFiles=value=>Array.isArray(value)&&value.length===expected.length&&value.every((entry,index)=>plain(entry)&&entry.path===expected[index]);
    if(!plain(checkpoint)||checkpoint.format!==1||checkpoint.id!==checkpointId||typeof checkpoint.workspace!=='string'||comparable(checkpoint.workspace)!==comparable(workspace)||!exactFiles(checkpoint.files))fail('RECENT_REVIEW_CHECKPOINT_SCOPE_INVALID');
    const sealPath=resolve(directory,'seal.json'),hasSeal=await stat(sealPath);
    if(requireSeal&&!hasSeal)fail('RECENT_REVIEW_SEAL_REQUIRED');
    if(hasSeal){const seal=await readJson(workspace,sealPath);if(!plain(seal)||seal.format!==1||seal.id!==checkpointId||!exactFiles(seal.files))fail('RECENT_REVIEW_CHECKPOINT_SCOPE_INVALID');}
  }
  async function recovery(input,selected,signal){
    const expected=selected.metadata.change_sha256;
    if(!/^[a-f0-9]{64}$/.test(expected??''))fail('RECENT_REVIEW_CHANGE_HASH_MISSING');
    // A reviewed Host path can be supplied by the trusted caller; the model
    // cannot choose it. Workspace default is checked for links and fixed hash.
    if(inside(workspace,changeScript))await safePath(workspace,changeScript,{required:true});
    else{const info=await lstat(changeScript);if(!info.isFile()||info.isSymbolicLink()||info.nlink>1||comparable(await realpath(changeScript))!==comparable(changeScript))fail('RECENT_REVIEW_CHANGE_SCRIPT_INVALID');}
    if(hash(await readFile(changeScript))!==expected)fail('RECENT_REVIEW_CHANGE_HASH_MISMATCH');
    await hashes(selected.candidate);await safePath(workspace,selected.store,{directory:true});
    if(input.operation!=='checkpoint')await anchor(selected,input.checkpoint_id,{requireSeal:input.operation!=='seal'});
    const operation=input.operation.startsWith('rollback_')?'rollback':input.operation;
    const args=['--preserve-symlinks-main','--preserve-symlinks',changeScript,operation,'--workspace',workspace,'--store',relative(workspace,selected.store),'--id',input.checkpoint_id];
    if(operation==='checkpoint')for(const name of recentReviewFiles)args.push('--file',relative(workspace,resolve(selected.candidate,name)));
    if(input.operation==='rollback_apply')args.push('--apply');
    const result=await child(args,{cwd:workspace,signal});let value;try{value=JSON.parse(result.stdout);}catch{fail('RECENT_REVIEW_CHANGE_OUTPUT_INVALID');}
    if(typeof value.ok!=='boolean'||result.exit_code!==(value.ok?0:1))fail('RECENT_REVIEW_CHANGE_OUTPUT_INVALID');
    if(value.ok)await anchor(selected,input.checkpoint_id,{requireSeal:input.operation!=='checkpoint'});
    return {...value,operation:input.operation,life_id:lifeId,lab_id:input.lab_id};
  }
  async function execute(input,signal){
    await realDirectory(workspace);alive(signal);
    if(input.operation==='describe')return {operation:'describe',life_id:lifeId,workspace,lab_root:root,operations:[...recentReviewOperations],fixed_files:[...recentReviewFiles],child_timeout_ms:childTimeoutMs,max_child_output_bytes:outputLimit,host_imports_candidate:false,os_sandbox:false,node_permissions_supported:Number(process.versions.node.split('.')[0])>=24,node_permissions:{candidate:'read-only',test_temp:'read-write within this lab',child_process:false,worker:false,addons:false,network:'not constrained by this Node permission model'},store_test_constraint:'Node permission model disables fsync. Only unchanged store/test hashes may be verified through the fixed trusted formal files; edited store candidates are not directly executed. Dependency imports in renderer tests remain permission-constrained.',execution_boundary:'Fixed commands/files and Node permission constraints, not OS isolation or malicious-code strong isolation. No deployment, native Host model invocation, identity or settings operation.'};
    await safePath(workspace,root,{directory:true});
    if(input.operation==='prepare'){
      const original=await source();alive(signal);
      const directory=resolve(root,input.lab_id);await safePath(workspace,directory,{directory:true});if(await stat(directory))fail('RECENT_REVIEW_LAB_ALREADY_EXISTS');
      await mkdir(root,{recursive:true});await safePath(workspace,root,{required:true,directory:true});await mkdir(directory);await safePath(workspace,directory,{required:true,directory:true});
      const candidate=resolve(directory,'candidate');await mkdir(candidate);
      // Leave interrupted labs for inspection; never overwrite/reuse them.
      for(const file of original.files){alive(signal);await writeFile(resolve(candidate,file.name),file.data,{flag:'wx'});}
      const metadata={schema_version:1,life_id:lifeId,workspace,lab_id:input.lab_id,prepared_at_utc:new Date().toISOString(),source_generation:original.generation,source_manifest_path:original.manifest_path,source_manifest_sha256:original.manifest_sha256,change_sha256:original.change_sha256,files:original.files.map(({data,...file})=>file)};
      await writeFile(resolve(directory,'lab.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
      return {operation:'prepare',life_id:lifeId,lab_id:input.lab_id,candidate_directory:candidate,lab_directory:directory,source_generation:original.generation,files:clone(metadata.files),overwrote_existing:false};
    }
    const selected=await lab(input.lab_id);
    if(input.operation==='status'){
      const entries=await stat(selected.store)?await readdir(await safePath(workspace,selected.store,{required:true,directory:true})):[];
      return {operation:'status',life_id:lifeId,lab_id:input.lab_id,candidate_directory:selected.candidate,source_generation:selected.metadata.source_generation,source_hashes:Object.fromEntries(selected.metadata.files.map(file=>[file.name,file.sha256])),current_hashes:await hashes(selected.candidate),checkpoint_ids:entries.filter(id).sort(),read_only:true};
    }
    if(input.operation==='test'){
      // Require the reviewed stable permission model. Older Nodes fail closed:
      // never fall back to raw execution of owner-editable candidates.
      if(Number(process.versions.node.split('.')[0])<24)fail('RECENT_REVIEW_NODE_PERMISSIONS_UNSUPPORTED');
      const before=await hashes(selected.candidate),results=[];
      const tempRoot=resolve(selected.directory,'test-temp');await safePath(workspace,tempRoot,{directory:true});await mkdir(tempRoot,{recursive:true});await safePath(workspace,tempRoot,{required:true,directory:true});
      // Existing store tests create their own exclusive mkdtemp directories.
      // A per-run UUID here exceeds Windows mkdtemp's path limit in the longer
      // second-Life workspace. Keep its already owner/lab-scoped temp root.
      const temp=tempRoot;
      for(const name of ['store.test.mjs','render.test.mjs','action-result.test.mjs']){
        alive(signal);await hashes(selected.candidate);
        let result,execution='candidate_node_permission',trustedFormalEquivalent=false;
        if(name==='store.test.mjs'){
          if(!sourceRoot){results.push({file:name,passed:false,not_run:true,constraint:'TRUSTED_FORMAL_STORE_SOURCE_REQUIRED',test_pass_count:0,exit_code:null,stdout:'',stderr:''});continue;}
          const formalDirectory=resolve(sourceRoot,sourcePrefix),formalHashes={};
          for(const fixed of ['store.mjs','store.test.mjs','ledger.mjs','policy.mjs']){const path=resolve(formalDirectory,fixed);await safePath(sourceRoot,path,{required:true});formalHashes[fixed]=hash(await readFile(path));}
          if(Object.keys(formalHashes).some(fixed=>formalHashes[fixed]!==before[fixed])){results.push({file:name,passed:false,not_run:true,constraint:'NODE_PERMISSION_MODEL_FSYNC_UNAVAILABLE_FOR_EDITED_STORE',test_pass_count:0,exit_code:null,stdout:'',stderr:''});continue;}
          result=await child(['--preserve-symlinks-main','--preserve-symlinks','--test-isolation=none','--test','--test-reporter=tap','store.test.mjs'],{cwd:formalDirectory,signal,temp});
          for(const fixed of Object.keys(formalHashes))if(hash(await readFile(resolve(formalDirectory,fixed)))!==formalHashes[fixed])fail('RECENT_REVIEW_TRUSTED_SOURCE_CHANGED_DURING_TEST');
          execution='trusted_formal_equivalent';trustedFormalEquivalent=true;
        }else result=await child(['--preserve-symlinks-main','--preserve-symlinks','--permission','--allow-fs-read='+selected.candidate,'--allow-fs-read='+temp,'--allow-fs-write='+temp,'--test-isolation=none','--test','--test-reporter=tap',name],{cwd:selected.candidate,signal,temp});
        results.push({file:name,...result,execution,trusted_formal_equivalent:trustedFormalEquivalent,candidate_executed:!trustedFormalEquivalent,passed:result.exit_code===0&&/# fail 0(?:\s|$)/.test(result.stdout),test_pass_count:Number(result.stdout.match(/# pass (\d+)/)?.[1]??0)});
      }
      const after=await hashes(selected.candidate);
      return {operation:'test',life_id:lifeId,lab_id:input.lab_id,passed:results.every(row=>row.passed)&&JSON.stringify(before)===JSON.stringify(after),results,candidate_hashes_before:before,candidate_hashes_after:after,candidate_unchanged:JSON.stringify(before)===JSON.stringify(after),model_requests_issued_by_runner:0,host_imports_candidate:false,os_sandbox:false,node_permission_model:true,candidate_read_only:true,test_temp_directory:temp,child_process_allowed:false,environment_variable_names:Object.keys(environment(temp)).sort()};
    }
    return recovery(input,selected,signal);
  }
  return Object.freeze({async run(input,options={}){
    input=request(input);if(!fields(options,['signal']))fail('RECENT_REVIEW_ARGUMENT_INVALID');if(disposed)fail('RECENT_REVIEW_RUNNER_DISPOSED');if(busy)fail('RECENT_REVIEW_RUNNER_BUSY');
    const signal=options.signal?AbortSignal.any([options.signal,shutdown.signal]):shutdown.signal;alive(signal);busy=true;try{return await execute(input,signal);}finally{busy=false;}
  },dispose(){if(disposed)return;disposed=true;shutdown.abort();}});
}
