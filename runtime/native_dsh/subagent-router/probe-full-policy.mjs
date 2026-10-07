/** Start an official ephemeral Codex thread, inspect permissions, and stop without any model turn. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createCodexAdvisor } from '../digital-life/codex-advisor.mjs';
import { createHash } from 'node:crypto';

const base = resolve(import.meta.dirname, '../../..');
const protectedRoot = '.local/advisors';
const reportPath = join(base, 'reports/luna-full-access-20261007/policy-probe.json');
let stage;
const advisor = createCodexAdvisor({ capabilities: {}, async start(request) {
  stage = request.parent.session.header.cwd;
  return { id: 'offline-permission-check', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose() {} };
} }, { protectedRoot });
await advisor.provider.start({ parent: { session: { header: { cwd: '.local/workspace' } } },
  signal: new AbortController().signal, prompt: [] });

const require = createRequire(import.meta.url);
const manifestPath = require.resolve('@openai/codex/package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const binary = join(dirname(manifestPath), manifest.bin.codex);
const allowed = new Set(['DL_PYTHON', 'DL_WORKSPACE', 'DL_DATA', 'DSH_HOME', 'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
Object.assign(env, { CODEX_HOME: advisor.home, HOME: advisor.home, USERPROFILE: advisor.home });
const child = spawn(process.execPath, [binary, 'app-server', '--stdio'], { cwd: stage, env, windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
const methods = [];
let nextId = 1, incoming = '';
child.stderr.resume();
const fail = () => { for (const task of pending.values()) task.reject(new Error('CODEX_POLICY_PROBE_TRANSPORT_FAILED')); pending.clear(); };
child.once('error', fail);
child.once('exit', fail);
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  incoming += chunk;
  while (incoming.includes('\n')) {
    const end = incoming.indexOf('\n');
    const line = incoming.slice(0, end); incoming = incoming.slice(end + 1);
    let frame;
    try { frame = JSON.parse(line); } catch { fail(); continue; }
    if (frame.id != null && pending.has(frame.id)) {
      const task = pending.get(frame.id); pending.delete(frame.id);
      if (frame.error) task.reject(new Error('CODEX_POLICY_PROBE_RPC_FAILED:' + task.method));
      else task.resolve(frame.result);
    } else if (frame.method && frame.id != null) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'No approvals or model calls in this probe' } }) + '\n');
    }
  }
});
const call = (method, params) => {
  methods.push(method);
  const id = nextId++;
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CODEX_POLICY_PROBE_TIMEOUT:' + method)); }, 25000);
    pending.set(id, { method, resolve: value => { clearTimeout(timer); resolveCall(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
};
let report;
try {
  await call('initialize', { clientInfo: { name: 'persona-offline-permission-probe', version: '1.0.0' },
    capabilities: { experimentalApi: false, requestAttestation: false } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  const started = await call('thread/start', { cwd: stage, model: 'gpt-5.6-luna', ephemeral: true, approvalPolicy: 'never', sandbox:'danger-full-access' });
  const servers = await call('mcpServerStatus/list', {});
  const skills = await call('skills/list', { cwds: [stage], forceReload: true });
  const sandbox = started.sandbox ?? started.sandboxPolicy ?? started.threadSandboxPolicy;
  assert.equal(started.thread.ephemeral, true);
  assert.equal(started.approvalPolicy, 'never');
  assert.equal(sandbox.type, 'dangerFullAccess');

  assert.equal(resolve(started.cwd), resolve(stage));
  assert.equal((servers.data ?? []).length, 0);
  assert.equal(servers.nextCursor ?? null, null);
  const discoveredSkills = (skills.data ?? []).flatMap(row => row.skills ?? []).filter(skill => skill.enabled !== false);
  assert.ok(discoveredSkills.every(skill => resolve(skill.path).startsWith(resolve(advisor.home))));
  assert.equal(methods.includes('turn/start'), false);
  report = { ok: true, checkedAt: new Date().toISOString(), codexVersion: manifest.version,
    modelTurnsStarted: 0, methods, ephemeral: true, approvalPolicy: started.approvalPolicy,
    sandboxPolicy: sandbox, cwd: started.cwd, mcpServerCount: 0,
    skills: discoveredSkills.map(skill => ({ name: skill.name, path: skill.path })),
    sourceSha256: Object.fromEntries(await Promise.all(['codex-advisor.mjs', 'codex-advisor.test.mjs'].map(async name =>
      ['runtime/native_dsh/digital-life/' + name, createHash('sha256').update(await readFile(new URL('../digital-life/'+name, import.meta.url))).digest('hex')]))),
    limits: ['The official thread policy was inspected; no model or terminal command was run.',
      'OAuth refresh behavior across two independent login copies is not verified.'] };
} finally {
  child.stdin.end();
  if (child.exitCode === null) {
    child.kill();
    await new Promise(resolveExit => { if (child.exitCode !== null) resolveExit(); else child.once('exit', resolveExit); });
  }
}
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
