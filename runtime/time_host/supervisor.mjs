import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, appendFile, unlink } from 'node:fs/promises';
import { resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTime } from './time-host.mjs';

export function controlPipe(config) {
  return '\\\\.\\pipe\\persona-time-host-' + createHash('sha256').update(config.instanceId).digest('hex').slice(0, 24);
}
export async function readConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!config.instanceId || !isAbsolute(config.stateDir) || !isAbsolute(config.command) || !isAbsolute(config.cwd)
      || !Array.isArray(config.args) || config.args.some(value => typeof value !== 'string')) throw new Error('Invalid supervisor config');
  if (!config.technicalTest && (config.instanceId !== 'persona-official-harness' || config.integrated !== true
      || !config.sessionId || !isAbsolute(config.legacyLock))) throw new Error('A integration and formal Session are required');
  return config;
}
const exists = async path => { try { await readFile(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500); socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

export async function supervise(config) {
  await mkdir(config.stateDir, { recursive: true });
  const disabled = resolve(config.stateDir, 'disabled');
  if (await exists(disabled)) return { disabled: true };
  const logPath = resolve(config.stateDir, 'supervisor.jsonl');
  const runtimePath = resolve(config.stateDir, 'runtime.json');
  const log = event => appendFile(logPath, JSON.stringify({ observedAt: currentTime(), ...event }) + '\n');
  let stopped = false; let child; let status = 'starting'; let failures = []; let backoffTimer;
  let releaseDelay; let doneResolve;
  const done = new Promise(resolve => { doneResolve = resolve; });
  const server = net.createServer(socket => {
    let text = '';
    socket.on('data', async bytes => {
      text += bytes;
      if (text.length > 4096) { socket.destroy(); return; }
      if (!text.includes('\n')) return;
      const command = text.trim(); text = '';
      if (command === 'status') { socket.end(JSON.stringify({ status, supervisorPid: process.pid, hostPid: child?.pid ?? null,
        sessionId: config.sessionId ?? null, time: currentTime() }) + '\n'); return; }
      if (command === 'stop' || command === 'disable') {
        if (command === 'disable') await writeFile(disabled, currentTime().utc + '\n');
        socket.end('{"accepted":true}\n'); await stop(command); return;
      }
      socket.end('{"error":"unknown control command"}\n');
    });
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(controlPipe(config), yes); });
  const save = async () => {
    await writeFile(runtimePath, JSON.stringify({ observedAt: currentTime(), status, supervisorPid: process.pid,
      hostPid: child?.pid ?? null, sessionId: config.sessionId ?? null }, null, 2) + '\n');
  };
  async function forceTree(target) {
    if (process.platform === 'win32') await new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('exit', resolve);
    });
    else target.kill('SIGKILL');
  }
  async function stop(reason) {
    if (stopped) return; stopped = true; status = 'stopping'; clearTimeout(backoffTimer); releaseDelay?.();
    await log({ event: 'stop_requested', reason }); await save();
    if (child && child.exitCode === null && child.signalCode === null) {
      const target = child;
      const exited = new Promise(resolve => target.once('exit', resolve));
      if (target.connected) target.send({ type: 'persona-host-stop' });
      else target.kill('SIGTERM');
      let timeout;
      const forced = await Promise.race([exited.then(() => false), new Promise(resolve => {
        timeout = setTimeout(() => resolve(true), config.stopTimeoutMs ?? 15000);
      })]);
      clearTimeout(timeout);
      if (forced) { await log({ event: 'forced_stop_after_timeout', hostPid: target.pid }); await forceTree(target); await exited; }
    }
    status = reason === 'disable' ? 'disabled' : 'stopped'; await save();
    await new Promise(resolve => server.close(resolve)); doneResolve();
  }
  process.once('SIGINT', () => { void stop('SIGINT'); });
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  async function run() {
    while (!stopped) {
      if (await exists(disabled)) { await stop('disable'); break; }
      if (!config.technicalTest && (await listening(8000) || await exists(config.legacyLock))) {
        await log({ event: 'conflicting_legacy_or_oneshot_runtime' }); await stop('conflict'); break;
      }
      if (stopped) break;
      status = 'starting';
      child = spawn(config.command, config.args, { cwd: config.cwd, windowsHide: true,
        env: { ...process.env, TZ: 'Asia/Shanghai', DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const target = child; const launched = Date.now();
      await save(); await log({ event: 'host_spawn', hostPid: child.pid });
      const secrets = Object.entries(process.env).filter(([key]) => /API_KEY|TOKEN|SECRET|PASSWORD/i.test(key))
        .map(([, value]) => value).filter(value => value.length >= 8);
      const scrub = value => { for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value.replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]'); };
      let logChain = Promise.resolve();
      for (const stream of [target.stdout, target.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', data => { logChain = logChain.then(() => appendFile(resolve(config.stateDir, 'host.private.log'), scrub(data))); });
      }
      let readyTimer = setTimeout(() => { void log({ event: 'host_readiness_timeout' }).then(() => forceTree(target)); }, config.readyTimeoutMs ?? 30000);
      target.on('message', event => {
        if (event?.type !== 'persona-host-ready') return;
        if (!config.technicalTest && (event.sessionId !== config.sessionId || event.budgetProtected !== true)) {
          void log({ event: 'invalid_host_readiness' }).then(() => forceTree(target)); return;
        }
        clearTimeout(readyTimer); readyTimer = undefined; status = 'running'; void save();
      });
      const outcome = await new Promise(resolve => {
        target.once('error', error => resolve({ code: null, error: error.code }));
        target.once('exit', (code, signal) => resolve({ code, signal }));
      });
      clearTimeout(readyTimer); await logChain;
      await log({ event: 'host_exit', ...outcome, hostPid: target.pid }); child = undefined;
      if (stopped) break;
      if (outcome.code === 0) { await stop('normal_host_exit'); break; }
      const now = Date.now();
      if (now - launched > (config.stableAfterMs ?? 300000)) failures = [];
      failures = [...failures.filter(time => now - time < (config.failureWindowMs ?? 300000)), now];
      if (failures.length >= (config.maxFailures ?? 5)) {
        await writeFile(disabled, 'crash-loop ' + currentTime().utc + '\n');
        await log({ event: 'crash_loop_disabled', failures: failures.length }); await stop('disable'); break;
      }
      const delay = Math.min((config.backoffBaseMs ?? 2000) * 2 ** (failures.length - 1), config.backoffMaxMs ?? 60000);
      status = 'backoff'; await save(); await log({ event: 'restart_backoff', delayMs: delay });
      await new Promise(resolve => { releaseDelay = resolve; backoffTimer = setTimeout(resolve, delay); });
      releaseDelay = undefined;
    }
  }
  const work = run().catch(async error => { await log({ event: 'supervisor_failure', error: error.code ?? error.name }); await stop('supervisor_failure'); throw error; });
  await done; await work;
  return { status };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await supervise(await readConfig(resolve(process.argv[2]))))); }
  catch (error) { console.error(error.code === 'EADDRINUSE' ? 'A Host supervisor already owns this instance.' : error.message); process.exitCode = 1; }
}
