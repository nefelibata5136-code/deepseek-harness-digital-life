// Read actual production JSONL and responses; never start a model or a child.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';
import { hostRequest, identity, projectEvents } from '../desktop_persona/index.mjs';
const base = resolve(import.meta.dirname, '../..');
const report = resolve(base, 'reports/subagents');
const sessionRoot = resolve(import.meta.dirname, 'home/sessions');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const textOf = message => (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
async function session(id) {
  for (const dir of await readdir(sessionRoot, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
    const path = resolve(sessionRoot, dir.name, id, 'session.v4.jsonl');
    let raw;
    try { raw = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const rows = raw.slice(0, raw.lastIndexOf('\n')).split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(rows[0].id, id);
    return { path, sha256: createHash('sha256').update(raw).digest('hex'), header: rows[0], events: rows.slice(1) };
  }
  throw new Error('Native session missing: ' + id);
}
const parentId = await identity();
const parent = await session(parentId);
const projection = projectEvents(parent.events);
const submissions = Object.fromEntries(await Promise.all(['deepseek', 'codex', 'question'].map(async mode =>
  [mode, await json(resolve(report, mode + '-submitted.json'))])));
const responses = Object.fromEntries(await Promise.all(['deepseek', 'codex', 'question'].map(async mode =>
  [mode, await json(resolve(report, mode + '-response.json'))])));
const range = mode => projection.rows.filter(row => row.seq >= submissions[mode].firstSeq
  && row.seq < (mode === 'deepseek' ? submissions.codex.firstSeq : mode === 'codex' ? submissions.question.firstSeq : Infinity));
const successfulCall = (rows, name) => rows.filter(row => row.role === 'tool' && row.text === name && row.status === 'completed');
const aRows = range('deepseek');
const starts = successfulCall(aRows, 'subagent');
assert.equal(starts.length, 1);
assert.equal(starts[0].args.run_in_background, true);
const childId = /started subagent ([a-f0-9-]{36})/.exec(starts[0].result)?.[1];
assert(childId);
const child = await session(childId);
assert.equal(child.header.parentSession, parentId);
assert.equal(child.header.origin, 'subagent');
const childOutputs = child.events.filter(e => e.type === 'assistant/message').map(e => textOf(e.data.message)).filter(Boolean);
assert(childOutputs.some(t => t.includes(submissions.deepseek.nonce) && t.includes('1786')));
assert(childOutputs.some(t => t.includes(submissions.deepseek.nonce) && t.includes('1805')));
assert.equal(child.events.filter(e => e.type === 'turn/end' && e.data.reason?.kind === 'completed').length, 2);
const continuation = successfulCall(aRows, 'send_message').find(row => row.args.agent_id === childId);
assert(continuation);
assert(!continuation.args.message.includes('1786') && !continuation.args.message.includes(submissions.deepseek.nonce));
const lists = successfulCall(aRows, 'list_agents');
assert(lists.some(row => row.result.includes(childId)));
const interruption = successfulCall(aRows, 'interrupt_agent').find(row => row.args.agent_id === childId);
assert(interruption);
assert(lists.some(row => row.seq > interruption.seq && row.result.includes(childId)));
const childHeader = child.events.filter(e => e.type === 'request/header').at(-1).data.header;
const parentHeader = parent.events.filter(e => e.type === 'request/header').at(-1).data.header;
assert.equal(childHeader.config.provider, parentHeader.config.provider);
assert.equal(childHeader.config.model, parentHeader.config.model);
const names = parentHeader.tools.map(t => t.name);
const requiredTools = ['subagent', 'send_message', 'list_agents', 'interrupt_agent', 'subagent_codex'];
for (const name of requiredTools) assert(names.includes(name));
const cRows = range('codex');
const codex = successfulCall(cRows, 'subagent_codex');
assert.equal(codex.length, 1);
assert(codex[0].result.includes(submissions.codex.nonce) && codex[0].result.includes('667'));
assert(responses.codex.value.text.includes(submissions.codex.nonce) && responses.codex.value.text.includes('667'));
const config = parse(await readFile(resolve(import.meta.dirname, 'home/profiles/persona/cordis.patch.yml'), 'utf8'));
assert.equal(config.find(row => row.id === 'subagent-codex').config.model, 'gpt-6-luna');
const require = createRequire(resolve(import.meta.dirname, 'node_modules/@deepseek-ai/dsh-subagent-codex/package.json'));
const codexRuntimeVersion = require('@openai/codex/package.json').version;
assert.equal(codexRuntimeVersion, '0.159.2');
const dRows = range('question');
const dStart = successfulCall(dRows, 'subagent')[0];
assert(dStart);
const dChildId = /started subagent ([a-f0-9-]{36})/.exec(dStart.result)?.[1];
assert(dChildId);
const dChild = await session(dChildId);
assert(dChild.events.some(e => e.type === 'assistant/message' && textOf(e.data.message).includes('238')));
assert(successfulCall(dRows, 'list_agents').some(row => row.result.includes(dChildId)));
assert(responses.question.value.text.includes('能') && responses.question.value.text.includes('238'));
const attempts = spawnSync('python', ['-X', 'utf8', '-c',
  'import sqlite3,pathlib,json,sys; c=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); c.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in c.execute("SELECT session_id,state,miss,hit,output,charged FROM attempts WHERE session_id IN (?,?)",sys.argv[2:])]))',
  resolve(base, 'runtime/budget_guard/control/budget.sqlite3'), childId, dChildId], { windowsHide: true, encoding: 'utf8' });
assert.equal(attempts.status, 0);
const budgetRows = JSON.parse(attempts.stdout);
assert(budgetRows.some(row => row.session_id === childId && row.state === 'settled'));
assert(budgetRows.some(row => row.session_id === dChildId && row.state === 'settled'));
const core = createHash('sha256').update(await readFile('.local/workspace/persona-core.md')).digest('hex');
assert.equal(core, 'beaf1f1028235dd4b9d88874c3a6d52ee661737784fc41f8c4e61a2d2c71d343');
const evidenceRows = projection.rows.filter(row => row.seq >= submissions.deepseek.firstSeq);
assert(!evidenceRows.some(row => row.role === 'tool' && ['task_create', 'write', 'edit', 'terminal'].includes(row.text)));
for (const s of [child, dChild]) assert(!s.events.some(e => e.type === 'tool/call' && ['write', 'edit', 'terminal'].includes(e.data.name)));
const live = await hostRequest('GET', '/status');
assert.equal(live.status, 200);
assert(live.value.ready && !live.value.busy);
assert(!projection.running);
const result = { passed: true, observedAt: new Date().toISOString(), parentId, liveHostPid: live.value.pid,
  modelVisibleTools: requiredTools, persistedModelEnvelopeSeq: parent.events.filter(e => e.type === 'request/header').at(-1).seq,
  deepseek: { passed: true, childId, route: childHeader.config, output: childOutputs, completedTurns: 2,
    continuationCallSeq: continuation.seq, interruptCallSeq: interruption.seq, interruptWasInactive: true },
  codex: { passed: true, provider: '@deepseek-ai/dsh-subagent-codex@0.2.0-rc.2', model: 'gpt-6-luna',
    codexRuntimeVersion, oneShot: true, toolCallSeq: codex[0].seq, toolResultSeq: codex[0].resultSeq, output: codex[0].result },
  question: { passed: true, childId: dChildId, result: '238', reply: responses.question.value.text },
  budgetChildAttribution: budgetRows, coreSha256Unchanged: core,
  parentNativeLog: { path: parent.path, sha256: parent.sha256 },
  childNativeLogs: [child, dChild].map(s => ({ path: s.path, sha256: s.sha256 })),
  noTaskCreateOrFileMutationCallsInAcceptance: true,
  limitations: ['interrupt exercised on inactive child, not an in-flight generation',
    'Codex one-shot has no send_message/list_agents control; foreground cancellation belongs to parent call',
    'Codex quota is outside the DeepSeek budget ledger'] };
await writeFile(resolve(report, 'acceptance.json'), JSON.stringify(result, null, 2));
await writeFile(resolve(report, 'timeline.json'), JSON.stringify(evidenceRows, null, 2));
console.log(JSON.stringify({ passed: true, parentId, childId, codexOutput: codex[0].result,
  finalSelfTest: '238', tools: requiredTools, liveHostPid: live.value.pid, evidence: resolve(report, 'acceptance.json') }));
