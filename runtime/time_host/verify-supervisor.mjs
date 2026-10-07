import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { control } from './control.mjs';
import { currentTime } from './time-host.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../reports/task_C/supervisor-runs', randomUUID());
await mkdir(root, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error('Timeout: ' + label);
}
const children = new Set(); const checks = {};
async function launch(name, mode, settings = {}) {
  const config = { technicalTest: true, instanceId: 'c-supervisor-' + name + '-' + randomUUID(),
    command: process.execPath, args: [resolve(here, 'supervisor-fixture.mjs'), mode], cwd: root,
    stateDir: resolve(root, name), backoffBaseMs: 150, backoffMaxMs: 600, maxFailures: 3,
    readyTimeoutMs: 2000, stopTimeoutMs: 2000, ...settings };
  await mkdir(config.stateDir, { recursive: true });
  const path = resolve(config.stateDir, 'config.json'); await writeFile(path, JSON.stringify(config, null, 2));
  const child = spawn(process.execPath, [resolve(here, 'supervisor.mjs'), path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); const exit = new Promise(resolve => child.on('exit', code => { children.delete(child); resolve(code); }));
  let stdout = ''; let stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  return { config, path, child, exit, output: () => ({ stdout, stderr }) };
}
try {
  let h = await launch('normal', 'normal');
  assert.equal(await h.exit, 0);
  let events = (await readFile(resolve(h.config.stateDir, 'supervisor.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(x => x.event === 'host_spawn').length, 1); checks.normal_exit_not_restarted = true;
  h = await launch('steady', 'steady');
  await until(async () => (await control(h.config)).status === 'running', 'steady host');
  const second = spawn(process.execPath, [resolve(here, 'supervisor.mjs'), h.path], { windowsHide: true, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => second.once('exit', resolve)), 1); checks.single_instance_lock = true;
  assert.equal((await control(h.config, 'stop')).accepted, true); assert.equal(await h.exit, 0);
  checks.explicit_stop_and_host_exit = true;
  h = await launch('crashing', 'crash'); assert.equal(await h.exit, 0);
  events = (await readFile(resolve(h.config.stateDir, 'supervisor.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(x => x.event === 'host_spawn').length, 3);
  assert.deepEqual(events.filter(x => x.event === 'restart_backoff').map(x => x.delayMs), [150, 300]);
  await access(resolve(h.config.stateDir, 'disabled'));
  checks.crash_backoff_and_storm_disabled = { spawns: 3, delays: [150, 300] };
  const disabledChild = spawn(process.execPath, [resolve(here, 'supervisor.mjs'), h.path], { windowsHide: true, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => disabledChild.once('exit', resolve)), 0);
  const after = (await readFile(resolve(h.config.stateDir, 'supervisor.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(after.length, events.length); checks.disabled_prevents_relaunch = true;
  await control(h.config, 'enable');
  checks.enable_does_not_start = (await control(h.config)).live === false;
  h = await launch('disable', 'steady'); await until(async () => (await control(h.config)).status === 'running', 'disable host');
  await control(h.config, 'disable'); assert.equal(await h.exit, 0); await access(resolve(h.config.stateDir, 'disabled'));
  checks.explicit_disable_stops_host = true;
  h = await launch('restart-once', 'crash-once'); await until(async () => (await control(h.config)).status === 'running', 'restart-once recovery');
  await until(async () => {
    const lines = (await readFile(resolve(h.config.stateDir, 'supervisor.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    return lines.filter(x => x.event === 'host_spawn').length === 2 && (await control(h.config)).status === 'running';
  }, 'abnormal recovery');
  await control(h.config, 'stop'); await h.exit; checks.abnormal_exit_recovered = true;
  const result = { observedAt: currentTime(), passed: true, paid_api_called: false, production_task_registered: false, root, checks };
  await writeFile(resolve(here, '../../reports/task_C/supervisor-verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const child of children) child.kill();
}
