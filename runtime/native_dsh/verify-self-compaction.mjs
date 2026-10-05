// Isolated installed-Harness integration checks. No credentials or real API calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, LlmError, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import { PersonaCompactionEngine, apply as applyPersona, inject as personaInject } from './persona-compaction.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runRoot = resolve(here, '../../reports/self-compaction/offline-' + randomUUID());
await mkdir(runRoot, { recursive: true });
const corePath = join(runRoot, 'fixture-core.md');
const CORE = '我是人格。这是独立测试常驻 Core，CORE_CONTINUITY_815AE896。对话、判断与行动要忠于证据。';
await writeFile(corePath, CORE + '\n', 'utf8');
const SIGNAL = new AbortController().signal;
const checks = [];
const allCalls = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const sourcePaths = [fileURLToPath(import.meta.url), join(here, 'persona-compaction.mjs'), join(here, 'self-compaction.mjs'), join(here, 'author-pressure.mjs'), join(here, 'digital-life/state-board.mjs'),
  join(here, 'recovery/main.mjs'), join(here, 'recovery/diagnostics.mjs'), join(here, '../budget_guard/provider_gate.mjs'), join(here, 'digital-life/state-board.mjs'),
  join(here, 'node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js')];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
  [path, sha(await readFile(path))])));
const sourceSha256 = await sourceHashes();
const plain = messages => messages.flatMap(message => message.content ?? [])
  .filter(block => block.type === 'text').map(block => block.text).join('\n');
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

function check(name, condition, detail = {}) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, ...detail });
  console.log('PASS ' + name);
}

class FixtureAdapter extends LlmAdapter {
  calls = [];
  failSummary = false;
  truncateSummary = false;
  overflowOnce = false;
  requestTool = false;
  checkpointMarker = '';
  noCapsuleRefs = false;
  invalidCheckpointRefs = false;
  summaryOverride = null;
  callIndex = 0;
  contextWindow = 100_000;
  async resolveModel(provider, model) {
    return { provider, id: model, name: model,
      context: { contextWindow: this.contextWindow }, defaultMaxTokens: 256,
      reasoning: { efforts: [{ id: 'none', name: 'None' }, { id: 'off', name: 'Off' }], defaultEffort: 'off' } };
  }
  async *stream(options) {
    const text = (options.system ?? '') + '\n' + plain(options.messages);
    const call = { purpose: options.purpose ?? 'agent', text,
      provider: options.provider, model: options.model, maxTokens: options.maxTokens };
    this.calls.push(call);
    allCalls.push(call);
    if (options.purpose === 'compaction') {
      if (this.failSummary) throw new LlmError('isolated summary fixture refused', 'FIXTURE_FAILURE');
      const seqs = [...new Set([...text.matchAll(/(?:\[seq:|\bseq[:= ]+)(\d+)/g)].map(match => Number(match[1])))];
      // This is deliberately deterministic; it tests orchestration and provenance, not model quality.
      let summary = '我是人格，决定保持原文可查，长期事项仍未结束。' +
        seqs.slice(0, 10).map(seq => ` [seq:${seq}]`).join('') +
        (text.includes('DECISION_KEEP_LOCAL') ? ' DECISION_KEEP_LOCAL' : '') +
        (text.includes('PENDING_VERIFY_EXPORT') ? ' PENDING_VERIFY_EXPORT' : '') +
        (text.includes('历史材料（checkpoint）') ? this.checkpointMarker : '');
      if (this.noCapsuleRefs && text.includes('历史材料（capsule）')) summary = summary.replace(/\s*\[seq:\d+\]/g, '');
      if (this.invalidCheckpointRefs && text.includes('历史材料（checkpoint）')) summary += ' [seq:999999]';
      if (this.summaryOverride !== null) summary = this.summaryOverride;
      call.responseText = summary;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      yield { type: 'finish', reason: { kind: this.truncateSummary ? 'max-tokens' : 'stop' } };
      return;
    }
    if (this.overflowOnce) {
      this.overflowOnce = false;
      throw new LlmError('isolated canonical context overflow', 'CONTEXT_WINDOW_EXCEEDED');
    }
    if (this.requestTool) {
      const name = typeof this.requestTool === 'string' ? this.requestTool : 'fixture_read';
      this.requestTool = false;
      const block = { type: 'tool-call', id: ToolCallId('fixture-read-' + (++this.callIndex)), name, arguments: JSON.stringify(this.requestArguments ?? {}) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture acknowledgement ' + (++this.callIndex) } };
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else found.push(path);
  }
  return found;
}

async function boot(label, { auto = false, config = {}, adapter = new FixtureAdapter() } = {}) {
  const root = join(runRoot, label);
  await mkdir(root, { recursive: true });
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, {});
    ctx.systemPrompt.section({ name: 'fixture:core', order: 0, text: CORE, complete: true });
    await ctx.plugin(ToolRuntime, {});
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(SqliteSessionQuery, { path: join(root, 'query.sqlite'), openAt: 'first-search' });
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(TokenMeter);
    ctx.llm.registerAdapter(['fixture'], adapter);
    ctx.tools.register(defineTool({ name: 'fixture_read', description: 'Read an isolated long fixture.',
      parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'FILE_OPERATION_OK\n' + 'unimportant tool output\n'.repeat(400) + 'END_OF_TOOL_ORIGINAL'; } }));
    await ctx.plugin({ name: 'fixture-persona-compaction', inject: personaInject, apply: applyPersona }, {
      corePath, cacheRoot: join(root, 'capsules'), maxReplayTokens: 6000,
      capsuleMaxTokens: 512, maxCapsuleTokens: 20_000, summaryMaxTokens: 1024,
      policy: { auto, thresholdRatio: 0.8, headroomTokens: 4096, retainTokens: 512,
        summarizationProvider: 'fixture', summarizationModel: 'fixture-flash', maxTokens: 1024,
        compactionRetries: 1, maxOverflowRetries: 1 }, ...config,
    });
    return { ctx, root, adapter,
      async create() {
        return ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: root },
          agentOptions: { provider: 'fixture', model: 'fixture-flash', maxTokens: 256 } });
      },
      async dispose() { await ctx.fiber.dispose(); },
    };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

