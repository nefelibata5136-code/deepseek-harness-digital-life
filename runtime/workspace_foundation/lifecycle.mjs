import { mountParallelFileVersions } from './file-operation-locks.mjs';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { here } from './native.mjs';

export function controller(config) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['DL_PYTHON', 'DL_WORKSPACE', 'DL_DATA', 'DSH_HOME', 'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())));
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONDONTWRITEBYTECODE = '1';
  const argv = args => ['-X', 'utf8', resolve(here, 'snapshots.py'),
    '--workspace', config.workspace, '--store', config.store, ...args.map(String)];
  const options = { env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  const run = (...args) => {
    const result = spawnSync(config.python, ['-X', 'utf8', resolve(here, 'snapshots.py'),
      '--workspace', config.workspace, '--store', config.store, ...args.map(String)],
    { env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('Workspace versions failed; action blocked. Inspect protected store/controller locally.');
    return JSON.parse(result.stdout);
  };
  // Startup can be synchronous; admitted tool snapshots must leave the Host
  // event loop available to HTTP, cancellation and other independent files.
  let tail = Promise.resolve(), asyncFailure;
  const enqueue = (observe, args) => {
    observe?.('queued');
    const task = tail.then(async () => {
      if (asyncFailure) throw asyncFailure;
      observe?.('executing');
      try { const {stdout} = await promisify(execFile)(config.python, argv(args), options); return JSON.parse(stdout); }
      catch { asyncFailure = new Error('Workspace versions failed; action blocked. Inspect protected store/controller locally.'); throw asyncFailure; }
    });
    tail = task.catch(() => {});
    return task;
  };
  run.async = (...args) => enqueue(null,args);
  run.asyncObserved = (observe,...args) => enqueue(observe,args);
  return run;
}

// Mount before creation of the top-level Agent. The official session feed is synchronous,
// but its errors are contained: latch failures and veto the awaited pre-step/tool seam.
export function mountWorkspaceVersions(ctx, config) {
  const run = controller(config);
  const active = new Map();
  if(config.parallelFileWrites) return mountParallelFileVersions(ctx,run,conversationTools);
  if(config.parallelConversations) return mountFileOperationVersions(ctx, run);
  let failure;
  const matches = session => session.header.origin !== 'subagent'
    && resolve(session.header.cwd ?? '') === resolve(config.workspace);
  run('recover');
  ctx.on('session/event', (session, event) => {
    if (!matches(session) || !['turn/start', 'turn/end'].includes(event.type)) return;
    try {
      if (event.type === 'turn/start') {
        if (failure) throw failure;
        const receipt = run('begin', '--session', session.id, '--turn', event.data.turn, '--owner-pid', process.pid);
        active.set(session.id, receipt.token);
      } else if (active.has(session.id)) {
        run('end', '--token', active.get(session.id), '--reason', 'after-turn:' + (event.data.reason?.kind ?? 'unknown'));
        active.delete(session.id);
      }
    } catch (error) { failure = error; }
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (failure) throw failure;
    if (matches(agent.session) && !active.has(agent.session.id)) throw new Error('Top-level turn lacks a protected pre-turn snapshot');
    return next();
  });
  ctx.on('tools/execute', async (exec, next) => {
    if (failure) throw failure;
    if (!['write', 'edit', 'terminal'].includes(exec.name)) return next();
    run('snapshot', '--reason', 'before-tool:' + exec.name);
    try { return await next(); }
    finally {
      try { run('snapshot', '--reason', 'after-tool:' + exec.name); }
      catch (error) { failure = error; throw error; }
    }
  });
  const drain = () => {
    if (failure) throw failure;
    // Do not close active markers on disposal. An interrupted turn remains recoverable.
    run('snapshot', '--reason', 'harness-dispose');
  };
  ctx.effect(() => drain, 'workspace-foundation durability');
  return { run, drain, active, assertHealthy: () => { if (failure) throw failure; } };
}

// All conversations may run. Only one file-capable tool body may execute at a time.
// Take the existing durable begin/end snapshots around that operation, including
// child Agents and external one-shot workers, rather than holding a turn-wide lock.
const conversationTools = new Set(['budget_status', 'schedule_create', 'schedule_list',
  'schedule_update', 'schedule_delete', 'session_search', 'session_event_search',
  'session_trace', 'session_event_trace', 'session_event_read', 'task_list', 'task_create',
  'context_compact', 'capability_list', 'capability_search', 'subagent', 'send_message',
  'list_agents', 'interrupt_agent']);
function mountFileOperationVersions(ctx, run) {
  let failure, owner=null, tail=Promise.resolve();
  const active=new Map();
  run('recover');
  ctx.on('agent/pre-step',async(_exec,next)=>{if(failure)throw failure;return next();});
  ctx.on('tools/execute',async(exec,next)=>{
    if(failure)throw failure;
    if(conversationTools.has(exec.name))return next();
    const prior=tail;
    let release;
    tail=new Promise(resolve=>{release=resolve;});
    let token;
    try {
      // The wait is cancellable. Keep the queue link until the predecessor finishes
      // even when a waiting Agent is cancelled, so followers cannot bypass it.
      await new Promise((resolve,reject)=>{
        const abort=()=>reject(exec.signal.reason??new Error('File operation cancelled'));
        if(exec.signal.aborted)return abort();
        exec.signal.addEventListener('abort',abort,{once:true});
        prior.then(()=>{exec.signal.removeEventListener('abort',abort);resolve();});
      });
      exec.signal.throwIfAborted();
      if(failure)throw failure;
      owner=String(exec.agent?.session.id??'host-tool');
      const turn=[...(exec.agent?.session.ownEvents()??[])].findLast(e=>e.type==='turn/start')?.data.turn??0;
      try {token=run('begin','--session',owner,'--turn',turn,'--owner-pid',process.pid).token;}
      catch(error){failure=error;owner=null;throw error;}
      active.set(owner,token);
      try {run('snapshot','--reason','before-tool:'+exec.name);}
      catch(error){failure=error;throw error;}
      return await next();
    } finally {
      if(token) {
        try {run('end','--token',token,'--reason','after-tool:'+exec.name);}
        catch(error){failure=error;throw error;}
        finally{active.delete(owner);owner=null;release();}
      } else {
        // Acquiring/snapshot failure must block later operations, but cancellation
        // of an unstarted tool is an ordinary event and does not poison the Host.
        prior.then(release);
      }
    }
  },{prepend:true});
  const drain=()=>{if(failure)throw failure;if(owner===null)run('snapshot','--reason','harness-dispose');};
  ctx.effect(()=>drain,'workspace-foundation file-operation durability');
  return {run,drain,active,fileAccess:{get owner(){return owner;}},assertHealthy:()=>{if(failure)throw failure;}};
}
