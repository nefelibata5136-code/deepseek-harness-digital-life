// Conflicts return immediately by default. Internal journal callers may opt into
// a cancellable queue. null owns the whole workspace for opaque file writers.
import {emitToolPhase} from '../activity_progress/events.mjs';
import {isXiaohongshuWorkspaceRead} from './xiaohongshu-read-policy.mjs';
export function createFileLocks({waitForConflicts=false}={}) {
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
    acquire(key,owner,signal,metadata={}){return new Promise((accept,reject)=>{
      if(disposed)return reject(Error('File locks disposed'));
      if(signal.aborted)return reject(signal.reason??Error('File operation cancelled'));
      const blockers=[...held.values()].filter(item=>item.key===null||key===null||item.key===key);
      if(!waitForConflicts&&blockers.length) {
        const details={error:'FILE_BUSY',path:key,scope:key===null?'workspace':'file',operation_started:false,
          holders:blockers.map(item=>({session_id:item.owner,...item.metadata})),
          next_action:'Do other work; read the current file again before a later edit. No automatic retry.'};
        return reject(Object.assign(new Error(JSON.stringify(details)),{code:'FILE_BUSY',details}));
      }
      const item={key,owner,signal,accept,reject,metadata,abort(){const i=queue.indexOf(item);if(i>=0)queue.splice(i,1);reject(signal.reason??Error('File operation cancelled'));pump();}};
      signal.addEventListener('abort',item.abort,{once:true});queue.push(item);pump();
    });},dispose(){disposed=true;for(const item of queue.splice(0)){item.signal.removeEventListener('abort',item.abort);item.reject(Error('File locks disposed'));}}};
}
// These operations persist in their own Host journals/services, not the
// workspace tree. Keep this policy beside the actual middleware so a stale
// caller's conversationTools snapshot cannot send them into whole-tree backups.
export const hostOnlyTools=new Set(['life_send_message','life_contact_list','life_event_read',
  'life_receive_message','life_message_decide','life_action_result','life_message_timeline',
  'observe_life','life_activity_publish','life_inbox_policy','life_turn_ack','life_stage_memory',
  'life_recent_events_review','life_room_read','life_room_list','life_room_post',
  'subagent','subagent_codex','subagent_results','subagent_cancel','life_delegate',
  'billing_status','billing_details','billing_recover','budget_status','cache_status',
  'capability_snapshot','context_compact_prepare','context_compact_read','context_compact_commit',
  'context_compact_status','web_search','web_fetch',
  // Exact read-only tools of the installed browser service. They touch its
  // dedicated profile/connection, never the owner's workspace tree.
  'mcp__persona_browser__browser_status','mcp__persona_browser__browser_read_page',
  'mcp__persona_browser__browser_get_state','mcp__persona_browser__browser_list_tabs',
  'mcp__persona_browser__browser_screenshot',
  'dots_status','delegate_to_dots','continue_dots_task','check_dots_task','read_dots_result',
  'dots_task_list','dots_task_history','cancel_dots_task','dots_manual_handoff']);
export function mountParallelFileVersions(ctx,run,conversationTools){
  const locks=createFileLocks(),stateLocks=createFileLocks({waitForConflicts:true}),active=new Map();let failure;
  const snapshot = run.async ?? run;
  const version = (exec,stage,...args) => run.asyncObserved
    ? run.asyncObserved(state=>emitToolPhase(ctx,exec,state==='queued'?'waiting-'+stage:stage),...args)
    : (emitToolPhase(ctx,exec,stage),snapshot(...args));
  run('recover');
  ctx.on('agent/pre-step',async(_exec,next)=>{if(failure)throw failure;return next();});
  ctx.on('tools/execute',async(exec,next)=>{
    const owner=String(exec.agent?.session.id??'host-tool');
    // State is journaled in native tool/result, outside the workspace. Serialize
    // only this Session's self-state; keep native provenance and restart recovery.
    if(exec.name==='digital_life_state_update'){
      const lease=await stateLocks.acquire(owner,owner,exec.signal);let ok=false;
      try{emitToolPhase(ctx,exec,'executing');const result=await next();ok=true;return result;}
      finally{lease.release();emitToolPhase(ctx,exec,ok?'completed':'failed');}
    }
    if(conversationTools.has(exec.name)||hostOnlyTools.has(exec.name)||
      /^cap__(?:dots|moltbook|bluesky)__/.test(exec.name)||isXiaohongshuWorkspaceRead(exec.name))return next();
    const readOnly=['read','read_source'].includes(exec.name);
    if(failure&&!readOnly)throw failure;
    let key=null;
    // Resolve exactly as the native tools do. Their existing link, credential and
    // compare-and-swap policies remain authoritative. Opaque tools take all files.
    if(['read','write','edit','read_source'].includes(exec.name)&&typeof exec.arguments?.file_path==='string'){
      const fs=ctx.get('fs');
      const target=await fs.resolve(exec.arguments.file_path,{cwd:exec.agent?.session.header.cwd});
      key=fs.processPath(target).replaceAll('\\','/');if(process.platform==='win32')key=key.toLowerCase();
    }
    if(exec.name==='life_working_write'){
      const fs=ctx.get('fs');
      const target=await fs.resolve('memory/continuity.md',{cwd:exec.agent?.session.header.cwd});
      key=fs.processPath(target).replaceAll('\\','/');if(process.platform==='win32')key=key.toLowerCase();
    }
    // A read never edits the file, so it needs neither a write reservation nor
    // a backup. Native permission and version/observation checks still run.
    if(readOnly)return next();
    emitToolPhase(ctx,exec,'waiting-lock');
    let lease,token,ok=false;
    try{
      const contexts=ctx.get('multiLifeContexts')??ctx.get('multiLifeOwnership')?.contexts;
      const lifeId=contexts?.forAgent?.(exec.agent)?.lifeId;
      lease=await locks.acquire(key,owner,exec.signal,{tool:exec.name,call_id:exec.callId??null,...lifeId?{life_id:lifeId}:{}});
      exec.signal.throwIfAborted();
      if(failure)throw failure;
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
  ctx.effect(()=>async()=>{locks.dispose();stateLocks.dispose();await drain();},'parallel file operation durability');
  return {run,drain,active,speedPolicyVersion:'file-conflict-return-v2',fileAccess:{get owner(){return locks.owners[0]??null;},get owners(){return locks.owners;}},assertHealthy:()=>{if(failure)throw failure;}};
}
