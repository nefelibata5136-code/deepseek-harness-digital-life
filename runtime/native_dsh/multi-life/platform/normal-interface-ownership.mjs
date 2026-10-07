import {AsyncLocalStorage} from 'node:async_hooks';
import {isAbsolute,resolve} from 'node:path';
import {canonical,contains,privatePaths,fail} from '../contracts.mjs';

// This is a logical Host policy, not a Windows user/Terminal sandbox. The Host
// supplies manifests and owner bindings; model arguments are never principals.
export function assertOwnershipPath({lifeId,manifests,controlRoots=[],protectedWriteRoots=[]},path,{write=false}={}) {
  const rows=typeof manifests==='function'?manifests():manifests;
  if(!Array.isArray(rows)||!rows.some(m=>m.lifeId===lifeId))fail('TRUSTED_OWNER_MANIFEST_REQUIRED');
  const target=canonical(path);
  for(const root of controlRoots)if(contains(canonical(root),target))fail('TRUSTED_CONTROL_RESOURCE');
  for(const other of rows)if(other.lifeId!==lifeId)
    for(const root of privatePaths(other))if(contains(canonical(root),target))fail('OTHER_LIFE_PRIVATE_RESOURCE');
  if(write)for(const root of protectedWriteRoots)if(contains(canonical(root),target))fail('SHARED_CONTROL_WRITE_REQUIRES_HOST');
  return target;
}

const fileTools=new Set(['read','read_source','write','edit','list_files']);
const writingTools=new Set(['write','edit']);
const sessionTools=new Set(['session_search','session_event_search','session_trace','session_event_trace','session_event_read']);
const normalized=value=>String(value).replace(/[\\/]+/g,'/').toLowerCase();
const safeError=error=>/^[A-Z_]+$/.test(error?.code??'')?error.code:'NORMAL_INTERFACE_OWNERSHIP_FAILED';

