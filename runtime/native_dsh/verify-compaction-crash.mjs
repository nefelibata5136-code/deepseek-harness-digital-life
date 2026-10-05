// Process-level, keyless native compaction crash recovery in a dedicated test root.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import { PersonaCompactionEngine } from './persona-compaction.mjs';

const sourceFile = fileURLToPath(import.meta.url);
const here = dirname(sourceFile);
const CORE = '我是人格。CRASH_FIXTURE_CORE_815AE896。保留决定与未完成事项，忠于当前 Session 原文。';
const hash = value => createHash('sha256').update(value).digest('hex');
const eventHash = event => hash(JSON.stringify(event));
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const nativePackages = ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt',
  'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-token-meter', 'dsh-session-persistence-jsonl',
  'dsh-session-persistence', 'dsh-session-query', 'dsh-session-query-sqlite', 'dsh-compaction-basic', 'dsh-compaction'];
const boundFiles = [sourceFile, join(here, 'persona-compaction.mjs'),
  ...nativePackages.map(name => fileURLToPath(import.meta.resolve('@deepseek-ai/' + name)))];
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(boundFiles.map(async path => [path, hash(await readFile(path))])));
}
function timed(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
async function events(ctx, id) {
  const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' });
  try { return [...observation.events]; }
  finally { observation[Symbol.dispose](); }
}

class IsolatedAdapter extends LlmAdapter {
  onSummary;
  modelCalls = 0;
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 100_000 }, defaultMaxTokens: 256,
      reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } };
  }
  async *stream(options) {
    this.modelCalls += 1;
    if (options.purpose === 'compaction' && this.onSummary) await this.onSummary();
    const evidence = options.messages.flatMap(message => message.content ?? [])
      .filter(block => block.type === 'text').map(block => block.text).join('\n');
    const seqs = [...new Set([...evidence.matchAll(/\[seq:(\d+)\]/g)].map(match => Number(match[1])))];
    const text = options.purpose === 'compaction'
      ? '我仍保持本地决定，校验未完成。' + seqs.slice(0, 10).map(seq => ' [seq:' + seq + ']').join('')
      : '独立崩溃测试确认：本地决定保持，校验未完成。';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function boot(root) {
  const ctx = new Context();
  const adapter = new IsolatedAdapter();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, {});
    ctx.systemPrompt.section({ name: 'crash-fixture:core', order: 0, text: CORE, complete: true });
    await ctx.plugin(ToolRuntime, {});
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(SqliteSessionQuery, { path: join(root, 'query.sqlite'), openAt: 'first-search' });
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(TokenMeter);
    ctx.llm.registerAdapter(['crash-fixture'], adapter);
    await ctx.plugin(PersonaCompactionEngine, { cacheRoot: join(root, 'capsules'), maxReplayTokens: 6000,
      capsuleMaxTokens: 512, maxCapsuleTokens: 20_000, summaryMaxTokens: 1024,
      policy: { auto: false, headroomTokens: 4096, retainTokens: 512,
        summarizationProvider: 'crash-fixture', summarizationModel: 'fixture-flash', maxTokens: 1024 } });
    return { ctx, adapter };
  } catch (error) { await timed(ctx.fiber.dispose(), 10_000, 'failed boot disposal'); throw error; }
}
async function turn(ctx, agent, text) {
  let remove;
  const idle = new Promise(accept => {
    remove = ctx.on('agent/status', payload => {
      if (payload.agent.id === agent.id && payload.status === 'idle') accept();
    });
  });
  try { agent.followup(user(text)); await timed(idle, 15_000, 'real native turn'); }
  finally { remove?.(); }
  await timed(ctx.sessions.flush(agent.session), 10_000, 'turn persistence flush');
  const end = (await events(ctx, agent.id)).findLast(event => event.type === 'turn/end');
  assert.equal(end?.data.reason.kind, 'completed');
}

