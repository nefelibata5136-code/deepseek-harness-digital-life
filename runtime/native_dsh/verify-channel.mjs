import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { here, bootNative } from './boot-native.mjs';
const root = resolve(here, '../../reports/task_A/channel-' + randomUUID());
const workspace = resolve(root, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(resolve(workspace, 'persona-core.md'), await readFile('.local/workspace/persona-core.md'));
await writeFile(resolve(workspace, 'AGENTS.md'), '# Offline channel fixture\n');
await writeFile(resolve(workspace, 'audit.txt'), 'before\n');
const sessionId = randomUUID();
// A legacy Windows Session can have the same workspace spelled with '/'.
// Seed that exact persisted header and verify HTTP reuse, including cold resume.
process.env.DEEPSEEK_API_KEY = 'offline-placeholder-not-a-secret';
const seed = await bootNative({sessionId,testRoot:root});
try {
  await seed.sessionController.create({sessionId,cwd:workspace.replaceAll('\\','/')});
  const {agent} = await seed.sessionController.resolveAgent(sessionId);
  await seed.sessions.flush(agent.session);
} finally {await seed.fiber.dispose();}
async function start() {
  const child = spawn(process.execPath, [resolve(here, 'native-host.mjs'), '--offline-fixture', root, sessionId],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostics = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', data => diagnostics += data);
  await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('Fixture Host readiness timeout: ' + diagnostics)), 20000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => {
      if (data.includes('"ready":true')) { clearTimeout(timer); yes(); }
    });
    child.once('exit', code => { clearTimeout(timer); no(new Error('Fixture Host exited ' + code + ': ' + diagnostics)); });
  });
  const control = JSON.parse(await readFile(resolve(root, 'host-state/.host-control.json'), 'utf8'));
  return { child, control, async stop() {
    const exited = new Promise((yes, no) => { child.once('exit', code => code === 0 ? yes() : no(new Error('Fixture stop ' + code + ': ' + diagnostics))); });
    child.send({ type: 'persona-host-stop' }); await exited;
  } };
}
async function rpc(control, method, route, value, authenticated = true) {
  return new Promise((yes, no) => {
    const req = request({ hostname: '127.0.0.1', port: control.port, method, path: route,
      headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer ' + control.token } : {}) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', data => body += data);
      res.on('end', () => yes({ status: res.statusCode, result: JSON.parse(body) }));
    });
    req.on('error', no); req.setTimeout(20000, () => req.destroy(new Error('Fixture RPC timeout')));
    req.end(value ? JSON.stringify(value) : undefined);
  });
}
let host = await start();
let previousBudget;
try {
  assert.equal((await rpc(host.control, 'GET', '/status', undefined, false)).status, 403);
  const id = randomUUID();
  const input = { sessionId, requestId: id, text: 'Offline channel fixture.' };
  const result = await rpc(host.control, 'POST', '/prompt', input);
  assert.equal(result.status, 200); assert.equal(result.result.state, 'completed');
  assert.equal(result.result.text, 'Offline integrated native Host acknowledged.');
  assert.equal(await readFile(resolve(workspace, 'audit.txt'), 'utf8'), 'after\n');
  assert.equal((await rpc(host.control, 'POST', '/prompt', input)).status, 409);
  const taskId=randomUUID();
  const taskInput={requestId:taskId,title:'Offline separate Persona task'};
  const created=await rpc(host.control,'POST','/tasks',taskInput);
  assert.equal(created.status,200);assert.equal(created.result.sessionId,taskId);
  assert.equal((await rpc(host.control,'POST','/tasks',taskInput)).result.existing,true);
  const catalog=await rpc(host.control,'GET','/tasks');
  assert.equal(catalog.result.tasks.length,2);
  assert.equal(catalog.result.tasks.find(task=>task.sessionId===taskId).title,taskInput.title);
  assert.equal((await rpc(host.control,'POST','/prompt',{sessionId:randomUUID(),requestId:randomUUID(),text:'Unauthorized Session must stay absent.'})).status,500);
  const second=await rpc(host.control,'POST','/prompt',{sessionId:taskId,requestId:randomUUID(),text:'Offline isolated task context.'});
  assert.equal(second.result.state,'completed');assert.equal(second.result.sessionId,taskId);
  const taskFiles=(await import('node:fs/promises')).readdir;
  const dirs=await taskFiles(resolve(root,'sessions'));
  const logs=[];
  for(const dir of dirs) for(const sid of [sessionId,taskId]) {
    try{logs.push({sid,text:await readFile(resolve(root,'sessions',dir,sid,'session.v4.jsonl'),'utf8')});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  assert.equal(logs.length,2);
  assert(!logs.find(x=>x.sid===sessionId).text.includes('Offline isolated task context.'));
  assert(!logs.find(x=>x.sid===taskId).text.includes('Offline channel fixture.'));
  const concurrent = await Promise.all([
    rpc(host.control,'POST','/prompt',{sessionId,requestId:randomUUID(),text:'Offline queued main message.'}),
    rpc(host.control,'POST','/prompt',{sessionId:taskId,requestId:randomUUID(),text:'Offline queued task message.'}),
  ]);
  assert(concurrent.every(r=>r.status===200&&r.result.state==='completed'),JSON.stringify(concurrent));
  assert.deepEqual(concurrent.map(r=>r.result.sessionId),[sessionId,taskId]);
  assert.equal((await rpc(host.control,'GET','/status')).result.busy,false);
  previousBudget = (await rpc(host.control,'GET','/status')).result.budget;
  await host.stop(); host = undefined;
  host = await start();
  const status = await rpc(host.control, 'GET', '/status');
  assert.equal(status.result.sessionId, sessionId);
  assert.equal(status.result.budget.settled, previousBudget.settled);
  assert.equal((await rpc(host.control,'GET','/tasks')).result.tasks.find(task=>task.sessionId===taskId).title,taskInput.title);
  const resumed = await rpc(host.control, 'POST', '/prompt', { sessionId, requestId: randomUUID(), text: 'Offline cold resume fixture.' });
  assert.equal(resumed.result.state, 'completed');
  assert.equal(resumed.result.budget.open_attempts, 0);
  assert(resumed.result.budget.settled > previousBudget.settled);
  const proof = { passed: true, root, observed_at: new Date().toISOString(), sessionId,
    authenticated_channel: true, repeated_prompt_rejected: true, cold_resume: true, ledger_preserved: true,
    concurrent_prompts_queued:true,multiple_native_tasks:true,task_title_persisted:true,task_logs_isolated:true,unknown_session_rejected:true,
    legacy_forward_slash_workspace_reused:true,
    before: previousBudget, after: resumed.result.budget, paid_model_calls: 0, formal_session_created: false };
  await writeFile(resolve(here, '../../reports/task_A/channel_validation.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, root, cold_resume: true, paid_model_calls: 0 }));
} finally { if (host) await host.stop(); }
