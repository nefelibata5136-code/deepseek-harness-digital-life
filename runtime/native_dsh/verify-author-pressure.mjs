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
import { mountMainRecovery } from './recovery/main.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runRoot = resolve(here, '../../reports/author-pressure/offline-' + randomUUID());
await mkdir(runRoot, { recursive: true });
const corePath = join(runRoot, 'fixture-core.md');
const CORE = '我是人格。这是独立测试常驻 Core，CORE_CONTINUITY_815AE896。对话、判断与行动要忠于证据。';
await writeFile(corePath, CORE + '\n', 'utf8');
const SIGNAL = new AbortController().signal;
const checks = [];
const allCalls = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const sourcePaths = [fileURLToPath(import.meta.url), join(here, 'persona-compaction.mjs'), join(here, 'self-compaction.mjs'), join(here, 'author-pressure.mjs'),
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



class PressureAdapter extends FixtureAdapter {
  enabled = false; action = 0; seen = [];
  async *stream(options) {
    if (!this.enabled) { yield* super.stream(options); return; }
    const text = plain(options.messages); this.seen.push({ purpose: options.purpose, maxTokens: options.maxTokens, text });
    const values = options.messages.filter(m => m.role === 'tool').flatMap(m => m.content).filter(b => b.type === 'text').map(b => { try { return JSON.parse(b.text); } catch { return null; } });
    const plan = values.findLast(v => v?.selfCompaction === 'prepared');
    let block;
    const phase = this.action++;
    if (phase === 0) block = { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'context_compact_prepare', arguments: JSON.stringify({ retain_ratio: 0.35 }) };
    else if (phase === 1 && plan) block = { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'context_compact_read', arguments: JSON.stringify({ plan_id: plan.planId, seq: plan.originalSeqs[0], limit_chars: 300 }) };
    else if (phase === 2 && plan) block = { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'context_compact_commit', arguments: JSON.stringify({ plan_id: plan.planId, checkpoint: '我是这个正常对话的书写者。DECISION_KEEP_LOCAL，PENDING_VERIFY_EXPORT尚未完成。 [seq:' + plan.originalSeqs[0] + ']' }) };
    else block = { type: 'text', text: '完成独立作者压力验收。' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
  }
}
const contexts = [];
try {
  for (const [label, window] of [['early-pressure', 30000], ['over-capacity-author-view', 10000], ['light-plus-capacity-view', 10000]]) {
    const adapter = new PressureAdapter();
    const f = await boot(label, { adapter, config: { authorPressure: { marginTokens: 512, viewBytes: 180000 } } }); contexts.push(f);
    const { agent } = await f.create();
    await seed(f.ctx, agent, 8, 14000);
    const original = await logOf(f.ctx, agent.session);
    if (label.startsWith('light')) {
      await writeFile(join(f.root, 'persona-core.md'), CORE); await writeFile(join(f.root, 'AGENTS.md'), '独立恢复fixture。');
      const recoveryRoot = join(f.root, 'recovery'); await mkdir(recoveryRoot);
      await writeFile(join(recoveryRoot, 'main-mode.json'), JSON.stringify({mode:'light'}));
      await mountMainRecovery(f.ctx, {root:recoveryRoot, workspace:f.root, primary:String(agent.id)});
    }
    adapter.contextWindow = window; adapter.enabled = true;
    await turn(f.ctx, agent, '继续原任务；本轮无需用户额外要求压缩。');
    const log = await logOf(f.ctx, agent.session);
    check(label + '_automatic_author_demand_persisted', log.some(e => e.type === 'user/message' && e.data.source?.kind === 'self-compaction-pressure'));
    check(label + '_normal_loop_uses_prepare_read_commit', ['context_compact_prepare','context_compact_read','context_compact_commit'].every(name => log.some(e => e.type === 'tool/call' && e.data.name === name)));
    const summary = log.findLast(e => e.type === 'compaction/summary');
    check(label + '_checkpoint_written_by_current_agent', summary?.data.provider === 'self-authored' && summary.data.summary[0].text.includes('DECISION_KEEP_LOCAL'));
    check(label + '_no_auxiliary_summary', adapter.seen.every(c => c.purpose !== 'compaction'));
    check(label + '_bounded_request_count_no_projection_recursion', adapter.seen.length === 4);
    check(label + '_original_history_unchanged', original.every((e,i) => JSON.stringify(e) === JSON.stringify(log[i])));
    if (window === 10000) check('over_capacity_uses_explicit_same_session_view', adapter.seen.some(c => c.purpose === 'self-author-capacity-view' && c.text.includes('没有看到全部旧历史')));
    const id = agent.session.id;
    await f.ctx.sessions.flush(agent.session);
    let manualDenied = false; try { await f.ctx.compaction.compactNow(agent, SIGNAL); } catch(e) { manualDenied = JSON.stringify(e.message + e.cause?.message).includes('SELF_COMPACT_AUTHOR_REQUIRED'); }
    check(label + '_manual_auxiliary_compact_cannot_bypass_authorship', manualDenied);
  }
  {
    const adapter = new PressureAdapter(); const f = await boot('too-small-even-for-author', {adapter,config:{authorPressure:{marginTokens:512}}}); contexts.push(f);
    const {agent} = await f.create(); adapter.contextWindow = 1000; adapter.enabled = true;
    agent.followup(user('独立fixture验证不足以载入核心与工具时须停在发请求之前。'));
    await agent.whenIdle(); await f.ctx.sessions.flush(agent.session);
    const log = await logOf(f.ctx,agent.session);
    check('irreducible_author_view_stops_before_transport', adapter.seen.length === 0 && log.findLast(e=>e.type==='turn/end')?.data.reason.kind === 'error');
    check('capacity_refusal_does_not_replace_history', !log.some(e=>e.type==='compaction/summary'));
  }
  const after = await sourceHashes(); check('source_hashes_unchanged', JSON.stringify(after) === JSON.stringify(sourceSha256));
  await writeFile(join(runRoot, 'validation.json'), JSON.stringify({ passed:true, checks, sourceSha256, source_hashes_unchanged:true, apiCalls:0, observedAt:new Date().toISOString() },null,2));
  console.log(JSON.stringify({ passed:true, checks:checks.length, report:join(runRoot,'validation.json') }));
} finally { for (const f of contexts) await f.dispose(); }