async function worker(root, identity) {
  // A watchdog keeps the deliberately pending summarizer alive until the parent kills this exact worker.
  const watchdog = setTimeout(() => process.exit(92), 40_000);
  const sourceSha256 = await sourceHashes();
  const { ctx, adapter } = await boot(root);
  const handle = await ctx.agents.create({ sessionId: SessionId(identity), meta: { cwd: root },
    agentOptions: { provider: 'crash-fixture', model: 'fixture-flash', maxTokens: 256 } });
  for (let index = 0; index < 3; index += 1) await turn(ctx, handle.agent,
    `原始决定 KEEP_LOCAL，未完成 VERIFY_EXPORT，真实发生于独立测试轮次 ${index}。\n` +
    'low value original debugging history '.repeat(240) + '\nEXACT_ORIGINAL_END_' + index);
  const original = await events(ctx, handle.agent.id);
  adapter.onSummary = async () => {
    await timed(ctx.sessions.flush(handle.agent.session), 10_000, 'compaction start durability barrier');
    const observed = await events(ctx, handle.agent.id);
    const start = observed.findLast(event => event.type === 'compaction/start');
    assert.ok(start && start.data.turn === null);
    process.stdout.write(JSON.stringify({ kind: 'READY', pid: process.pid, identity, startSeq: start.seq,
      originalEventCount: original.length, originalEventHashes: original.map(eventHash),
      durablePrefixHashes: observed.map(eventHash), sourceSha256 }) + '\n');
    await new Promise(() => {});
  };
  // This promise must never settle normally. No graceful close is permitted on the tested path.
  await ctx.compaction.compactNow(handle.agent, new AbortController().signal);
  clearTimeout(watchdog);
  throw new Error('Crash worker unexpectedly completed compaction');
}

