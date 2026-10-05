import './windows-dpi.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { bootNative, here } from './boot-native.mjs';
import {admitSteering} from './steering.mjs';
import { installHostLifecycle } from '../time_host/host-lifecycle.mjs';
import {incidents,formatIncident,recordIncident,errorChain} from './recovery/diagnostics.mjs';
const base = resolve(here, '../..');
const fixture = undefined;
const sessionId = process.env.DL_SESSION_ID;
if (!sessionId) throw new Error('Run scripts/start.mjs with an explicit persistent Session ID');
const marker = { native_session_id: sessionId };
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error('DEEPSEEK_API_KEY must be supplied to the Host process');
const ctx = await bootNative({ sessionId });
const workspace = resolve(process.env.DL_WORKSPACE || '.local/workspace');
const stateDir = resolve(process.env.DL_DATA || '.local', 'host-state');
await mkdir(stateDir, { recursive: true });
const token = randomBytes(32).toString('hex');
let busy = 0;
const safe = text => String(text).replaceAll(key, '[redacted]').replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]');
function authorized(request) {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const server = createServer(async (request, response) => {
  const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (!authorized(request)) return send(403, { error: 'Host authentication required' });
  try {
    if (request.method === 'GET' && request.url === '/status')
      return send(200, { ready: true, pid: process.pid, sessionId, busy: busy > 0 || ctx.personaTasks.running().length > 0,
        busySessionId: ctx.personaTasks.running()[0] ?? null, activeSessionIds: ctx.personaTasks.running(),
        fileOperationSessionId: ctx.workspaceFoundation.fileAccess?.owner ?? null,
        fileOperationSessionIds: ctx.workspaceFoundation.fileAccess?.owners ?? [], computer: ctx.get('personaComputer')?.status(),
        activityProgress:ctx.get('personaProgress')?.status(), inputCapabilities:{steer:true},
        filePermissions: ctx.workspaceFoundation.files,
        keyOutputGuard: ctx.keyOutputGuard.status(),
        privateVault: await ctx.personaPrivateVault.status(),
        recovery: await ctx.personaRecovery.status(),
        digitalLife: await ctx.get('personaLife')?.status(),
        budget: await ctx.personaHost.status(), time: new Date().toISOString() });
    if (request.method === 'GET' && request.url === '/tasks') return send(200,{tasks:await ctx.personaTasks.list(),primary:sessionId});
    if (request.method === 'GET' && request.url.startsWith('/activity?')) {
      const target=new URL(request.url,'http://127.0.0.1').searchParams.get('sessionId');
      if(!await ctx.personaTasks.accepts(target))return send(404,{error:'Unknown Session'});
      return send(200,await ctx.personaProgressPhases.read(target));
    }
    if (request.method === 'GET' && request.url === '/capabilities') return send(200, await ctx.personaCapabilities.list());
    if (request.method === 'GET' && request.url.startsWith('/screenshot?')) {
      const query = new URL(request.url, 'http://127.0.0.1').searchParams;
      const target = query.get('sessionId'); const id = query.get('attachmentId');
      if (!await ctx.personaTasks.accepts(target) || !/^sha256:[a-f0-9]{64}$/.test(id ?? '')) return send(404, { error: 'Unknown screenshot' });
      const resolved = await ctx.sessionController.resolveAgent(target);
      if ('error' in resolved) throw resolved.error;
      const ref = [...resolved.agent.session.ownEvents()].filter(e => e.type === 'tool/result')
        .flatMap(e => e.data.message?.content ?? []).find(b => b.type === 'image' && b.attachment?.attachmentId === id)?.attachment;
      if (!ref) return send(404, { error: 'Screenshot does not belong to this Session' });
      const stored = await ctx.attachments.readImage(ref);
      response.writeHead(200, { 'content-type': ref.mediaType, 'cache-control': 'no-store' });
      return response.end(stored.data);
    }
    if (request.method !== 'POST' || !['/prompt','/tasks','/computer','/cancel','/capabilities','/recovery'].includes(request.url)) return send(404, { error: 'Unknown Host command' });
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Prompt exceeds channel limit'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(request.url==='/recovery')return send(200,await ctx.personaRecovery.command(input));
    if (request.url === '/capabilities') return send(200, await ctx.personaCapabilities.manage(input));
    if (request.url === '/computer') {
      if (!ctx.get('personaComputer')) return send(503, { error: 'Windows capability unavailable' });
      return send(200, ctx.personaComputer.setEnabled(input.enabled));
    }
    if (request.url === '/cancel') {
      if (!await ctx.personaTasks.accepts(input.sessionId)) return send(404, { error: 'Unknown Session' });
      return send(200, ctx.sessionController.cancel({ sessionId: input.sessionId }));
    }
    if(request.url === '/tasks') return send(200,await ctx.personaTasks.create({sessionId:input.requestId,title:input.title}));
    const targetSessionId=input.sessionId;
    if (!await ctx.personaTasks.accepts(targetSessionId) || typeof input.text !== 'string' || !input.text.trim()
        || !/^[a-f0-9-]{36}$/i.test(input.requestId)) throw new Error('Invalid prompt or Session identity');
    if(input.mode!==undefined&&!['queue','steer'].includes(input.mode))return send(400,{error:'Invalid prompt mode'});
    const budget = await ctx.personaHost.status();
    if (budget.stop_reason) return send(423, { state: 'stopped_budget', sessionId, budget });
    if(input.mode==='steer'||input.mode==='queue'){
      // Desktop receipt must not wait for the active turn's submission lease or idle.
      // The native inbox preserves ordering, request deduplication and turn identity.
      return send(200,await admitSteering(ctx,input));
    }
    busy++;
    let lease;
    try {
      lease = await ctx.personaTurnAdmission.acquire(targetSessionId);
      // Recheck the shared budget after waiting for earlier tasks.
      const admittedBudget = await ctx.personaHost.status();
      if (admittedBudget.stop_reason) return send(423, {state: 'stopped_budget', sessionId: targetSessionId, budget: admittedBudget});
      // Existing launcher uses the primary identity; desktop may address another authorized task.
      const sessionId=targetSessionId;
      // Keep the persisted spelling: native create compares cwd byte-for-byte,
      // while earlier main Sessions used forward slashes on Windows.
      const stored = (await ctx.sessionQuery.listSessions()).find(record => record.header.id === sessionId);
      if (stored && resolve(stored.header.cwd ?? '') !== workspace) throw new Error('Session belongs to another workspace');
      await ctx.sessionController.create({ sessionId, cwd: stored?.header.cwd ?? workspace });
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in resolved) throw resolved.error;
      const { agent } = resolved;
      if ([...agent.session.ownEvents()].some(event => event.type === 'agent/inbox/spliced'
          && event.data.inserted?.some(message => message.source?.rpcId === input.requestId)))
        return send(409, { error: 'This prompt identity was already admitted; inspect its native history', sessionId });
      const firstSeq = agent.session.nextSeq ?? [...agent.session.ownEvents()].length;
      const errors = [];
      const unlisten = ctx.on('agent/error', ({ agent: owner, error }) => {
        if (owner !== agent) return;
        if (ctx.personaPrivateVault.isSensitive(owner.session)) {
          errors.push('PRIVATE_EXECUTION_ERROR'); return;
        }
        const chain = []; let current = error;
        for (let i = 0; current && i < 5; i++, current = current.cause)
          chain.push(safe(String(current.name ?? 'Error') + ': ' + String(current.message ?? current)));
        errors.push(chain.join(' <- '));
      });
      try {
        await ctx.sessionController.prompt({ sessionId, requestId: input.requestId, mode: 'queue', clientTimeZone: 'Asia/Shanghai',
          content: [{ type: 'text', text: input.text }] }, new AbortController().signal);
        await agent.whenIdle();
      } finally { unlisten(); }
      await ctx.sessions.flush(agent.session);
      ctx.workspaceFoundation.assertHealthy(); ctx.workspaceFoundation.drain();
      ctx.get('personaLife')?.assertHealthy();
      const events = [...agent.session.ownEvents()].filter(event => event.seq >= firstSeq);
      const currentBudget = await ctx.personaHost.status();
      const diagnostics=(await incidents({sessionId:targetSessionId,limit:20})).filter(d=>
        Date.parse(d.observedAt)>=(events[0]?.time??Date.now())&&['http-response','request-transport','provider-stream','stream-or-accounting'].includes(d.stage));
      if(diagnostics.length)errors.push(...diagnostics.map(formatIncident));
      const text = events.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message?.content ?? [])
        .filter(block => block.type === 'text').map(block => block.text).join('\n');
      const complete = !errors.length && events.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed');
      return send(200, { state: complete ? 'completed' : currentBudget.stop_reason ? 'stopped_budget' : 'requires_inspection',
        sessionId, requestId: input.requestId, role: sessionId === marker.native_session_id ? 'consciousness-seat' : 'activity',
        authoritative: sessionId === marker.native_session_id, text: safe(text), errors, diagnostics, budget: currentBudget,
        tools: events.filter(event => event.type === 'tool/call').map(event => event.data.name), eventCount: events.length });
    } finally { lease?.release();busy--; }
  } catch (error) {
    const diagnostic=await recordIncident({stage:'host-command',sessionId,route:request.url.split('?')[0],causes:errorChain(error)});
    return send(500, { error: safe(error)+'\n'+formatIncident(diagnostic),sessionId,diagnostic });
  }
});
await new Promise((yes, no) => { server.once('error', no); server.listen(Number(process.env.DL_PORT || 18741), '127.0.0.1', yes); });
const port = server.address().port;
await writeFile(resolve(stateDir, '.host-control.json'), JSON.stringify({ port, token, pid: process.pid, sessionId }) + '\n', { mode: 0o600 });
ctx.effect(() => () => new Promise(resolve => server.close(resolve)), 'persona authenticated text channel');
installHostLifecycle(ctx, { sessionId, budgetProtected: true });
console.log(JSON.stringify({ ready: true, sessionId, pid: process.pid, port, fixture: !!fixture }));
