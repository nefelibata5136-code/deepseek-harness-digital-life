import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { loadPackage, installAnchor } from './packages.mjs';
import { installHostLifecycle } from './host-lifecycle.mjs';
const { boot, loadProfile, createRuntimeResolution, PluginPackages } = await loadPackage('@deepseek-ai/dsh-app-boot');
const here = dirname(fileURLToPath(import.meta.url));
process.env.DSH_HOME = resolve(here, 'home');
process.env.DSH_TELEMETRY_DISABLED = '1';
process.env.TZ = 'Asia/Shanghai';
const run = resolve(process.argv[2]);
await mkdir(run, { recursive: true });
for (const [key, suffix] of Object.entries({ SESSION_ROOT: 'sessions', STORAGE_ROOT: 'storages', WORKSPACE: 'workspace',
  ATTACHMENT_ROOT: 'attachments', RECEIVER_LOG: 'receiver.jsonl', ADMISSION_LOG: 'admission.jsonl', DUPLICATE_LOG: 'duplicates.jsonl' })) {
  process.env['C_TIME_' + key] = resolve(run, suffix);
}
process.env.C_TIME_TARGET_SESSION = process.argv[3];
if (process.argv.includes('--crash-after-flush-once')) {
  process.env.C_TIME_CRASH_AFTER_FLUSH_ONCE = '1';
  process.env.C_TIME_CRASH_MARKER = resolve(run, 'crashed-after-flush-once');
}
await mkdir(process.env.C_TIME_WORKSPACE, { recursive: true });
const profile = loadProfile('c-time-test', 'c-time-test', installAnchor);
const resolution = await createRuntimeResolution({ installAnchor, profile });
const ctx = await boot('c-time-test', resolve(profile.dir, 'cordis.yml'),
  [...profile.layers.flatMap(layer => layer.patches), ...profile.patches], async ctx => {
    await ctx.plugin(PluginPackages, { resolution });
  });
if (!ctx.get('cSchedule')) throw new Error('Technical Schedule component is not ready');
const send = item => process.stdout.write(JSON.stringify(item) + '\n');
send({ ready: true, pid: process.pid, version: '0.2.0-rc.2' });
let stopped = false;
const stop = async () => { if (stopped) return; stopped = true; await ctx.fiber.dispose(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
if (process.argv.includes('--service')) {
  installHostLifecycle(ctx, { sessionId: process.env.C_TIME_TARGET_SESSION, budgetProtected: true });
  await new Promise(() => {});
}
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  try {
    const request = JSON.parse(line);
    const sessionId = process.env.C_TIME_TARGET_SESSION;
    let result;
    switch (request.method) {
      case 'createSession': result = await ctx.sessionController.create({ sessionId, cwd: process.env.C_TIME_WORKSPACE }); break;
      case 'tools': {
        const resolved = await ctx.sessionController.resolveAgent(sessionId);
        if ('error' in resolved) throw resolved.error;
        result = resolved.agent.ctx.tools.schemas(resolved.agent).map(x => x.name); break;
      }
      case 'tool': {
        const resolved = await ctx.sessionController.resolveAgent(sessionId);
        if ('error' in resolved) throw resolved.error;
        result = await resolved.agent.ctx.tools.execute({ callId: randomUUID(), name: request.args.name,
          arguments: request.args.arguments, agent: resolved.agent, signal: new AbortController().signal });
        break;
      }
      case 'create': result = await ctx.cSchedule.create(sessionId, request.args); break;
      case 'list': result = await ctx.cSchedule.list({ sessionId }); break;
      case 'catalog': result = await ctx.cSchedule.catalog(); break;
      case 'update': result = await ctx.cSchedule.update({ sessionId, ...request.args }); break;
      case 'delete': result = await ctx.cSchedule.delete({ sessionId, ...request.args }); break;
      case 'history': result = await ctx.cSchedule.history({ sessionId, limit: 100, ...request.args }); break;
      case 'inspect': result = await ctx.sessionController.inspect(sessionId); break;
      case 'flush': result = await ctx.sessions.flush(ctx.sessions.get(sessionId)); break;
      case 'armCrashAfterFlush': {
        const original = ctx.sessions.flush.bind(ctx.sessions);
        ctx.sessions.flush = async session => {
          const flushed = await original(session);
          const hasSchedule = [...session.ownEvents()].some(event => event.type === 'agent/inbox/spliced'
            && event.data.inserted?.some(message => message.source?.kind === 'schedule'));
          if (flushed && hasSchedule) process.exit(91);
          return flushed;
        };
        result = { armed: true }; break;
      }
      case 'stop': await stop(); break;
      default: throw new Error('Unknown technical command');
    }
    send({ id: request.id, result });
  } catch (error) { send({ error: String(error) }); }
}
await stop();