if (process.argv[2] === '--worker') {
  await worker(resolve(process.argv[3]), process.argv[4]);
} else {
  const runRoot = resolve(here, '../../reports/compaction/crash-' + randomUUID());
  await mkdir(runRoot, { recursive: true });
  const sourceSha256 = await sourceHashes();
  const identity = randomUUID();
  const checks = [];
  let child;
  let exited;
  let ctx;
  let ready;
  const check = (name, passed, detail = {}) => {
    assert.ok(passed, name); checks.push({ name, passed: true, ...detail }); console.log('PASS ' + name);
  };
  try {
    child = spawn(process.execPath, [sourceFile, '--worker', runRoot, identity],
      { cwd: here, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => accept({ code, signal }));
    });
    let buffer = '', stderr = '';
    const readiness = new Promise((accept, reject) => {
      child.stdout.on('data', data => {
        buffer += data.toString();
        if (buffer.length > 1_000_000) { reject(new Error('Worker readiness exceeded explicit byte bound')); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (line.startsWith('{')) { const message = JSON.parse(line); if (message.kind === 'READY') accept(message); }
        }
      });
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-16000); });
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Worker exited before READY: ${code}/${signal}; ${stderr}`)));
    });
    ready = await timed(readiness, 30_000, 'durable compaction start readiness');
    check('only_spawned_fixture_worker_is_targeted', ready.pid === child.pid && ready.identity === identity);
    check('worker_tested_identical_source_bytes', JSON.stringify(ready.sourceSha256) === JSON.stringify(sourceSha256));
    check('worker_reached_durable_manual_compaction_start', ready.startSeq >= ready.originalEventCount);
    // child refers solely to the process spawned above; no process lookup or broad process termination occurs.
    check('specific_worker_was_forcibly_terminated', child.kill('SIGKILL'));
    const exit = await timed(exited, 10_000, 'forced worker exit');
    check('worker_exit_was_abnormal', exit.code !== 0 || exit.signal !== null, exit);

    const opened = await timed(boot(runRoot), 15_000, 'recovery context boot');
    ctx = opened.ctx;
    const persisted = (await timed(ctx.sessionQuery.readSession(SessionId(identity)), 10_000, 'cold crashed log read')).events;
    check('crash_preserved_exact_durable_event_prefix', ready.durablePrefixHashes.every((item, index) => eventHash(persisted[index]) === item));
    check('crashed_log_has_orphan_start_without_fabricated_summary_or_close',
      persisted[ready.startSeq]?.type === 'compaction/start' &&
      !persisted.some(event => ['compaction/summary', 'compaction/end'].includes(event.type)));
    const resumed = await timed(ctx.agents.resume({ resumeSessionId: SessionId(identity),
      agentOptions: { provider: 'crash-fixture', model: 'fixture-flash', maxTokens: 256 } }), 15_000, 'native crashed Session resume');
    const recovered = await events(ctx, resumed.agent.id);
    check('resume_retains_unchanged_original_history', ready.originalEventHashes.every((item, index) => eventHash(recovered[index]) === item));
    check('resume_adds_new_lifecycle_boundary_after_orphan', recovered.some(event => event.type === 'session/end-seed' && event.seq > ready.startSeq));
    check('resume_does_not_invent_successful_compaction', !recovered.some(event => ['compaction/summary', 'compaction/end'].includes(event.type)));
    await turn(ctx, resumed.agent, '异常退出后继续，KEEP_LOCAL仍有效，VERIFY_EXPORT仍未完成。' + 'fresh recovery evidence '.repeat(220));
    check('native_session_continues_after_abnormal_process_exit', resumed.agent.status === 'idle');
    const compacted = await timed(ctx.compaction.compactNow(resumed.agent, new AbortController().signal), 15_000, 'post-crash compaction');
    check('new_compaction_commits_despite_previous_lifecycle_orphan', compacted !== null);
    const finalLog = await events(ctx, resumed.agent.id);
    const finalSummary = compacted.summary.map(block => block.text ?? '').join('\n');
    const citations = [...finalSummary.matchAll(/\[seq:(\d+)\]/g)].map(match => Number(match[1]));
    check('post_crash_summary_cites_original_events', citations.length > 0 && citations.every(seq =>
      finalLog[seq] && ['user/message', 'assistant/message', 'tool/result', 'developer/message'].includes(finalLog[seq].type)));
    check('orphan_remains_auditable_and_original_history_remains_exact', finalLog[ready.startSeq].type === 'compaction/start' &&
      ready.originalEventHashes.every((item, index) => eventHash(finalLog[index]) === item));
    const sourceSha256End = await sourceHashes();
    check('tested_source_bytes_unchanged_from_start_to_finish', JSON.stringify(sourceSha256End) === JSON.stringify(sourceSha256));
    await writeFile(join(runRoot, 'validation.json'), JSON.stringify({ passed: true, observed_at: new Date().toISOString(),
      test_root: runRoot, real_api_called: false, process_abnormal_exit_verified: true,
      sourceSha256, sourceSha256End, source_hashes_unchanged: true, sessionId: identity,
      workerPid: ready.pid, orphanStartSeq: ready.startSeq, originalEventCount: ready.originalEventCount,
      recoveredSummarySeq: compacted.summarySeq, mockRecoveryModelCalls: opened.adapter.modelCalls, checks }, null, 2) + '\n');
    console.log(JSON.stringify({ passed: true, checks: checks.length, report: join(runRoot, 'validation.json') }));
  } catch (error) {
    await writeFile(join(runRoot, 'validation.json'), JSON.stringify({ passed: false, observed_at: new Date().toISOString(),
      real_api_called: false, checks, sourceSha256, sourceSha256End: await sourceHashes(),
      error: String(error.stack ?? error) }, null, 2) + '\n');
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await timed(exited, 10_000, 'final worker cleanup').catch(() => {});
    }
    if (ctx) await timed(ctx.fiber.dispose(), 10_000, 'recovery context disposal');
  }
}
