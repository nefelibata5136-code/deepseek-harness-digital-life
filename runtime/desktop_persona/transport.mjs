// Desktop transport adapter. The existing protected Host alone runs Persona.
import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as requestHttp } from 'node:http';
import {attachmentPrompt} from '../clipboard_attachments/store.mjs';
import {attachmentRoutes} from '../clipboard_attachments/routes.mjs';
import {projectActivity,splitProgress,phaseLabels} from '../activity_progress/events.mjs';
import {incidents,formatIncident} from '../native_dsh/recovery/diagnostics.mjs';
import {reasoningText, redactThinking} from './thinking.mjs';
import {translateThinking,closeTranslation} from './chrome-translation.mjs';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execute = promisify(execFile);
const uploadRoot = '.local/workspace/uploads/harness';
async function validateUploadSession(sessionId) {
  if(!/^[a-f0-9-]{36}$/i.test(sessionId??''))throw new Error('附件会话身份无效');
  const catalog=await hostRequest('GET','/tasks');
  if(catalog.status!==200||!catalog.value.tasks.some(task=>task.sessionId===sessionId))throw new Error('附件会话不属于人格');
}
async function usageReport(sessionId) {
  const {stdout} = await execute('python',
    ['-X', 'utf8', '-m', 'budget_guard.usage_report', '--session-id', sessionId],
    {cwd:resolve(base, 'runtime'), windowsHide:true, timeout:10000, maxBuffer:65536});
  return JSON.parse(stdout);
}
export const inject = ['connection'];
const clean = value => String(value).replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g, '[凭据已隐藏]');
export async function identity() {
  const marker = JSON.parse(await readFile(resolve(base, 'reports/first_native_start.json'), 'utf8'));
  if (!/^[a-f0-9-]{36}$/i.test(marker.native_session_id)) throw new Error('正式会话身份缺失');
  return marker.native_session_id;
}
export async function hostRequest(method, route, value, signal) {
  if (!['/status', '/prompt', '/tasks', '/computer', '/cancel','/recovery'].includes(route) && !route.startsWith('/screenshot?') && !route.startsWith('/activity?') && !route.startsWith('/thinking?')) throw new Error('Unsupported Persona route');
  const sessionId = await identity();
  const control = JSON.parse(await readFile(resolve(base, 'runtime/native_dsh/host-state/.host-control.json'), 'utf8'));
  if (control.sessionId !== sessionId || control.port !== 18741) throw new Error('人格 Host 身份不符');
  // A native turn may legitimately take longer than fetch's five-minute header
  // deadline. POST stays admitted until completion/disconnect, with no retry.
  return requestLocalHost({method,route,token:control.token,
    body:value?JSON.stringify({...value, sessionId:value.sessionId??sessionId}):undefined,
    signal:signal??(method==='GET'?AbortSignal.timeout(15000):undefined)});
}
export function requestLocalHost({method,route,token,body,signal,port=18741}) {
  return new Promise((accept,reject)=>{
    const request=requestHttp({hostname:'127.0.0.1',port,path:route,method,signal,
      headers:{authorization:'Bearer '+token,'content-type':'application/json'}},response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('error',reject);
      response.once('end',()=>{
        try {const bytes=Buffer.concat(chunks),mediaType=response.headers['content-type'];
          accept({status:response.statusCode,mediaType,value:mediaType?.startsWith('image/')?new Uint8Array(bytes):JSON.parse(bytes.toString('utf8'))});
        }catch(error){reject(error);}
      });
    });
    request.on('error',reject);request.end(body);
  });
}
async function supervisorStatus() {
  const {control}=await import('../time_host/control.mjs');
  const {readConfig}=await import('../time_host/supervisor.mjs');
  const config = await readConfig(resolve(base, 'runtime/time_host/production-config.json'));
  const live = await control(config, 'status');
  let disabled = false, reason;
  try { await access(resolve(config.stateDir, 'disabled')); disabled = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const state = live.status ?? live.last?.status ?? 'stopped';
  if (!live.status) {
    const events = (await readFile(resolve(config.stateDir, 'supervisor.jsonl'), 'utf8')).trim().split('\n');
    reason = events.slice(-10).map(line => JSON.parse(line)).findLast(e => e.event === 'stop_requested')?.reason;
  }
  return { state, disabled, reason };
}
export async function connectionStatus({ request = hostRequest, supervisor = supervisorStatus } = {}) {
  try {
    const response = await request('GET', '/status', undefined, AbortSignal.timeout(15000));
    if (response.status === 200 && response.value.ready) return response.value;
  } catch { /* Diagnose locally; no model request, restart, or automatic retry. */ }
  let diagnostic;
  try { diagnostic = await supervisor(); } catch { diagnostic = { state: 'unknown' }; }
  const state = diagnostic.disabled ? 'disabled' : diagnostic.reason === 'conflict' ? 'conflict' : diagnostic.state;
  const message = {
    starting: '人格正在启动，连接恢复后会自动显示会话。',
    running: '人格的连接暂时不可用，正在重新连接。',
    conflict: '人格启动已暂停：检测到旧运行环境，需先停止旧后台。',
    disabled: '人格常驻服务已暂停，需重新启用并启动。',
    stopped: '人格常驻服务尚未启动；启动后页面会自动重连。',
  }[state] ?? '暂时无法连接人格常驻服务；恢复后页面会自动重连。';
  return { ready: false, connection: { state, message } };
}
export function projectEvents(events,phaseEvents=[]) {
  const rows = [];
  const activity=projectActivity(events,phaseEvents);
  const calls = new Map();
  let turn = 0;
  let running = false;
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'turn/start') {turn = d.turn; running = true;}
    if (e.type === 'turn/end') running = false;
    const common = {seq: e.seq, time: e.time, turn: d.turn ?? turn};
    if (e.type === 'agent/inbox/spliced') {
      for (const [index, m] of (d.inserted ?? []).entries()) {
        const kind = m.source?.kind;
        if (m.role !== 'user' || !['user', 'schedule'].includes(kind)) continue;
        const text = (m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (text) rows.push({...common, id: e.seq + ':user:' + index, role: kind === 'schedule' ? 'schedule' : 'user',
          source: kind, requestId: m.source?.rpcId, text: clean(text)});
      }
    } else if (e.type === 'assistant/message') {
      const reasoning = reasoningText(d.message);
      if (reasoning) {
        rows.push({...common, id:'thinking:'+common.turn+':'+e.seq, role:'thinking', text:redactThinking(reasoning)});
      }
      const text = (d.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      for(const update of activity.progress.filter(r=>r.seq===e.seq))rows.push({...update,text:clean(update.text)});
      const ordinary=splitProgress(text).text;
      if (ordinary) rows.push({...common, id: e.seq + ':assistant', role: 'assistant', text: clean(ordinary), usage: d.usage});
    } else if (e.type === 'tool/call') {
      let args;
      try {args = JSON.parse(clean(d.arguments));} catch {args = {};}
      const row = {...common, id: e.seq + ':tool', role: 'tool', text: clean(d.name), detail: clean(d.arguments),
        args, callId: d.callId, status: 'running',phases:activity.phases.get(String(d.callId))??[]};
      calls.set(d.callId, row); rows.push(row);
    } else if (e.type === 'tool/result') {
      const text = (d.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const images = (d.message?.content ?? []).filter(b => b.type === 'image').map(b => b.attachment);
      const row = calls.get(d.message?.toolCallId);
      if (row) Object.assign(row, {result: clean(text), images, resultSeq: e.seq, finishedAt: e.time,
        durationMs: Math.max(0, e.time - row.time), isError: !!d.message?.isError,
        status: d.message?.isError ? 'error' : 'completed'});
      else rows.push({...common, id: e.seq + ':result', role: 'result', text: '工具结果', detail: clean(text)});
    } else if (e.type === 'turn/end') {
      // A call lacking a result when its turn stops has an unknown outcome.
      for (const row of calls.values()) if (row.turn === d.turn && row.status === 'running') row.status = 'unknown';
      if (d.reason?.kind !== 'completed') rows.push({...common, id: e.seq + ':end', role: 'state',
        text: '执行中断：' + clean(typeof d.reason === 'object' ? d.reason.error?.message ?? d.reason.kind : d.reason)});
    }
  }
  return {rows, running,currentTurn:turn};
}
export async function history(selected) {
  const primary = await identity();
  const sessionId = selected ?? primary;
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('Invalid Session identity');
  if(sessionId!==primary) {
    const catalog=await hostRequest('GET','/tasks');
    if(catalog.status!==200||!catalog.value.tasks.some(task=>task.sessionId===sessionId))throw new Error('Session outside Persona workspace');
  }
  const root = resolve(base, 'runtime/native_dsh/home/sessions');
  let records;
  // Only the formal Session is read. No persistence writer, restore or activation.
  for (const entry of await readdir(root, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = resolve(root, entry.name, sessionId, 'session.v4.jsonl');
    let text;
    try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // A concurrent append's unfinished final line is not yet a durable event.
    records = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
    break;
  }
  if (!records || records[0].type !== 'session' || records[0].version !== 4 || records[0].id !== sessionId)
    throw new Error('正式会话日志不可用');
  const events = records.slice(1);
  events.forEach((event, index) => { if (event.seq !== index) throw new Error('原生日志序号不连续'); });
  let accounting, accountingError;
  try { accounting = await usageReport(sessionId); }
  catch { accountingError = '用量统计暂不可用'; }
  let phaseEvents=[],activityError;
  try {
    const activity=await hostRequest('GET','/activity?'+new URLSearchParams({sessionId}));
    if(activity.status===200)phaseEvents=activity.value.events??[];
    else activityError='阶段记录尚未接入当前运行服务';
  } catch {activityError='阶段记录暂不可用';}
  const projected = projectEvents(events,phaseEvents);
  const failures=await incidents({sessionId,limit:100});
  for(const row of projected.rows)if(row.role==='state'&&row.text.startsWith('执行中断')) {
    const incident=failures.find(d=>Date.parse(d.observedAt)<=row.time+10000&&Date.parse(d.observedAt)>=row.time-180000);
    if(incident){row.diagnostic=incident;row.text+='\n'+formatIncident(incident);}
  }
  if (sessionId !== primary) for (const row of projected.rows) if (row.role === 'assistant') row.role = 'advice';
  const live = await hostRequest('GET', '/status');
  if (live.status !== 200 || !Array.isArray(live.value.activeSessionIds)) throw new Error('执行状态暂不可用');
  const running = live.value.activeSessionIds.includes(sessionId);
  let wakeups = [], scheduleError;
  try {
    const stored = JSON.parse(await readFile(resolve(base, 'runtime/native_dsh/home/storages/schedule.json'), 'utf8'));
    wakeups = Object.values(stored.tables?.tasks ?? {}).filter(t => t.sessionId === sessionId && t.status === 'active')
      .map(t => ({id:t.record.id, title:t.record.title, kind:t.record.kind, scheduledAt:t.record.scheduledAt ?? null}))
      .sort((a,b) => String(a.scheduledAt ?? '').localeCompare(String(b.scheduledAt ?? '')));
  } catch (error) { if (error.code !== 'ENOENT') scheduleError = '唤醒计划暂不可用'; }
  const interrupted = projected.running && !running;
  if (interrupted) for (const row of projected.rows) if (row.role === 'tool' && row.status === 'running') row.status = 'unknown';
  return {sessionId, role:sessionId===primary?'consciousness-seat':'activity',authoritative:sessionId===primary,
    eventCount: events.length, ...projected, running, interrupted, wakeups, scheduleError,
    lastEventAt:events.at(-1)?.time ?? null, lastActivityAt:Math.max(events.at(-1)?.time??0,...phaseEvents.map(e=>e.occurredAt)),
    activityError,accounting, accountingError, observedAt: new Date().toISOString()};
}
export function apply(ctx) {
  ctx.effect(()=>()=>{void closeTranslation();});
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-persona-transport-version': '1.1.0'},
  });
  for (const [path, methods, action] of [
    ...attachmentRoutes({root:uploadRoot,validateSession:validateUploadSession}),
    ['/api/persona.status', ['GET'], async () => json(await connectionStatus())],
    ['/api/persona.translateThinking', ['POST'], async request => {
      const input=await request.json();return json(await translateThinking(input.text));
    }],
    ['/api/persona.thinking', ['GET'], async request => {
      const sessionId = new URL(request.url).searchParams.get('sessionId');
      if (!/^[a-f0-9-]{36}$/i.test(sessionId ?? '')) return json({error:'Invalid thinking Session'},400);
      const r = await hostRequest('GET','/thinking?' + new URLSearchParams({sessionId}));
      return json(r.value, r.status);
    }],
    ['/api/persona.recovery', ['GET','POST'], async request => {
      const input=request.method==='GET'?{action:'status',sessionId:new URL(request.url).searchParams.get('sessionId')??await identity()}:await request.json();
      const r=await hostRequest('POST','/recovery',input);return json(r.value,r.status);
    }],
    ['/api/persona.activity', ['GET'], async request => {
      const sessionId=new URL(request.url).searchParams.get('sessionId');
      if(!/^[a-f0-9-]{36}$/i.test(sessionId??''))throw Error('Invalid activity Session');
      const r=await hostRequest('GET','/activity?'+new URLSearchParams({sessionId}));
      return json(r.status===200?{...r.value,events:(r.value.events??[]).map(e=>({...e,label:phaseLabels[e.phase]??'阶段未知'}))}:r.value,r.status);
    }],
    ['/api/persona.computer', ['POST'], async request => {
      const r = await hostRequest('POST', '/computer', await request.json()); return json(r.value, r.status);
    }],
    ['/api/persona.cancel', ['POST'], async request => {
      const r = await hostRequest('POST', '/cancel', await request.json()); return json(r.value, r.status);
    }],
    ['/api/persona.screenshot', ['GET'], async request => {
      const q = new URL(request.url).searchParams;
      const r = await hostRequest('GET', '/screenshot?' + new URLSearchParams({sessionId:q.get('sessionId') ?? '', attachmentId:q.get('attachmentId') ?? ''}));
      return r.mediaType?.startsWith('image/') ? new Response(r.value, {status:r.status, headers:{'content-type':r.mediaType,'cache-control':'no-store'}}) : json(r.value,r.status);
    }],
    ['/api/persona.history', ['GET'], async request => json(await history(new URL(request.url).searchParams.get('sessionId')??undefined))],
    ['/api/persona.historyState', ['GET'], async request => json(await history(new URL(request.url).searchParams.get('sessionId')??undefined))],
    ['/api/persona.historyUsage', ['GET'], async request => json(await history(new URL(request.url).searchParams.get('sessionId')??undefined))],
    ['/api/persona.tasks', ['GET','POST'], async request => {
      const input=request.method==='POST'?await request.json():undefined;
      const r=await hostRequest(request.method,'/tasks',input);
      return json(r.value,r.status);
    }],
    ['/api/persona.prompt', ['POST'], async request => {
      const body = await request.text();
      if (Buffer.byteLength(body) > 65536) return json({error: '消息超过 64 KB'}, 413);
      const input = JSON.parse(body);
      if (typeof input.text !== 'string' || (!input.text.trim()&&!input.attachmentIds?.length) || !/^[a-f0-9-]{36}$/i.test(input.requestId))
        return json({error: '消息内容或身份无效'}, 400);
      await validateUploadSession(input.sessionId);
      const text=await attachmentPrompt(uploadRoot,input.sessionId,input.text,input.attachmentIds);
      // Do not retry on timeout/disconnect: accepted native requests remain in history.
      if(input.mode!==undefined&&!['queue','steer'].includes(input.mode))return json({error:'消息模式无效'},400);
      const r = await hostRequest('POST', '/prompt', {text, requestId: input.requestId,sessionId:input.sessionId,mode:input.mode??'queue',humanPrincipalId:'human:maintainer'});
      return json(r.value, r.status);
    }],
  ]) ctx.effect(() => ctx.connection.fetch.register({path, methods, requestBody: 'buffered', fetch: async request => {
    try { return await action(request); }
    catch (error) { return json({error: clean(error.message ?? error)}, 503); }
  }}));
}
