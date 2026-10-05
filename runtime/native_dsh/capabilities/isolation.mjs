/** Bounded IPC around a native worker; child errors never escape into the Host loop. */
import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';

export const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => ['DL_PYTHON', 'DL_WORKSPACE', 'DL_DATA', 'DSH_HOME', 'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'].includes(key.toUpperCase())));
export function credentialOperation(python, action, name, value) {
  return new Promise((accept, reject) => {
    const child = spawn(python, ['-X', 'utf8', resolve(import.meta.dirname, 'credentials.py')], {
      env: cleanEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 10000);
    let out = ''; let bytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { bytes += Buffer.byteLength(data); if (bytes > 65536) child.kill(); else out += data; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('CREDENTIAL_OPERATION_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      try { const result = JSON.parse(out); if (code !== 0 || !result.ok) throw new Error(); accept(result.result); }
      catch { reject(new Error('CREDENTIAL_OPERATION_FAILED')); }
    });
    child.stdin.on('error', () => {}); // A failed spawn closes the pipe too.
    child.stdin.end(JSON.stringify({ action, name, ...(value === undefined ? {} : { value }) }));
  });
}
export function createWorker({ profile, home, python, memoryMb, timeoutMs, startupTimeoutMs, maxBytes, credential, onSchemas, onFailure }) {
  const child = fork(resolve(import.meta.dirname, 'worker.mjs'), [], { cwd: profile,
    env: { ...cleanEnvironment(), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.stdout.resume(); child.stderr.resume(); // Never project child logs containing transport values.
  const pending = new Map();
  let stopped = false; let killing; let startupTimer; let job;
  let readyResolve; let readyReject;
  const ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
  const send = input => new Promise((accept, reject) => {
    if (!child.connected) return reject(new Error('CAPABILITY_UNAVAILABLE'));
    child.send(input, error => error ? reject(new Error('CAPABILITY_UNAVAILABLE')) : accept());
  });
  const fail = code => {
    clearTimeout(startupTimer);
    readyReject(new Error(code));
    for (const entry of pending.values()) entry.reject(new Error(code));
    pending.clear();
    if (!stopped) onFailure(code);
  };
  const terminate = () => killing ??= (async () => {
    stopped = true;
    clearTimeout(startupTimer);
    if (job) {
      const jobExited = once(job, 'exit').catch(() => {});
      job.stdin.end();
      if (job.exitCode === null && job.signalCode === null) await jobExited;
    }
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit').catch(() => {});
    // taskkill /T owns the entire Windows worker + stdio MCP descendant tree.
    // Wait for its exit; a timeout cannot leave a noncooperative child running.
    if (process.platform === 'win32' && child.pid) {
      await new Promise(accept => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
          { env: cleanEnvironment(), stdio: 'ignore', windowsHide: true });
        killer.once('error', () => { child.kill(); accept(); });
        killer.once('close', accept);
      });
    } else child.kill('SIGKILL');
    await exited;
  })();
  child.on('error', () => { fail('CAPABILITY_PROCESS_FAILED'); void terminate(); });
  child.on('exit', () => { fail('CAPABILITY_PROCESS_EXITED'); void terminate(); });
  child.on('message', async input => {
    try {
      if (Buffer.byteLength(JSON.stringify(input)) > maxBytes) { fail('CAPABILITY_OUTPUT_LIMIT'); await terminate(); return; }
      if (input.type === 'credential') {
        try { await send({ type: 'credential-result', id: input.id, ok: true, result: await credential(input.action, input.name) }); }
        catch { await send({ type: 'credential-result', id: input.id, ok: false }); }
      } else if (input.type === 'ready') {
        clearTimeout(startupTimer); onSchemas(input.schemas, input.instructions); readyResolve({ pid: input.pid });
      } else if (input.type === 'schemas') onSchemas(input.schemas, input.instructions);
      else if (input.type === 'output-limit') { fail('CAPABILITY_OUTPUT_LIMIT'); await terminate(); }
      else if (input.type === 'startup-failed') { fail('CAPABILITY_STARTUP_FAILED'); await terminate(); }
      else if (input.type === 'result' || input.type === 'failure') {
        const entry = pending.get(input.id);
        pending.delete(input.id);
        if (input.type === 'result') entry?.resolve(input.result);
        else entry?.reject(new Error('CAPABILITY_TOOL_FAILED'));
      }
    } catch { fail('CAPABILITY_PROTOCOL_FAILED'); await terminate(); }
  });
  startupTimer = setTimeout(() => { fail('CAPABILITY_STARTUP_TIMEOUT'); void terminate(); }, startupTimeoutMs);
  const assignJob = () => new Promise((accept, reject) => {
    if (process.platform !== 'win32') return reject(new Error('CAPABILITY_PLATFORM_UNSUPPORTED'));
    job = spawn(python, ['-X', 'utf8', resolve(import.meta.dirname, 'job.py'), String(child.pid), String(memoryMb)],
      { env: cleanEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    job.stderr.resume(); job.stdin.on('error', () => {});
    job.stdout.setEncoding('utf8');
    let data = '';
    job.stdout.on('data', chunk => {
      data += chunk;
      if (data.length > 1024) return reject(new Error('CAPABILITY_JOB_FAILED'));
      if (!data.includes('\n')) return;
      try { if (!JSON.parse(data).ready) throw new Error(); accept(); }
      catch { reject(new Error('CAPABILITY_JOB_FAILED')); }
    });
    job.once('error', () => reject(new Error('CAPABILITY_JOB_FAILED')));
    job.once('exit', () => { if (!stopped) { fail('CAPABILITY_JOB_EXITED'); void terminate(); } });
  });
  void assignJob().then(() => stopped ? undefined : send({ type: 'init', profile, home, maxOutputBytes: maxBytes }))
    .catch(() => { fail('CAPABILITY_PROCESS_FAILED'); void terminate(); });
  return {
    ready, pid: child.pid,
    async stop() {
      if (stopped) return terminate();
      stopped = true;
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return terminate();
      // A cooperative stop lets native MCP close children; hard termination is the fallback.
      const exited = once(child, 'exit').catch(() => {});
      const timer = setTimeout(() => void terminate(), 1000);
      try { await send({ type: 'stop' }); await exited; }
      catch { await terminate(); }
      finally { clearTimeout(timer); }
      await killing;
    },
    async call(name, args, callId, signal) {
      if (stopped || !child.connected) throw new Error('CAPABILITY_UNAVAILABLE');
      signal?.throwIfAborted();
      const id = randomUUID();
      const onAbort = () => { fail('CAPABILITY_CALL_CANCELLED'); void terminate(); };
      const timer = setTimeout(() => { fail('CAPABILITY_CALL_TIMEOUT'); void terminate(); }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await new Promise((accept, reject) => {
          pending.set(id, { resolve: accept, reject });
          void send({ type: 'call', id, name, arguments: args, callId: String(callId) }).catch(reject);
        });
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort); pending.delete(id);
        if (killing) await killing;
      }
    },
  };
}