async function logOf(ctx, session) {
  const observation = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' });
  try { return [...observation.events]; }
  finally { observation[Symbol.dispose](); }
}

async function turn(ctx, agent, text) {
  // Register before waking: the real loop can reach idle synchronously after its final await.
  let remove;
  let timer;
  const idle = new Promise((accept, reject) => {
    timer = setTimeout(() => reject(new Error('fixture loop did not settle within 20 seconds')), 20_000);
    remove = ctx.on('agent/status', payload => {
      if (payload.agent.id === agent.id && payload.status === 'idle') accept();
    });
  });
  try { agent.followup(user(text)); await idle; }
  finally { clearTimeout(timer); remove?.(); }
  await ctx.sessions.flush(agent.session);
  const events = await logOf(ctx, agent.session);
  const end = events.findLast(event => event.type === 'turn/end');
  assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end?.data));
}

async function seed(ctx, agent, count = 3, chars = 9000) {
  for (let n = 0; n < count; n += 1) {
    await turn(ctx, agent, `普通聊天；长期任务，DECISION_KEEP_LOCAL；PENDING_VERIFY_EXPORT；失败尝试已经撤销。轮次 ${n}。\n` +
      'mechanical low value debugging material '.repeat(Math.ceil(chars / 38)) + `\nRAW_END_${n}`);
  }
}