export function createNormalInterfaceOwnership({registry,contexts,ownerLifeId,manifests=()=>registry.list(),controlRoots=[],protectedWriteRoots=[],resolveOwner,sessionOwner,acquireResource}) {
  const current=new AsyncLocalStorage();
  const rows=()=>typeof manifests==='function'?manifests():manifests;
  function forAgent(agent) {
    if(!agent?.session)fail('TRUSTED_AGENT_CONTEXT_REQUIRED');
    const c=resolveOwner?resolveOwner(agent):contexts?contexts.forAgent(agent):registry.assertNative(agent.session.id,agent.session.header);
    const lifeId=c.lifeId??c.owner_life_id,sessionId=c.sessionId??c.session_id;
    if(!lifeId||sessionId!==String(agent.session.id)||ownerLifeId&&lifeId!==ownerLifeId)fail('NORMAL_INTERFACE_OWNER_MISMATCH');
    const manifest=rows().find(m=>m.lifeId===lifeId);if(!manifest)fail('TRUSTED_OWNER_MANIFEST_REQUIRED');
    return {...c,lifeId,sessionId,manifest};
  }
  function pathFor(lifeId,path,options) {
    return assertOwnershipPath({lifeId,manifests:rows,controlRoots:typeof controlRoots==='function'?controlRoots():controlRoots,protectedWriteRoots},path,options);
  }
  function assertSession(c,id) {
    const owner=sessionOwner?sessionOwner(String(id)):registry.owner(String(id));
    if((typeof owner==='string'?owner:owner?.lifeId??owner?.owner_life_id)!==c.lifeId)fail('OTHER_LIFE_PRIVATE_SESSION');
    return id;
  }
  function ownSessionIds(c) {
    if(!registry?.sessions)fail('OWNER_SESSION_CATALOG_REQUIRED');
    return registry.sessions(c.lifeId).map(row=>row.sessionId);
  }
  function visibleSession(c,id) {try{assertSession(c,id);return true;}catch{return false;}}
  function assertText(c,text) {
    // Catch direct path requests through opaque command/advisor interfaces. A
    // program can construct paths indirectly; that is the documented OS limit.
    const plain=normalized(text);
    for(const other of rows())if(other.lifeId!==c.lifeId)for(const root of privatePaths(other)) {
      const key=normalized(canonical(root));
      if(plain.includes(key)||plain.includes(normalized(root)))fail('OTHER_LIFE_PRIVATE_RESOURCE');
    }
    for(const root of typeof controlRoots==='function'?controlRoots():controlRoots)
      if(plain.includes(normalized(canonical(root)))||plain.includes(normalized(root)))fail('TRUSTED_CONTROL_RESOURCE');
  }
  function fileOperation(c,exec) {
    if(!fileTools.has(exec.name))return null;
    const args=exec.arguments??{},file=args.file_path??args.path;if(typeof file!=='string')return null;
    let base=c.manifest.deployment.workspace;
    if(exec.name==='list_files'&&!isAbsolute(file)) {
      const areas={workspace:base,...c.manifest.deployment.fileAreas},area=args.area??'workspace';
      if(!areas[area])fail('OWNER_FILE_AREA_BINDING_REQUIRED');base=areas[area];
    }
    const write=writingTools.has(exec.name);
    return {path:pathFor(c.lifeId,resolve(base,file),{write}),write};
  }
  function assertArguments(c,exec) {
    const args=exec.arguments??{};
    for(const key of ['lifeId','ownerLifeId','owner_life_id','acting_life_id','owner'])if(Object.hasOwn(args,key))fail('OWNER_IS_HOST_BOUND');
    if(Object.hasOwn(args,'life_id')&&exec.name!=='observe_life')fail('OWNER_IS_HOST_BOUND');
    fileOperation(c,exec);
    // Absolute paths carried by capabilities, attachment helpers, workspace
    // maintenance and recovery must pass the same policy, including aliases.
    const pathFields=/^(?:file_?path|paths?|root|roots|cwd|workspace|directory|target|source|destination|skill_?path|attachment_?path)$/i;
    const scan=(value,key)=>{
      if(typeof value==='string'){if(pathFields.test(key??'')&&isAbsolute(value))pathFor(c.lifeId,value,{write:writingTools.has(exec.name)});return;}
      if(Array.isArray(value)){for(const child of value)scan(child,key);return;}
      if(value&&typeof value==='object')for(const [field,child] of Object.entries(value))scan(child,field);
    };
    scan(args);
    if(sessionTools.has(exec.name))for(const id of [args.session_id,...args.session_ids??[],...args.parent_session_ids??[]].filter(Boolean))assertSession(c,id);
    if(['terminal','subagent','subagent_codex'].includes(exec.name))assertText(c,JSON.stringify(args));
    return c;
  }
  return {forAgent,pathFor,assertSession,ownSessionIds,visibleSession,assertArguments,assertText,fileOperation,
    active:()=>current.getStore(),run:(context,body)=>current.run(context,body),
    status:()=>({enabled:true,owner_life_id:ownerLifeId??null,policy:'logical-owner-routing',private_manifest_count:rows().length,
      shared_file_coordination:typeof acquireResource==='function'?'neutral-host-lease':'local-worker-only',os_strong_isolation:false})};
}

