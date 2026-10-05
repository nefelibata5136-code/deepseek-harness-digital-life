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
const runRoot = resolve(here, '../../reports/compaction/offline-' + randomUUID());
await mkdir(runRoot, { recursive: true });
const corePath = join(runRoot, 'fixture-core.md');
const CORE = '我是人格。这是独立测试常驻 Core，CORE_CONTINUITY_815AE896。对话、判断与行动要忠于证据。';
await writeFile(corePath, CORE + '\n', 'utf8');
const SIGNAL = new AbortController().signal;
const checks = [];
const allCalls = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const sourcePaths = [fileURLToPath(import.meta.url), join(here, 'persona-compaction.mjs'),
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
      const block = { type: 'tool-call', id: ToolCallId('fixture-read-' + (++this.callIndex)), name, arguments: '{}' };
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
      mode: 'legacy', corePath, cacheRoot: join(root, 'capsules'), maxReplayTokens: 6000,
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
try {
  const manual = await boot('manual'); contexts.push(manual);
  const handle = await manual.create();
  const agent = handle.agent;
  await seed(manual.ctx, agent);
  manual.adapter.requestTool = true;
  await turn(manual.ctx, agent, '请读取文件，只是独立fixture，无真实文件操作。');
  const original = await logOf(manual.ctx, agent.session);
  const originalBytes = original.map(event => JSON.stringify(event));
  const before = manual.ctx.tokenMeter.measure(agent.session).totalTokens;
  manual.adapter.checkpointMarker = ' PRIOR_FINAL_PROSE_POISON_815AE896';
  const result = await manual.ctx.compaction.compactNow(agent, SIGNAL);
  check('manual_native_transaction_commits', result !== null);
  const afterLog = await logOf(manual.ctx, agent.session);
  check('all_original_events_survive_unchanged', originalBytes.every((line, seq) => JSON.stringify(afterLog[seq]) === line));
  check('manual_reduces_model_context', manual.ctx.tokenMeter.measure(agent.session).totalTokens < before);
  const checkpoints = afterLog.filter(event => event.type === 'compaction/summary');
  check('native_summary_records_model_source_and_time', checkpoints.length === 1 && checkpoints[0].time > 0 &&
    checkpoints[0].data.provider === 'fixture' && checkpoints[0].data.model === 'fixture-flash');
  const replacement = afterLog[checkpoints[0].seq + 1];
  check('native_replacement_preserves_source_graph', replacement.type === 'user/message' &&
    checkpoints[0].data.shadowedSeqs.every(seq => replacement.sourceEventSeqs.includes(seq)));
  check('summary_uses_normal_core', manual.adapter.calls.filter(call => call.purpose === 'compaction')
    .every(call => call.text.includes('CORE_CONTINUITY_815AE896')));
  check('summary_contains_source_references', /\[seq:\d+\]/.test(plain([{ content: result.summary }])));
  const toolResult = afterLog.find(event => event.type === 'tool/result' && plain([event.data.message]).includes('END_OF_TOOL_ORIGINAL'));
  check('tool_result_original_is_complete', toolResult !== undefined);
  const oldSurface = agent.session.surface.nodes.filter(seq => agent.session.eventAt(seq).type !== 'system/message');
  const partialStart = oldSurface[0], partialEnd = oldSurface.at(-1);
  assert.ok(partialStart > partialEnd, 'fixture must contain a real nonnumeric surface span');
  let positionalResult;
  const removePositional = manual.ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent.id === agent.id && !positionalResult) {
      positionalResult = await manual.ctx.compaction.compactRegion(partialStart, partialEnd, agent, payload.signal);
    }
    return next();
  });
  await turn(manual.ctx, agent, '压缩以后继续执行，保持长期任务与决定。' + 'fresh material '.repeat(450));
  removePositional();
  check('real_nonnumeric_surface_span_compacts_by_position', positionalResult !== undefined &&
    positionalResult.shadowedRange.start > positionalResult.shadowedRange.end);
  const positionalLogs = await logOf(manual.ctx, agent.session);
  const manifestMatch = plain([{ content: positionalResult.summary }]).match(/<persona-source-manifest>(.*?)<\/persona-source-manifest>/s);
  assert.ok(manifestMatch, 'expected source manifest');
  const positionalManifest = JSON.parse(manifestMatch[1]);
  check('nonnumeric_repeated_range_rebases_original_source_closure',
    positionalManifest.sourceCount >= checkpoints[0].data.shadowedSeqs.length &&
    positionalLogs.filter(event => event.type === 'compaction/summary').length === 2);
  check('session_continues_after_compaction', agent.status === 'idle');
  const capsuleFiles1 = (await files(join(manual.root, 'capsules'))).filter(path => path.endsWith('.json'));
  const capsuleHashes1 = await Promise.all(capsuleFiles1.map(async path => ({ path, hash: sha(await readFile(path)) })));
  const compactionCallsBefore = manual.adapter.calls.filter(call => call.purpose === 'compaction').length;
  manual.adapter.checkpointMarker = '';
  const second = await manual.ctx.compaction.compactNow(agent, SIGNAL);
  check('repeated_compaction_commits', second !== null);
  const repeatedCalls = manual.adapter.calls.filter(call => call.purpose === 'compaction').slice(compactionCallsBefore);
  const priorText = plain([{ content: result.summary }]);
  check('repeated_input_uses_capsules_without_native_checkpoint_frame', repeatedCalls.length > 0 &&
    repeatedCalls.every(call => !call.text.includes('This is an automatically generated checkpoint condensing')));
  check('prior_final_prose_is_never_resummarized', priorText.includes('PRIOR_FINAL_PROSE_POISON_815AE896') &&
    repeatedCalls.every(call => !call.text.includes('PRIOR_FINAL_PROSE_POISON_815AE896')));
  check('old_capsules_are_immutable', (await Promise.all(capsuleHashes1.map(async item => sha(await readFile(item.path)) === item.hash))).every(Boolean));
  check('capsules_exist_as_session_local_derived_artifacts', capsuleFiles1.length > 0,
    { capsule_count: capsuleFiles1.length, prior_summary_characters: priorText.length });
  const preservedRead = await manual.ctx.sessionQuery.readEvent({ sessionId: agent.id, seq: toolResult.seq });
  check('native_history_read_finds_shadowed_tool_original', JSON.stringify(preservedRead).includes('END_OF_TOOL_ORIGINAL'));
  await manual.ctx.sessions.flush(agent.session);
  const id = agent.id;
  const surfaceBeforeRestart = [...agent.session.surface.nodes];
  await handle.dispose();
  await manual.dispose();
  contexts.splice(contexts.indexOf(manual), 1);
  const restart = await boot('manual'); contexts.push(restart);
  const resumed = await restart.ctx.agents.resume({ resumeSessionId: id,
    agentOptions: { provider: 'fixture', model: 'fixture-flash', maxTokens: 256 } });
  check('restart_restores_exact_surface', JSON.stringify(resumed.agent.session.surface.nodes) === JSON.stringify(surfaceBeforeRestart));
  const restored = await logOf(restart.ctx, resumed.agent.session);
  check('restart_preserves_original_prefix', originalBytes.every((line, seq) => JSON.stringify(restored[seq]) === line));
  await turn(restart.ctx, resumed.agent, '重启以后继续。' + 'fresh restart source '.repeat(300));
  const third = await restart.ctx.compaction.compactNow(resumed.agent, SIGNAL);
  check('repeated_compaction_after_restart_uses_persisted_capsules', third !== null);

  const automatic = await boot('automatic', { auto: true }); contexts.push(automatic);
  automatic.adapter.contextWindow = 16_000;
  const autoHandle = await automatic.create();
  await seed(automatic.ctx, autoHandle.agent, 7, 11_000);
  check('real_loop_automatic_pressure_compaction', (await logOf(automatic.ctx, autoHandle.agent.session))
    .some(event => event.type === 'compaction/summary'));

  const overflow = await boot('overflow', { auto: true }); contexts.push(overflow);
  const overflowHandle = await overflow.create();
  await seed(overflow.ctx, overflowHandle.agent, 2);
  overflow.adapter.overflowOnce = true;
  await turn(overflow.ctx, overflowHandle.agent, '规范 context overflow 之后应压缩并重试。');
  check('canonical_overflow_recovers_and_continues', (await logOf(overflow.ctx, overflowHandle.agent.session))
    .some(event => event.type === 'compaction/summary'));

  const proactive = await boot('proactive'); contexts.push(proactive);
  const proactiveHandle = await proactive.create();
  await seed(proactive.ctx, proactiveHandle.agent, 2);
  proactive.adapter.requestTool = 'context_compact';
  await turn(proactive.ctx, proactiveHandle.agent, '我现在主动整理当前上下文，请用 context_compact。');
  const proactiveLog = await logOf(proactive.ctx, proactiveHandle.agent.session);
  const proactiveCall = proactiveLog.find(event => event.type === 'tool/call' && event.data.name === 'context_compact');
  const proactiveResult = proactiveLog.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === proactiveCall?.data.callId);
  const proactiveStart = proactiveLog.find(event => event.type === 'compaction/start' && event.seq > (proactiveResult?.seq ?? Infinity));
  check('model_proactive_tool_compacts_after_durable_balanced_result', proactiveStart !== undefined);
  const proactiveReplacement = proactiveLog.find(event => event.type === 'compaction/summary' && event.seq > proactiveStart.seq);
  check('proactive_request_and_result_remain_in_original_log', proactiveCall !== undefined && proactiveResult !== undefined && proactiveReplacement !== undefined);
  check('function_plugin_registers_model_facing_compact_tool', proactive.ctx.tools.schemas().some(tool => tool.name === 'context_compact'));

  const failure = await boot('failure'); contexts.push(failure);
  const failHandle = await failure.create();
  await seed(failure.ctx, failHandle.agent, 2);
  failure.adapter.failSummary = true;
  const failedNodes = [...failHandle.agent.session.surface.nodes];
  await assert.rejects(() => failure.ctx.compaction.compactNow(failHandle.agent, SIGNAL));
  check('failed_summary_keeps_surface_unchanged', JSON.stringify(failHandle.agent.session.surface.nodes) === JSON.stringify(failedNodes));
  const failureLog = await logOf(failure.ctx, failHandle.agent.session);
  check('failed_summary_has_closed_durable_attempt', failureLog.findLast(event => event.type === 'compaction/end')?.data.error !== undefined);
  failure.adapter.failSummary = false;
  failure.adapter.truncateSummary = true;
  await assert.rejects(() => failure.ctx.compaction.compactNow(failHandle.agent, SIGNAL));
  check('truncated_summary_is_rejected_without_replacement', JSON.stringify(failHandle.agent.session.surface.nodes) === JSON.stringify(failedNodes));
  failure.adapter.truncateSummary = false;
  check('failure_does_not_leave_compaction_lock_stuck', await failure.ctx.compaction.compactNow(failHandle.agent, SIGNAL) !== null);

  const corruption = await boot('corruption'); contexts.push(corruption);
  const corruptionHandle = await corruption.create();
  await seed(corruption.ctx, corruptionHandle.agent, 4);
  await corruption.ctx.compaction.compactNow(corruptionHandle.agent, SIGNAL);
  const capsuleCandidates = await Promise.all((await files(join(corruption.root, 'capsules')))
    .filter(path => path.endsWith('.json')).map(async path => ({ path, raw: await readFile(path, 'utf8') })));
  capsuleCandidates.sort((a, b) => JSON.parse(a.raw).payload.source[0].seq - JSON.parse(b.raw).payload.source[0].seq);
  const damaged = capsuleCandidates[0];
  assert.ok(damaged, 'expected a capsule to corrupt');
  const damagedValue = JSON.parse(damaged.raw);
  damagedValue.payload.text += ' TAMPERED_PAYLOAD';
  await writeFile(damaged.path, JSON.stringify(damagedValue));
  await turn(corruption.ctx, corruptionHandle.agent, '新记录，检查缓存完整性。' + 'fresh evidence '.repeat(450));
  const corruptionNodes = [...corruptionHandle.agent.session.surface.nodes];
  await assert.rejects(() => corruption.ctx.compaction.compactNow(corruptionHandle.agent, SIGNAL));
  check('corrupt_capsule_fails_closed_without_context_replacement',
    JSON.stringify(corruptionHandle.agent.session.surface.nodes) === JSON.stringify(corruptionNodes));

  const excerpt = await boot('tool-excerpt', { config: { toolExcerptChars: 1000 } }); contexts.push(excerpt);
  const excerptHandle = await excerpt.create();
  await seed(excerpt.ctx, excerptHandle.agent, 2);
  excerpt.adapter.requestTool = true;
  await turn(excerpt.ctx, excerptHandle.agent, '检查大量工具输出的明确省略和原文定位。');
  await excerpt.ctx.compaction.compactNow(excerptHandle.agent, SIGNAL);
  check('large_tool_excerpt_declares_omission_hash_and_locator', excerpt.adapter.calls.some(call =>
    call.purpose === 'compaction' && call.text.includes('工具输出中部未注入') && call.text.includes('sha256:') &&
    call.text.includes('session_event_read') && call.text.includes('原文字符数:')));
  const excerptLog = await logOf(excerpt.ctx, excerptHandle.agent.session);
  const excerptOriginal = excerptLog.find(event => event.type === 'tool/result' && plain([event.data.message]).includes('END_OF_TOOL_ORIGINAL'));
  check('excerpt_preserves_complete_long_tool_original', excerptOriginal !== undefined &&
    plain([excerptOriginal.data.message]).length > 9000);

  const noRefs = await boot('no-capsule-refs'); contexts.push(noRefs);
  const noRefsHandle = await noRefs.create();
  await seed(noRefs.ctx, noRefsHandle.agent, 2);
  noRefs.adapter.noCapsuleRefs = true;
  const noRefsResult = await noRefs.ctx.compaction.compactNow(noRefsHandle.agent, SIGNAL);
  const noRefsCapsules = await Promise.all((await files(join(noRefs.root, 'capsules')))
    .filter(path => path.endsWith('.json') && !path.includes('rejected-'))
    .map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const noRefsSourceLog = await logOf(noRefs.ctx, noRefsHandle.agent.session);
  const noRefsCalls = noRefs.adapter.calls.filter(call => call.purpose === 'compaction' && call.text.includes('历史材料（capsule）'));
  check('reference_free_capsule_commits_with_verified_original_locators', noRefsResult !== null &&
    noRefsCalls.length > 0 && noRefsCalls.every(call => !/\[seq:\d+\]/.test(call.responseText)) &&
    /\[seq:\d+\]/.test(plain([{ content: noRefsResult.summary }])) && noRefsCapsules.length > 0 &&
    noRefsCapsules.every(capsule => capsule.payload.source.length > 0 &&
      capsule.payload.source.every(source => noRefsSourceLog[source.seq] !== undefined) &&
      capsule.payload.text.includes('首项 [seq:' + capsule.payload.source[0].seq + ']') &&
      capsule.payload.text.includes('末项 [seq:' + capsule.payload.source.at(-1).seq + ']')));

  const invalidRefs = await boot('invalid-checkpoint-refs'); contexts.push(invalidRefs);
  const invalidRefsHandle = await invalidRefs.create();
  await seed(invalidRefs.ctx, invalidRefsHandle.agent, 2);
  invalidRefs.adapter.invalidCheckpointRefs = true;
  const invalidRefsNodes = [...invalidRefsHandle.agent.session.surface.nodes];
  await assert.rejects(() => invalidRefs.ctx.compaction.compactNow(invalidRefsHandle.agent, SIGNAL));
  const rejectedDrafts = await Promise.all((await files(join(invalidRefs.root, 'capsules')))
    .filter(path => /rejected-.*\.json$/.test(path)).map(async path => JSON.parse(await readFile(path, 'utf8'))));
  check('out_of_source_reference_rejects_and_keeps_auditable_draft',
    JSON.stringify(invalidRefsHandle.agent.session.surface.nodes) === JSON.stringify(invalidRefsNodes) &&
    rejectedDrafts.some(draft => draft.rejected === true && draft.stage === 'checkpoint' &&
      draft.text.includes('[seq:999999]') && !draft.allowedSeqs.includes(999999) &&
      draft.usage !== null && !Object.hasOwn(draft, 'reasoning')));

  const quotedRefs = await boot('quoted-source-regression'); contexts.push(quotedRefs);
  const quotedRefsHandle = await quotedRefs.create();
  const generatedArgs = { provider: 'fixture', model: 'fixture-flash', systemText: CORE,
    maxTokens: 512, sessionId: quotedRefsHandle.agent.id, signal: SIGNAL, stage: 'capsule',
    allowed: new Set([10]), knownSources: new Set([5, 10]) };
  quotedRefs.adapter.summaryOverride = '当前记录提到过去的原文 [seq:5]，当前来源 [seq:10]。';
  const quotedResult = await quotedRefs.ctx.compaction.generate({ ...generatedArgs,
    evidence: '[seq:10] 原始事件正文中确实引用了 (原文内的历史引用 seq:5)。', quotedSources: new Set([5]) });
  check('actual_cross_segment_historical_quote_is_downgraded_to_quotation',
    quotedResult.modelText.includes('[seq:5]') && !quotedResult.text.includes('[seq:5]') &&
    quotedResult.text.includes('跨片段历史引文 seq:5') && quotedResult.text.includes('[seq:10]'));
  await assert.rejects(() => quotedRefs.ctx.compaction.generate({ ...generatedArgs,
    evidence: '[seq:10] 当前原文并未引用其他历史事件。', quotedSources: new Set() }),
    /outside this source segment: 5/);
  check('existing_but_unquoted_cross_segment_reference_is_rejected', true);
  quotedRefs.adapter.summaryOverride = '引用了不存在的原文 [seq:999999]，当前来源 [seq:10]。';
  await assert.rejects(() => quotedRefs.ctx.compaction.generate({ ...generatedArgs,
    evidence: '[seq:10] 当前原文引用了不存在的历史编号 (原文内的历史引用 seq:999999)。',
    quotedSources: new Set([999999]) }), /outside this source segment: 999999/);
  check('nonexistent_reference_is_rejected_even_when_original_text_quotes_it', true);

  const bounded = await boot('oversized', { config: { maxReplayTokens: 128 } }); contexts.push(bounded);
  const boundedHandle = await bounded.create();
  await seed(bounded.ctx, boundedHandle.agent, 2);
  const boundedNodes = [...boundedHandle.agent.session.surface.nodes];
  await assert.rejects(() => bounded.ctx.compaction.compactNow(boundedHandle.agent, SIGNAL));
  check('oversized_indivisible_event_fails_without_silent_truncation',
    JSON.stringify(boundedHandle.agent.session.surface.nodes) === JSON.stringify(boundedNodes));

  const sourceSha256End = await sourceHashes();
  check('tested_source_bytes_unchanged_from_start_to_finish',
    JSON.stringify(sourceSha256End) === JSON.stringify(sourceSha256), { paths_checked: sourcePaths.length });
  const report = { observed_at: new Date().toISOString(), passed: true, real_api_called: false,
    sourceSha256, sourceSha256End, source_hashes_unchanged: true,
    semantic_quality_verified: false, installed_harness_packages: '0.2.0-rc.2',
    test_root: runRoot, checks, model_fixture_calls: allCalls.length,
    caveat: 'Deterministic adapter verifies native orchestration, persistence and provenance; real model quality is separate.' };
  await writeFile(join(runRoot, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: join(runRoot, 'validation.json') }));
} catch (error) {
  await writeFile(join(runRoot, 'validation.json'), JSON.stringify({ passed: false, checks, sourceSha256,
    sourceSha256End: await sourceHashes(),
    error: String(error.stack ?? error), real_api_called: false }, null, 2) + '\n');
  throw error;
} finally { await Promise.allSettled(contexts.map(item => item.dispose())); }