const contexts = [];
const value = e => { try { return JSON.parse(e.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')); } catch { return null; } };
const callTool = async (fixture, agent, name, args = {}) => {
  fixture.adapter.requestTool = name; fixture.adapter.requestArguments = args;
  await turn(fixture.ctx, agent, 'Execute isolated tool acceptance: ' + name);
  const events = await logOf(fixture.ctx, agent.session);
  return { events, result: events.filter(e => e.type === 'tool/result').at(-1) };
};
try {
  const f = await boot('self-author'); contexts.push(f);
  const { agent } = await f.create();
  await seed(f.ctx, agent, 4, 12000);
  const prepared = await callTool(f, agent, 'context_compact_prepare', { retain_ratio: 0.35 });
  const plan = value(prepared.result);
  check('prepare_registered_and_exact_range', plan?.selfCompaction === 'prepared' && plan.originalSeqs.length > 2);
  check('author_controls_retention_ratio', plan.retainRatio === 0.35);
  const sourceBytes = plan.originalSeqs.map(seq => JSON.stringify(agent.session.eventAt(seq)));
  const checkpoint = '我是当前对话的书写者。保留 DECISION_KEEP_LOCAL；PENDING_VERIFY_EXPORT 仍待验证。\n原文可查。 [seq:' + plan.originalSeqs[0] + ']';
  const auxiliaryBefore = f.adapter.calls.filter(c => c.purpose === 'compaction').length;
  const bad = await callTool(f, agent, 'context_compact_commit', { plan_id: plan.planId, checkpoint: checkpoint + ' [seq:99999999]' });
  check('out_of_range_reference_rejected', bad.result.data.message.isError === true);
  check('invalid_commit_preserves_surface', plan.selectedSeqs.every(seq => agent.session.surface.nodes.includes(seq)));
  const empty = await callTool(f, agent, 'context_compact_commit', { plan_id: plan.planId, checkpoint: '' });
  check('empty_checkpoint_rejected', empty.result.data.message.isError === true);
  const large = await callTool(f, agent, 'context_compact_commit', { plan_id: plan.planId, checkpoint: 'x'.repeat(100001) });
  check('oversized_checkpoint_rejected', large.result.data.message.isError === true);
  const queued = await callTool(f, agent, 'context_compact_commit', { plan_id: plan.planId, checkpoint });
  const summary = queued.events.findLast(e => e.type === 'compaction/summary');
  check('native_summary_body_byte_exact', summary?.data.summary[0].text === checkpoint);
  const landed = agent.session.surface.nodes.map(seq => agent.session.eventAt(seq)).find(e => e.type === 'user/message' && e.data.source.kind === 'compact-checkpoint');
  check('landed_surface_body_byte_exact_without_system_rewrite', landed?.data.content[0].text === checkpoint);
  check('selected_sources_replaced', plan.selectedSeqs.every(seq => !agent.session.surface.nodes.includes(seq)));
  check('recent_tail_preserved', plan.retainedSeqs.every(seq => agent.session.surface.nodes.includes(seq)));
  check('original_events_retained_byte_exact', sourceBytes.every((s, i) => s === JSON.stringify(agent.session.eventAt(plan.originalSeqs[i]))));
  check('no_auxiliary_summary_model_call', f.adapter.calls.filter(c => c.purpose === 'compaction').length === auxiliaryBefore);
  check('next_normal_request_uses_authored_checkpoint', f.adapter.calls.at(-1).text.includes(checkpoint));
  const status = await callTool(f, agent, 'context_compact_status', { plan_id: plan.planId });
  check('status_confirms_committed', value(status.result)?.committed === true);
  const repeat = await callTool(f, agent, 'context_compact_commit', { plan_id: plan.planId, checkpoint });
  check('duplicate_commit_rejected', repeat.result.data.message.isError === true);
  await seed(f.ctx, agent, 2, 12000);
  const p2 = value((await callTool(f, agent, 'context_compact_prepare')).result);
  const originalSummarize = f.ctx.compaction.summarize;
  f.ctx.compaction.summarize = async () => ({ summary: [{ type: 'text', text: '独立范围替换fixture。' }], provider: 'fixture', model: 'fixture' });
  await f.ctx.compaction.compactNow(agent, SIGNAL);
  f.ctx.compaction.summarize = originalSummarize;
  const changed = await callTool(f, agent, 'context_compact_commit', { plan_id: p2.planId, checkpoint });
  check('changed_surface_generation_rejected', changed.result.data.message.isError === true);
  await seed(f.ctx, agent, 2, 12000);
  const p3 = value((await callTool(f, agent, 'context_compact_prepare')).result);
  await callTool(f, agent, 'context_compact_status', { plan_id: p3.planId, cancel: true });
  const cancelled = await callTool(f, agent, 'context_compact_commit', { plan_id: p3.planId, checkpoint });
  check('cancelled_plan_rejected', cancelled.result.data.message.isError === true);
  const p4 = value((await callTool(f, agent, 'context_compact_prepare')).result);
  const beforeRestart = [...agent.session.surface.nodes];
  await f.ctx.sessions.flush(agent.session);
  const nativeFiles = await files(join(f.root, 'sessions'));
  check('durable_native_session_files_exist', nativeFiles.length > 0);
  const id = agent.session.id;
  await f.dispose(); contexts.splice(contexts.indexOf(f), 1);
  const restart = await boot('self-author'); contexts.push(restart);
  const resumed = await restart.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'fixture-flash', maxTokens: 256 } });
  check('restart_restores_authored_checkpoint_and_surface', JSON.stringify(resumed.agent.session.surface.nodes) === JSON.stringify(beforeRestart));
  const restoredStatus = await callTool(restart, resumed.agent, 'context_compact_status', { plan_id: p4.planId });
  check('prepared_transaction_survives_restart', value(restoredStatus.result)?.status === 'prepared');
  const resumedBody = '重启后由当前对话继续亲手书写。 [seq:' + p4.originalSeqs[0] + ']';
  const restoredCommit = await callTool(restart, resumed.agent, 'context_compact_commit', { plan_id: p4.planId, checkpoint: resumedBody });
  check('prepared_before_restart_commits_after_restart', restoredCommit.events.findLast(e => e.type === 'compaction/summary')?.data.summary[0].text === resumedBody);
  check('restart_commit_has_no_auxiliary_model_call', restart.adapter.calls.every(c => c.purpose !== 'compaction'));
  const flush = restart.ctx.sessions.flush;
  restart.ctx.sessions.flush = async () => { throw new Error('FIXTURE_DURABILITY_FAILURE'); };
  const failedDurability = await restart.ctx.tools.execute({ name: 'context_compact_status', arguments: { plan_id: p4.planId },
    callId: ToolCallId('status-durability-failure'), agent: resumed.agent, signal: SIGNAL });
  restart.ctx.sessions.flush = flush;
  check('status_never_attests_success_after_flush_failure', failedDurability.isError === true);
  for (const stage of ['before-start', 'before-summary', 'before-replace', 'before-end']) {
    const label = 'interrupted-' + stage;
    const crash = await boot(label); contexts.push(crash);
    const crashHandle = await crash.create(); const owner = crashHandle.agent;
    await seed(crash.ctx, owner, 3, 12000);
    const plan = value((await callTool(crash, owner, 'context_compact_prepare')).result);
    const body = '独立中断恢复检查点，待办未完成。 [seq:' + plan.originalSeqs[0] + ']';
    const append = owner.session.append;
    owner.session.append = function(type, data, options) {
      if (type === 'compaction/end' ||
          (stage === 'before-start' && type === 'compaction/start') ||
          (stage === 'before-summary' && type === 'compaction/summary') ||
          (stage === 'before-replace' && type === 'user/message' && options?.surfaceOp?.op === 'replace'))
        throw new Error('SIMULATED_PROCESS_INTERRUPTION_' + stage);
      return append.call(this, type, data, options);
    };
    try { await callTool(crash, owner, 'context_compact_commit', { plan_id: plan.planId, checkpoint: body }); }
    catch { /* Native failed turn is expected; preserve the actual durable partial transaction. */ }
    owner.session.append = append;
    const identity = owner.session.id;
    await crash.ctx.sessions.flush(owner.session); await crashHandle.dispose(); await crash.dispose();
    contexts.splice(contexts.indexOf(crash), 1);
    // Replay the durable prefix that an abrupt exit would leave. Keep the complete
    // synthetic failure log beside it; no production Session is rewritten.
    const rawPath = (await files(join(crash.root, 'sessions'))).find(p => p.endsWith('session.v4.jsonl'));
    const bytes = await readFile(rawPath, 'utf8');
    await writeFile(rawPath + '.fault-fixture-original', bytes);
    const lines = bytes.trimEnd().split('\n');
    const cutType = { 'before-start': 'step/end', 'before-summary': 'compaction/start', 'before-replace': 'compaction/summary', 'before-end': 'user/message' }[stage];
    const cut = lines.findLastIndex(line => { const e = JSON.parse(line); return e.type === cutType &&
      (cutType !== 'user/message' || e.data.source?.compactionId === plan.planId); });
    await writeFile(rawPath, lines.slice(0, cut + 1).join('\n') + '\n');
    const recovered = await boot(label); contexts.push(recovered);
    const handle = await recovered.ctx.agents.resume({ resumeSessionId: identity, agentOptions: { provider: 'fixture', model: 'fixture-flash', maxTokens: 256 } });
    await turn(recovered.ctx, handle.agent, '继续独立中断恢复验收。');
    const events = await logOf(recovered.ctx, handle.agent.session);
    check(stage + '_recovered_durable_commit', events.some(e => e.type === 'compaction/end' && e.data.compactionId === plan.planId && !e.data.error));
    const replacements = events.filter(e => e.type === 'user/message' && e.data.source?.compactionId === plan.planId);
    check(stage + '_exactly_one_replacement', replacements.length === 1 && replacements[0].data.content[0].text === body);
    check(stage + '_no_auxiliary_model', recovered.adapter.calls.every(c => c.purpose !== 'compaction'));
  }
  const afterHashes = await sourceHashes();
  check('source_hashes_unchanged', JSON.stringify(afterHashes) === JSON.stringify(sourceSha256));
  await writeFile(join(runRoot, 'validation.json'), JSON.stringify({ passed: true, checks, sourceSha256, source_hashes_unchanged: true, apiCalls: 0, sessionId: agent.session.id, observedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: join(runRoot, 'validation.json') }));
} finally { for (const f of contexts) await f.dispose(); }