// Mount after services activate but before the first model step. No official
// Agent loop, tool implementation or persisted Session bytes are replaced.
export function mountNormalInterfaceOwnership(ctx,options) {
  if(ctx.get?.('normalInterfaceOwnership'))fail('NORMAL_INTERFACE_OWNERSHIP_ALREADY_MOUNTED');
  const policy=createNormalInterfaceOwnership(options),restores=[],files=new WeakMap();
  const patch=(object,name,wrap)=>{if(typeof object?.[name]!=='function')return;const old=object[name],next=wrap(old.bind(object));object[name]=next;restores.push(()=>{if(object[name]===next)object[name]=old;});};
  function wrapFs(fs,lifeId) {
    if(!fs)return;
    if(files.has(fs)){if(files.get(fs)!==lifeId)fail('FS_PROVIDER_OWNER_COLLISION');return;}
    files.set(fs,lifeId);
    patch(fs,'resolve',original=>async(...args)=>{const target=await original(...args);policy.pathFor(policy.active()?.lifeId??lifeId,fs.processPath(target));return target;});
    for(const name of ['stat','readText','readBytes','readByteRange','listDir','writeText','editText'])
      patch(fs,name,original=>async(target,...args)=>{policy.pathFor(policy.active()?.lifeId??lifeId,fs.processPath(target),{write:['writeText','editText'].includes(name)});return original(target,...args);});
    patch(fs,'streamText',original=>(target,...args)=>{policy.pathFor(policy.active()?.lifeId??lifeId,fs.processPath(target));return original(target,...args);});
  }
  function agentFs(agent) {
    const c=policy.forAgent(agent);
    const fs=ctx.agentPresets?.serviceFor?.(agent,'fs')??ctx.get?.('fs');wrapFs(fs,c.lifeId);return c;
  }
  if(options.ownerLifeId)wrapFs(ctx.get?.('fs'),options.ownerLifeId);
  for(const agent of ctx.agents?.list?.()??[])agentFs(agent);
  ctx.tools.guard(exec=>{try{policy.assertArguments(policy.forAgent(exec.agent),exec);}catch(error){return safeError(error);}});
  ctx.on('tools/execute',async(exec,next)=>{
    const c=agentFs(exec.agent);policy.assertArguments(c,exec);
    const file=policy.fileOperation(c,exec);let lease;
    try {
      if(file&&typeof options.acquireResource==='function') {
        lease=await options.acquireResource(c,{...file,signal:exec.signal});
        if(typeof lease?.release!=='function')fail('SHARED_RESOURCE_LEASE_REQUIRED');
        exec.signal?.throwIfAborted();
        const fresh=policy.assertArguments(policy.forAgent(exec.agent),exec);
        if(policy.fileOperation(fresh,exec)?.path!==file.path)fail('SHARED_RESOURCE_PATH_CHANGED');
      }
      return await policy.run(c,next);
    }finally{await lease?.release();}
  },{prepend:true});

  const query=ctx.get?.('sessionQuery');
  for(const name of ['observeSession','readSession','readTitle','readTitleSnapshot','listEvents','filterEvents','readSurface','traceSession'])
    patch(query,name,original=>async(id,...args)=>{const c=policy.active();if(c)policy.assertSession(c,id);const result=await original(id,...args);
      if(!c||name!=='traceSession')return result;
      const filterNodes=nodes=>(nodes??[]).filter(node=>policy.visibleSession(c,node.header?.id??node.session?.header?.id??node.record?.header?.id??node.sessionId)).map(node=>({...node,...node.descendants?{descendants:filterNodes(node.descendants)}:{}}));
      const ancestors=[];for(const node of result.ancestors??[]){if(!policy.visibleSession(c,node.header?.id))break;ancestors.push(node);}
      const safe={...result,ancestors,descendants:filterNodes(result.descendants)};
      if(result.root&&!policy.visibleSession(c,result.root.header?.id)){delete safe.root;safe.complete=false;}
      if(result.unresolvedParentId&&!policy.visibleSession(c,result.unresolvedParentId))delete safe.unresolvedParentId;
      if(ancestors.length!==(result.ancestors??[]).length)safe.complete=false;
      return safe;
    });
  for(const name of ['traceEvent','readEvent','searchEvents'])patch(query,name,original=>async(request,...args)=>{const c=policy.active();if(c)policy.assertSession(c,request.sessionId);return original(request,...args);});
  patch(query,'readTitleSnapshots',original=>async(ids,...args)=>{const c=policy.active();if(c)for(const id of ids)policy.assertSession(c,id);return original(ids,...args);});
  for(const name of ['listSessions','filterSessions'])patch(query,name,original=>async(...args)=>{const result=await original(...args),c=policy.active();return c?result.filter(row=>policy.visibleSession(c,row.header?.id??row.session?.id??row.sessionId)):result;});
  patch(query,'searchSessions',original=>async(request,...args)=>{const c=policy.active();return original(c?{...request,sessionFilters:[...request.sessionFilters??[],{kind:'id',values:policy.ownSessionIds(c)}]}:request,...args);});

  // The existing Codex advisor and spawn provider retain their implementations;
  // their delegator is verified before credentials/process work can begin.
  const providers=ctx.get?.('subagents');
  const wrapped=new WeakSet();
  function providerBoundary(provider) {
    if(!provider||wrapped.has(provider))return provider;wrapped.add(provider);
    patch(provider,'start',original=>request=>{const c=policy.forAgent(request.parent);policy.assertText(c,JSON.stringify(request.prompt));return policy.run(c,()=>original(request));});
    return provider;
  }
  for(const name of providers?.list?.()??[])providerBoundary(providers.getProvider(name));
  patch(providers,'registerProvider',original=>provider=>original(providerBoundary(provider)));
  ctx.provide('normalInterfaceOwnership',policy);
  ctx.systemPrompt?.section({name:'life:normal-interface-ownership',order:88,interpolate:false,
    text:'Host binds every operation to your life owner. Ordinary files, source readers, Skills, history, capabilities, delegates and recovery may access your own and public material; another life’s private roots and Host control data are refused. A delegate retains its delegator’s owner and has no new life identity. Terminal is still the current Windows user, not an OS privacy sandbox.'});
  ctx.effect(()=>()=>{for(const restore of restores.reverse())restore();},'normal interface owner policy');
  return policy;
}
