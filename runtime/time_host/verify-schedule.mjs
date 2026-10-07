import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTime } from './time-host.mjs';
import { control } from './control.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../reports/task_C/runs', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
await mkdir(root, { recursive: true });
const transcript = [];
const children = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function host(dir, session, extraEnv = {}) {
  const child = spawn(process.execPath, [resolve(here, 'technical-runner.mjs'), dir, session], {
    windowsHide: true, env: { ...process.env, ...extraEnv, DEEPSEEK_API_KEY: '', DASHSCOPE_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const pending = new Map(); let counter = 0; let readyResolve; let readyReject;
  const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
  const timer = setTimeout(() => readyReject(new Error('Host startup timeout')), 15000);
  const rl = createInterface({ input: child.stdout });
  child.stderr.on('data', bytes => transcript.push({ pid: child.pid, stderr: bytes.toString() }));
  rl.on('line', line => {
    transcript.push({ pid: child.pid, line });
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.ready) { clearTimeout(timer); readyResolve(event); }
    if (event.id !== undefined) { const action = pending.get(event.id); pending.delete(event.id); action?.resolve(event.result); }
    if (event.error) { const action = pending.values().next().value; action?.reject(new Error(event.error)); }
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    clearTimeout(timer); children.delete(child); readyReject(new Error('Host exited: ' + code));
    for (const action of pending.values()) action.reject(new Error('Host exited: ' + code));
    pending.clear(); resolve({ code, signal });
  }));
  await ready;
  const rpc = (method, args) => new Promise((yes, no) => {
    const id = ++counter;
    const timeout = setTimeout(() => { pending.delete(id); no(new Error('RPC timeout: ' + method)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); yes(value); }, reject: error => { clearTimeout(timeout); no(error); } });
    child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
  });
  return { child, rpc, exited, stop: async () => { child.stdin.write('{"method":"stop"}\n'); return exited; } };
}
async function until(check, label, ms = 12000) {
  const start = Date.now();
  while (Date.now() - start < ms) { const value = await check(); if (value) return value; await delay(100); }
  throw new Error('Timeout: ' + label);
}
const readLines = async path => {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const scheduleMessages = inspection => {
  const found = new Map();
  for (const event of inspection.events) {
    for (const message of event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : []) {
      if (message.source?.kind === 'schedule') found.set(message.id, message);
    }
  }
  return [...found.values()];
};
const checks = {};
try {
  const session = randomUUID(); const dir = resolve(root, 'main');
  let h = await host(dir, session);
  assert.equal((await h.rpc('createSession')).sessionId, session);
  const tools = await h.rpc('tools');
  for (const name of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']) assert(tools.includes(name));
  checks.tools = tools;
  const toolCreated = await h.rpc('tool', { name: 'schedule_create', arguments: {
    title: 'Native tool CRUD', prompt: 'No delivery', at: new Date(Date.now() + 3600000).toISOString() } });
  assert.equal(toolCreated.isError, false);
  const toolId = toolCreated.value.id;
  const toolListed = await h.rpc('tool', { name: 'schedule_list', arguments: {} });
  assert.equal(toolListed.isError, false); assert(toolListed.value.some(x => x.id === toolId));
  const toolUpdated = await h.rpc('tool', { name: 'schedule_update', arguments: { id: toolId, title: 'Tool updated' } });
  assert.equal(toolUpdated.isError, false); assert.equal(toolUpdated.value.title, 'Tool updated');
  const toolDeleted = await h.rpc('tool', { name: 'schedule_delete', arguments: { id: toolId } });
  assert.equal(toolDeleted.isError, false); assert.equal(toolDeleted.value.deleted, true);
  checks.native_tool_dispatch_crud = true;
  const record = await h.rpc('create', { title: 'CRUD temporary', prompt: 'CRUD no delivery', after_seconds: 300 });
  assert.equal((await h.rpc('list'))[0].id, record.id);
  const update = await h.rpc('update', { id: record.id, expected: record, title: 'Updated title', prompt: 'Updated instruction', change: { kind: 'at', at: new Date(Date.now() + 600000).toISOString() } });
  assert.equal(update.updated, true); assert.equal(update.record.id, record.id);
  const conflict = await h.rpc('update', { id: record.id, expected: record, title: 'Stale write' });
  assert.equal(conflict.code, 'schedule_conflict');
  assert.equal((await h.rpc('delete', { id: record.id })).deleted, true);
  assert.equal((await h.rpc('list')).length, 0);
  checks.crud_and_conflict = true;
  const once = await h.rpc('create', { title: 'Real one-shot', prompt: 'C one-shot test receipt', after_seconds: 1 });
  await until(async () => (await h.rpc('catalog')).find(x => x.id === once.id)?.status === 'inactive', 'one-shot receipt');
  await until(async () => (await readLines(resolve(dir, 'receiver.jsonl'))).length > 0, 'keyless receiver');
  await until(async () => (await h.rpc('inspect')).events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'), 'successful keyless turn');
  const first = await h.rpc('inspect');
  assert.equal(scheduleMessages(first).length, 1);
  const clockMessages = first.events.filter(x => x.type === 'user/message' && x.data.source?.kind === 'time-context');
  assert(clockMessages.some(x => JSON.stringify(x.data).includes('+08:00[Asia/Shanghai]')));
  assert(first.events.some(x => x.type === 'user/message' && JSON.stringify(x.data).includes('Host time zone: Asia/Shanghai')));
  checks.real_one_shot = { taskId: once.id, sessionId: session, receipt: (await h.rpc('catalog'))[0].lastDelivery, native_schedule_messages: 1 };
  checks.official_runtime_clock = { timeZone: 'Asia/Shanghai', browser: 'unavailable', samples: clockMessages.map(x => x.data.content) };
  const future = await h.rpc('create', { title: 'Survive restart', prompt: 'C restart receipt', after_seconds: 3 });
  assert.equal((await h.stop()).code, 0);
  h = await host(dir, session);
  assert((await h.rpc('list')).some(x => x.id === future.id));
  await until(async () => (await h.rpc('catalog')).find(x => x.id === future.id)?.status === 'inactive', 'restart receipt');
  checks.host_restart_and_cold_session = { id: future.id, sessionId: session, messages: scheduleMessages(await h.rpc('inspect')).length };
  const overdue = await h.rpc('create', { title: 'Expire offline', prompt: 'C overdue receipt', after_seconds: 1 });
  const offlineReceiverCount = (await readLines(resolve(dir, 'receiver.jsonl'))).length;
  await h.stop(); await delay(1600);
  const before = JSON.parse(await readFile(resolve(dir, 'storages/schedule.json'), 'utf8'));
  assert.equal(before.tables.tasks[overdue.id].status, 'active');
  assert(Date.parse(before.tables.tasks[overdue.id].record.scheduledAt) <= Date.now());
  assert.equal((await readLines(resolve(dir, 'receiver.jsonl'))).length, offlineReceiverCount);
  h = await host(dir, session);
  await until(async () => (await h.rpc('catalog')).find(x => x.id === overdue.id)?.status === 'inactive', 'offline catch-up');
  assert.equal(scheduleMessages(await h.rpc('inspect')).length, 3);
  await h.stop(); h = await host(dir, session); await delay(600);
  assert.equal(scheduleMessages(await h.rpc('inspect')).length, 3);
  checks.offline_due_one_shot_and_no_repeat_after_restart = true;
  await h.stop();

  const crashSession = randomUUID(); const crashDir = resolve(root, 'split-write-crash');
  h = await host(crashDir, crashSession); await h.rpc('createSession');
  await h.rpc('armCrashAfterFlush');
  const crashRecord = await h.rpc('create', { title: 'Crash recovery', prompt: 'C split-write receipt', after_seconds: 1 });
  assert.equal((await h.exited).code, 91);
  const raw = JSON.parse(await readFile(resolve(crashDir, 'storages/schedule.json'), 'utf8'));
  assert(JSON.stringify(raw).includes('"active"')); assert(!JSON.stringify(raw).includes('lastDelivery'));
  h = await host(crashDir, crashSession);
  await until(async () => (await h.rpc('catalog')).find(x => x.id === crashRecord.id)?.status === 'inactive', 'deduplicated crash receipt');
  assert.equal(scheduleMessages(await h.rpc('inspect')).length, 1);
  assert.equal((await readLines(resolve(crashDir, 'duplicates.jsonl'))).length, 1);
  assert.equal((await h.rpc('catalog'))[0].lastDelivery.messageId, scheduleMessages(await h.rpc('inspect'))[0].id);
  checks.split_write_crash_deduplicated = { crashCode: 91, taskId: crashRecord.id, original_session: crashSession,
    native_schedule_message_ids: scheduleMessages(await h.rpc('inspect')).map(x => x.id), suppressed: await readLines(resolve(crashDir, 'duplicates.jsonl')) };
  await h.stop();

  const blockedSession = randomUUID(); const blockedDir = resolve(root, 'budget-denied');
  h = await host(blockedDir, blockedSession, { C_TIME_BUDGET_ALLOW: '0' }); await h.rpc('createSession');
  const blocked = await h.rpc('create', { title: 'Denied test', prompt: 'Must not be enqueued', after_seconds: 1 });
  await delay(1500);
  assert.equal((await h.rpc('catalog')).find(x => x.id === blocked.id).status, 'active');
  assert.equal(scheduleMessages(await h.rpc('inspect')).length, 0);
  assert.equal((await readLines(resolve(blockedDir, 'receiver.jsonl'))).length, 0);
  checks.budget_denial_before_enqueue = { denied: true, receiver_requests: 0, note: 'Technical admission stub; D integration is separate.' };
  await h.stop();
  const supervisedSession = randomUUID(); const supervisedDir = resolve(root, 'supervised-native-host');
  h = await host(supervisedDir, supervisedSession); await h.rpc('createSession');
  await h.rpc('flush');
  const supervisedTask = await h.rpc('create', { title: 'Supervised native crash', prompt: 'C real Host crash recovery', after_seconds: 3 });
  await h.stop();
  const config = { technicalTest: true, instanceId: 'c-native-host-' + randomUUID(), command: process.execPath,
    args: [resolve(here, 'technical-runner.mjs'), supervisedDir, supervisedSession, '--service', '--crash-after-flush-once'],
    cwd: here, stateDir: resolve(supervisedDir, 'supervisor'), backoffBaseMs: 300, backoffMaxMs: 1000,
    maxFailures: 3, readyTimeoutMs: 10000, stopTimeoutMs: 5000 };
  await mkdir(config.stateDir, { recursive: true });
  const configFile = resolve(config.stateDir, 'config.json'); await writeFile(configFile, JSON.stringify(config, null, 2));
  const supervisor = spawn(process.execPath, [resolve(here, 'supervisor.mjs'), configFile], {
    windowsHide: true, env: { ...process.env, DEEPSEEK_API_KEY: '', DASHSCOPE_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(supervisor); supervisor.stdout.resume(); supervisor.stderr.resume();
  const supervisorExit = new Promise(resolve => supervisor.once('exit', code => { children.delete(supervisor); resolve(code); }));
  await until(async () => {
    try { return JSON.parse(await readFile(resolve(supervisedDir, 'storages/schedule.json'), 'utf8')).tables.tasks[supervisedTask.id].status === 'inactive'; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'supervisor actual native Host recovery', 20000);
  await control(config, 'stop'); assert.equal(await supervisorExit, 0);
  h = await host(supervisedDir, supervisedSession);
  const messages = scheduleMessages(await h.rpc('inspect'));
  assert.equal(messages.length, 1);
  assert.equal((await h.rpc('catalog'))[0].lastDelivery.messageId, messages[0].id);
  const supervisorEvents = await readLines(resolve(config.stateDir, 'supervisor.jsonl'));
  assert.equal(supervisorEvents.filter(x => x.event === 'host_spawn').length, 2);
  assert(supervisorEvents.some(x => x.event === 'host_exit' && x.code === 91));
  checks.actual_native_host_supervised_crash_recovery = { sessionId: supervisedSession, taskId: supervisedTask.id,
    spawns: 2, crashCode: 91, scheduleMessages: 1, originalMessageId: messages[0].id };
  await h.stop();
  const result = { observed_at: currentTime(), version: '0.2.0-rc.2', passed: true, paid_api_called: false,
    formal_persona_woken: false, root, checks };
  await writeFile(resolve(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  await writeFile(resolve(here, '../../reports/task_C/schedule-verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const child of children) { child.kill(); }
  await writeFile(resolve(root, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
}
