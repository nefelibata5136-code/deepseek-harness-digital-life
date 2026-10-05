// A fair, cancellable lock by canonical file path. null owns the whole workspace.
import {emitToolPhase} from '../activity_progress/events.mjs';
import {isXiaohongshuWorkspaceRead} from './xiaohongshu-read-policy.mjs';
export function createFileLocks() {
  const held=new Map(),queue=[];let disposed=false;
  const conflicts=key=>[...held.values()].some(item=>item.key===null||key===null||item.key===key);
  function pump(){
    const blocked=new Set();
    for(let i=0;i<queue.length;i++){
      const item=queue[i];
      if(item.key===null){if(i===0&&!held.size){queue.splice(i,1);grant(item);}break;}
      if(conflicts(item.key)||blocked.has(item.key)){blocked.add(item.key);continue;}
      queue.splice(i--,1);grant(item);
    }
  }
  function grant(item){
    item.signal.removeEventListener('abort',item.abort);const token=Symbol();held.set(token,item);
    let released=false;item.accept({release(){if(released)return;released=true;held.delete(token);pump();}});
  }
  return {get owners(){return [...new Set([...held.values()].map(i=>i.owner))];},
    acquire(key,owner,signal){return new Promise((accept,reject)=>{
      if(disposed)return reject(Error('File locks disposed'));
      if(signal.aborted)return reject(signal.reason??Error('File operation cancelled'));
      const item={key,owner,signal,accept,reject,abort(){const i=queue.indexOf(item);if(i>=0)queue.splice(i,1);reject(signal.reason??Error('File operation cancelled'));pump();}};
      signal.addEventListener('abort',item.abort,{once:true});queue.push(item);pump();
    });},dispose(){disposed=true;for(const item of queue.splice(0)){item.signal.removeEventListener('abort',item.abort);item.reject(Error('File locks disposed'));}}};
}
export function mountParallelFileVersions(ctx,run,conversationTools){
  const locks=createFileLocks(),active=new Map();let failure;
  const snapshot = run.async ?? run;
  const version = (exec,stage,...args) => run.asyncObserved
    ? run.asyncObserved(state=>emitToolPhase(ctx,exec,state==='queued'?'waiting-'+stage:stage),...args)
    : (emitToolPhase(ctx,exec,stage),snapshot(...args));
  run('recover');
  ctx.on('agent/pre-step',async(_exec,next)=>{if(failure)throw failure;return next();});
  ctx.on('tools/execute',async(exec,next)=>{
    if(failure)throw failure;
    if(conversationTools.has(exec.name)||isXiaohongshuWorkspaceRead(exec.name))return next();
    const owner=String(exec.agent?.session.id??'host-tool');
    let key=null;
    // Resolve exactly as the native tools do. Their existing link, credential and
    // compare-and-swap policies remain authoritative. Opaque tools take all files.
    if(['read','write','edit','read_source'].includes(exec.name)&&typeof exec.arguments?.file_path==='string'){
      const fs=ctx.get('fs');
      const target=await fs.resolve(exec.arguments.file_path,{cwd:exec.agent?.session.header.cwd});
      key=fs.processPath(target).replaceAll('\\','/');if(process.platform==='win32')key=key.toLowerCase();
    }
    emitToolPhase(ctx,exec,'waiting-lock');
    let lease,token,ok=false;
    try{
      lease=await locks.acquire(key,owner,exec.signal);
      exec.signal.throwIfAborted();if(failure)throw failure;
      try{token=(await version(exec,'before-backup','begin-file','--session',owner,'--path-key',key??'*','--tool',exec.name,'--owner-pid',process.pid)).token;}
      catch(error){failure=error;throw error;}
      active.set(token,owner);emitToolPhase(ctx,exec,'executing');
      const result=await next();ok=true;return result;
    }finally{
      try{if(token)await version(exec,'after-backup','end-file','--token',token,'--reason','after-tool:'+exec.name);}
      catch(error){ok=false;failure=error;throw error;}
      finally{if(token)active.delete(token);lease?.release();emitToolPhase(ctx,exec,ok?'completed':'failed');}
    }
  },{prepend:true});
  const drain=async()=>{if(failure)throw failure;if(!active.size)await snapshot('snapshot','--reason','harness-dispose');};
  ctx.effect(()=>async()=>{locks.dispose();await drain();},'parallel file operation durability');
  return {run,drain,active,fileAccess:{get owner(){return locks.owners[0]??null;},get owners(){return locks.owners;}},assertHealthy:()=>{if(failure)throw failure;}};
}
