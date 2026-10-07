import {spawn} from 'node:child_process';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {freeze,fail,canonical,contains} from '../contracts.mjs';
import {rejectSecrets,rejectForeignRoot} from './bindings.mjs';

const bridge=fileURLToPath(new URL('./memory_bridge.py',import.meta.url));
const engineRoot=fileURLToPath(new URL('../../../long_term_memory/',import.meta.url));
const mutations=new Set(['propose','accept','annotate','link']);
const authorityOps=new Set(['accept','annotate','link']);
const allowed={
  sync:[],status:[],export:[],catalog:['offset','limit','tags','status'],pending:['offset','limit','namespace','conversation'],
  search:['query','limit','candidates','include_test','tags','speaker','from_time','to_time'],
  open:['event_id','view','memory_id','record_id','namespace','conversation','offset','limit','include_test','version','search_id'],
  propose:['event','event_id','expected_revision'],accept:['event_id','status','expected_revision'],
  annotate:['event_id','fields','expected_revision','supersedes'],link:['from_event','to_event','relation'],
};
function argumentsFor(operation,args) {
  if(!Object.hasOwn(allowed,operation))fail('MEMORY_OPERATION_NOT_AVAILABLE');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed[operation].includes(k)))fail('MEMORY_ARGUMENT_SCOPE_INVALID');
  return structuredClone(args);
}
function cleanEnv(){
  const env={PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
  for(const name of ['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'])if(process.env[name])env[name]=process.env[name];
  return env;
}
function runPython(python,request,{signal,env,timeoutMs}) {
  return new Promise(resolveResult=>{
    if(signal?.aborted)return resolveResult({ok:false,error:'MEMORY_OPERATION_CANCELLED'});
    const child=spawn(python,['-B','-X','utf8',bridge],{env,windowsHide:true,stdio:['pipe','pipe','ignore']});
    let output='',finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolveResult(value);};
    const cancel=()=>{child.kill();finish({ok:false,error:'MEMORY_OPERATION_CANCELLED; inspect status before retrying'});};
    const timer=setTimeout(()=>{child.kill();finish({ok:false,error:'MEMORY_OPERATION_TIMEOUT; inspect status before retrying'});},timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>1000000){child.kill();finish({ok:false,error:'MEMORY_OUTPUT_LIMIT; use explicit pages'});}});
    child.on('error',()=>finish({ok:false,error:'MEMORY_PROCESS_UNAVAILABLE'}));
    child.on('close',()=>{try{finish(JSON.parse(output));}catch{finish({ok:false,error:'MEMORY_RESPONSE_UNAVAILABLE; inspect status before retrying'});}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
  });
}

export function createMemoryService({contexts,bindings=new Map(),nativeSources=async()=>[],ownerBindings,
  python=process.env.PYTHON??'python',
  hostCredentialForMemory,actorPolicy,timeoutMs=26000}={}) {
  const configured=new Map([...bindings].map(([id,row])=>[id,freeze(structuredClone(row))]));
  return {async execute(context,operation,args={},options={}) {
    const c=contexts.require(context),payload=argumentsFor(operation,args),binding=configured.get(c.lifeId);
    if(!binding)fail('MEMORY_BINDING_REQUIRED');
    const self=c.role!=='delegate'&&(actorPolicy?actorPolicy(c,operation)===true:c.role==='authority');
    if(authorityOps.has(operation)&&!self)contexts.requireAuthority(c);
    const d=c.manifest.deployment,roots=[d.memory,d.workspace].map(canonical);
    const base=canonical(binding.base??d.memory),store=canonical(d.memory),exportRoot=canonical(binding.exportRoot??resolve(d.workspace,'memory/retrieval'));
    if(!roots.some(root=>contains(root,exportRoot)))fail('MEMORY_EXPORT_OUTSIDE_OWNER');
    if(!binding.config||!Array.isArray(binding.sources)||
      !['workspace_id','embedding_model','rerank_model'].every(key=>typeof binding.config[key]==='string'&&binding.config[key])||
      !Number.isSafeInteger(binding.config.dimension)||binding.config.dimension<1)fail('MEMORY_CONFIGURATION_REQUIRED');
    rejectSecrets(binding.config);
    if(binding.syntheticProvider&&c.manifest.kind!=='fixture')fail('SYNTHETIC_PROVIDER_FIXTURE_ONLY');
    const sourceRoots=c.manifest.kind==='legacy'?[...roots,...(binding.legacySourceRoots??[]).map(canonical)]:roots;
    const sources=binding.sources.map(row=>{
      const path=canonical(row.path);if(!sourceRoots.some(root=>contains(root,path)))fail('MEMORY_SOURCE_OUTSIDE_OWNER');
      rejectForeignRoot(contexts.registry,c.lifeId,path);
      if(typeof row.namespace!=='string'||!row.namespace)fail('MEMORY_SOURCE_NAMESPACE_REQUIRED');return {namespace:row.namespace,path};
    });
    const sessions=[];
    for(const item of await nativeSources(c)) {
      contexts.target(c,item.sessionId);
      const path=canonical(item.path),handle=await open(path,'r'),bytes=Buffer.alloc(65536);
      let data;try{const {bytesRead}=await handle.read(bytes,0,bytes.length,0);data=bytes.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
      const end=data.indexOf('\n');
      if(end<0)fail('MEMORY_NATIVE_HEADER_UNAVAILABLE');
      let header;try{header=JSON.parse(data.slice(0,end).replace(/^\uFEFF/,''));}catch{fail('MEMORY_NATIVE_HEADER_INVALID');}
      contexts.registry.assertNative(item.sessionId,header);
      sessions.push({sessionId:item.sessionId,path,header});
    }
    const env=cleanEnv();let credentialRef=null;
    if(operation==='search'&&!binding.syntheticProvider) {
      if(!binding.credentialLogicalRef||!hostCredentialForMemory)fail('MEMORY_CREDENTIAL_BINDING_REQUIRED');
      credentialRef=ownerBindings.credential(c,'memory',binding.credentialLogicalRef);
      let credential;try{credential=await hostCredentialForMemory(c,credentialRef);}catch{fail('MEMORY_CREDENTIAL_UNAVAILABLE');}
      if(typeof credential!=='string'||!credential)fail('MEMORY_CREDENTIAL_UNAVAILABLE');
      env.DASHSCOPE_API_KEY=credential;
    }
    contexts.require(c);
    const request={engineRoot,operation,arguments:payload,receiptArguments:options.receiptArguments??args,
      owner:{lifeId:c.lifeId,sessionId:c.sessionId,role:c.role,self,callId:c.callId,runId:c.runId,
        requestId:c.requestId,costCategory:c.costCategory,displayName:c.manifest.displayName,kind:c.manifest.kind},
      binding:{base,store,workspace:canonical(d.workspace),exportRoot,sources,config:binding.config,syntheticProvider:binding.syntheticProvider===true},
      sessions,credentialRef:credentialRef?.hostRef??null};
    if(mutations.has(operation)&&(!c.callId||!sessions.some(row=>row.sessionId===c.sessionId)))fail('MEMORY_NATIVE_RECEIPT_REQUIRED');
    return runPython(python,request,{signal:options.signal,env,timeoutMs});
  }};
}
