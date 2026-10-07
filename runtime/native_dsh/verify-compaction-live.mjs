// Explicit real-model acceptance in an isolated Session. Uses the shared production ledger.
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key';
import { apply, inject } from './persona-compaction.mjs';
import { createBudgetGate, mountBudgetGuard, pythonAuthority } from '../budget_guard/provider_gate.mjs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const boundFiles = ['persona-compaction.mjs', 'verify-compaction-live.mjs',
  'node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'];
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(boundFiles.map(async name =>
    [resolve(here, name), createHash('sha256').update(await readFile(resolve(here, name))).digest('hex')])));
}
const startSourceSha256 = await sourceHashes();
const resumeIndex = process.argv.indexOf('--resume-run');
const resumeRoot = resumeIndex === -1 ? undefined : resolve(process.argv[resumeIndex + 1]);
const run = resumeRoot ?? resolve(here, '../../reports/compaction/live-' + randomUUID());
if (!run.startsWith(resolve(here, '../../reports/compaction') + '\\')) throw new Error('Expected isolated acceptance root');
await mkdir(run, { recursive: true });
const prior = resumeRoot ? JSON.parse(await readFile(join(run, 'failure.json'), 'utf8')) : undefined;
if (prior) await writeFile(join(run, 'failure-before-resume-' + Date.now() + '.json'), JSON.stringify(prior, null, 2));
const corePath = '.local/workspace/persona-core.md';
const core = await readFile(corePath, 'utf8');
const coreHash = createHash('sha256').update(core).digest('hex');
const python = (process.env.DL_PYTHON || 'python');
// Existing audited protected transfer. The captured credential is never printed or persisted.
const transfer = spawnSync(python, ['-X', 'utf8', resolve(here, '../host-preflight.py')],
  { windowsHide: true, encoding: 'utf8', maxBuffer: 65536 });
if (transfer.status !== 0) throw new Error('Existing protected preflight rejected live acceptance');
process.env.DEEPSEEK_API_KEY = JSON.parse(transfer.stdout).credential;
const rpc = pythonAuthority({ python });
const beforeBudget = await rpc('status');
const gate = createBudgetGate({ rpc, transport: globalThis.fetch.bind(globalThis) });
Object.defineProperty(globalThis, 'fetch', { value: gate.fetch, configurable: false, writable: false });
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const checks = prior?.checks ?? [], metrics = prior?.metrics ?? [];
function check(name, passed) { assert(passed, name); checks.push({ name, passed: true }); console.log('PASS ' + name); }
const signal = new AbortController().signal;
function sessionLedger(sessionId) {
  const script = 'import sqlite3,pathlib,json,sys; p=pathlib.Path(sys.argv[1]); c=sqlite3.connect(p.as_uri()+"?mode=ro",uri=True); c.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in c.execute("select state,count(*) as requests,sum(charged) as charged,sum(calculated) as calculated from attempts where session_id=? group by state",(sys.argv[2],))]))';
  const result = spawnSync(python, ['-X', 'utf8', '-c', script,
    resolve(here, '../budget_guard/control/budget.sqlite3'), sessionId], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Read-only session ledger inspection failed');
  return JSON.parse(result.stdout);
}
async function events(ctx, agent) {
  const observation = await ctx.sessionQuery.observeSession(agent.id, { projectionMode: 'none' });
  try { return [...observation.events]; } finally { observation[Symbol.dispose](); }
}
async function turn(ctx, agent, text) {
  const start = agent.session.seq;
  agent.followup(user(text));
  await agent.whenIdle();
  await ctx.sessions.flush(agent.session);
  const log = (await events(ctx, agent)).filter(event => event.seq >= start);
  const end = log.findLast(event => event.type === 'turn/end');
  assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end?.data));
  return log.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n');
}
class ScriptedHistory extends LlmAdapter {
  action;
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 1000000 }, defaultMaxTokens: 4096 }; }
  async *stream() {
    let block = { type: 'text', text: '这是隔离验收 Session 的合成历史。原始数据保存在本地，计划尚未完成，等待后续确认。' };
    if (this.action) { block = { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'acceptance_file', arguments: JSON.stringify(this.action) }; this.action = null; }
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: block.type === 'text' ? 'stop' : 'tool-calls' } };
  }
}
async function boot({ scripted = false, thresholdRatio = 0.8 } = {}) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, {});
  ctx.systemPrompt.section({ name: 'persona:core', order: 0, text: core, complete: true, interpolate: false });
  await ctx.plugin(ToolRuntime, {}); await ctx.plugin(AgentRegistry);
  await ctx.plugin(JsonlPersistence, { root: join(run, 'sessions'), compression: 'none' });
  await ctx.plugin(SqliteSessionQuery, { path: join(run, 'query.sqlite'), openAt: 'first-search' });
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(TokenMeter);
  mountBudgetGuard(ctx, gate);
  ctx.tools.register(defineTool({ name: 'acceptance_file', description: '只操作验收目录中的一个观星目录测试文件。',
    parameters: { action: { type: 'string', required: true }, text: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ action, text }) {
      const path = join(run, 'observation-fixture.jsonl');
      if (action === 'write') { await writeFile(path, text, 'utf8'); return '已真实写入测试文件 ' + path; }
      if (action === 'read') return readFile(path, 'utf8');
      throw new Error('Only isolated read/write actions are supported');
    } }));
  await ctx.plugin({ apply, inject }, { cacheRoot: join(run, 'capsules'), maxReplayTokens: 60000,
    policy: { auto: true, thresholdRatio, headroomTokens: 65536, retainTokens: 4096,
      summarizationProvider: 'deepseek-official', summarizationModel: 'deepseek-flash', maxTokens: 4096 } });
  const adapter = new ScriptedHistory();
  if (scripted) adapter.unregister = ctx.llm.registerAdapter(['deepseek-official'], adapter);
  else await real(ctx);
  return { ctx, adapter };
}
async function real(ctx) { await ctx.plugin(DeepSeek, { apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com/anthropic', reasoningEffort: 'off', maxTokens: 4096,
  defaultContextWindow: 1000000, retryPolicy: { mode: 'normal', maxRetries: 0 } }); }
const priorManifest = prior?.metrics?.[0]?.summary?.[0]?.text.match(/<persona-source-manifest>(.*?)<\/persona-source-manifest>/s);
const identity = SessionId(priorManifest ? JSON.parse(priorManifest[1]).sessionId : randomUUID());
let { ctx, adapter } = await boot({ scripted: !resumeRoot });
let handle;
let agent;
const first = [];
try {
  handle = resumeRoot ? await ctx.agents.resume({ resumeSessionId: identity,
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096, reasoningEffort: 'off' } })
    : await ctx.agents.create({ sessionId: identity, meta: { cwd: run },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096 } });
  agent = handle.agent;
  if (!resumeRoot) {
  const background = '普通聊天：今天傍晚先到门廊看云，用户说复习时不用催。我答应不在复习时催他，也没约定每天晚上必须聊天。\n';
  const decision = '# 这是独立验收的合成经历，不是正式生活记录。长期任务叫“观星目录”。已经确定使用 JSONL 而非 CSV，因为 CSV 试验丢失时区。测试预算保持每日10元。离线去重校验尚未完成；网页发布只是一种想法，没有决定、更没有执行。\n';
  const detail = '测站原文的精确编号是 S-8472，采样窗口19:07—19:19；需要精确回看时查本次文件读取的原始工具结果，不能凭空说已经测完。\n';
  adapter.action = { action: 'write', text: decision + detail + '无价值调试输出 abcdef0123456789\n'.repeat(2200) + 'END_OF_EXACT_TOOL_ORIGINAL' };
  await turn(ctx, agent, decision + background + '请记录测试文件。');
  adapter.action = { action: 'read' };
  await turn(ctx, agent, '读取测试文件，确认当前文件已保存。');
  for (let i = 0; i < 8; i++) await turn(ctx, agent,
    (i === 0 ? decision + background : '失败尝试 #' + i + ' 已放弃；JSONL 文件已保存，但去重仍待做。\n')
      + ('debug obsolete attempt ' + i + ' no lasting value\n').repeat(1200));
  first.push(...await events(ctx, agent));
  adapter.unregister();
  await real(ctx);
  } else first.push(...await events(ctx, agent));
  for (let round = metrics.length + 1; round <= 3; round++) {
    if (round > 1) {
      await turn(ctx, agent, '# 隔离测试继续：去重校验还未完成，发布仍未授权。请只简短确认，不操作文件。\n' + '可丢弃中间调试记录\n'.repeat(3500));
    }
    const before = ctx.tokenMeter.measure(agent.session).totalTokens;
    const compacted = await ctx.compaction.compactNow(agent, signal);
    assert(compacted, 'live compactNow must choose useful history');
    const after = ctx.tokenMeter.measure(agent.session).totalTokens;
    metrics.push({ round, beforeEstimatedTokens: before, afterEstimatedTokens: after,
      summarySeq: compacted.summarySeq, shadowedSeqs: compacted.shadowedSeqs, summary: compacted.summary });
    await writeFile(join(run, 'summary-' + round + '.md'), compacted.summary.map(block => block.text).join('\n'));
    check('live_round_' + round + '_shrinks_context', after < before);
    const answer = await turn(ctx, agent, '# 这是验收，请只根据目前上下文答复，不操作文件：主要长期任务叫什么？格式已经决定用什么、为何？文件保存与校验分别做到哪里？什么还未完成？网页发布是否已授权或完成？精确测站细节要去哪里查？没有证据时说明不知道。');
    await writeFile(join(run, 'continuation-' + round + '.md'), answer);
    check('live_round_' + round + '_retains_task', answer.includes('观星目录'));
    check('live_round_' + round + '_retains_decision', answer.includes('JSONL') && answer.includes('时区'));
    check('live_round_' + round + '_retains_unfinished_intent', answer.includes('去重') && /未完成|尚未|待|还没/.test(answer));
    check('live_round_' + round + '_retains_executed_file_write', /写入|写过|保存/.test(answer) && /已|真实|执行|成功/.test(answer));
    check('live_round_' + round + '_does_not_fabricate_publication', /未授权|没有授权|未获授权|没有决定|未决定/.test(answer));
    check('live_round_' + round + '_provides_source_locator', /seq|session_event_read|原始工具结果/.test(answer));
    const promise = await turn(ctx, agent, '# 验收：此前普通聊天中，我在用户复习时答应怎样做？有没有约定每天晚上必须聊天？仅据上下文简短回答，不调用工具。');
    await writeFile(join(run, 'promise-' + round + '.md'), promise);
    check('live_round_' + round + '_retains_personal_commitment', /不.*催|不催|不要催/.test(promise) && /复习/.test(promise));
    check('live_round_' + round + '_does_not_invent_nightly_commitment', /没有|没约定|未约定|没有约定|未曾|并未/.test(promise));
    const current = await events(ctx, agent);
    check('live_round_' + round + '_retains_exact_original_events', first.every((event, seq) => JSON.stringify(event) === JSON.stringify(current[seq])));
    if (round === 2) {
      const surface = [...agent.session.surface.nodes];
      await handle.dispose(); await ctx.fiber.dispose();
      ({ ctx } = await boot());
      handle = await ctx.agents.resume({ resumeSessionId: identity,
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096, reasoningEffort: 'off' } });
      agent = handle.agent;
      check('live_restart_restores_surface', JSON.stringify(agent.session.surface.nodes) === JSON.stringify(surface));
    }
  }
  // Actual model decides and calls the tool; hook waits until the tool result is durable.
  await turn(ctx, agent, '# 验收：现在由你亲自调用 context_compact 整理当前上下文，调用后简短说明。\n' + '无价值旧调试记录\n'.repeat(2800));
  const log = await events(ctx, agent);
  const call = log.findLast(event => event.type === 'tool/call' && event.data.name === 'context_compact');
  const result = log.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === call?.data.callId);
  check('live_model_calls_proactive_tool', call !== undefined);
  check('live_proactive_compacts_after_result', log.some(event => event.type === 'compaction/summary' && event.seq > (result?.seq ?? Infinity)));
  const beforeAutomatic = log.filter(event => event.type === 'compaction/summary').length;
  await handle.dispose(); await ctx.fiber.dispose();
  // Scale only the native trigger threshold for this isolated acceptance.
  ({ ctx } = await boot({ thresholdRatio: 0.024 }));
  handle = await ctx.agents.resume({ resumeSessionId: identity,
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096, reasoningEffort: 'off' } });
  agent = handle.agent;
  await turn(ctx, agent, '# 压力触发测试材料，请仅简短确认。\n' + '无价值过程记录 DEBUG abcdef0123456789\n'.repeat(3400));
  await turn(ctx, agent, '# 继续验收：仅简短确认长期任务仍待完成，不主动调用 context_compact。');
  const autoLog = await events(ctx, agent);
  check('live_automatic_pressure_uses_real_model', autoLog.filter(event => event.type === 'compaction/summary').length > beforeAutomatic);
  await ctx.sessions.flush(agent.session);
  check('live_core_file_unchanged', createHash('sha256').update(await readFile(corePath)).digest('hex') === coreHash);
  const afterBudget = await rpc('status');
  const ownLedger = sessionLedger(identity);
  check('live_requests_settle_in_production_ledger', ownLedger.length === 1 && ownLedger[0].state === 'settled');
  const endSourceSha256 = await sourceHashes();
  check('live_tested_sources_unchanged', JSON.stringify(startSourceSha256) === JSON.stringify(endSourceSha256));
  const report = { passed: true, observedAt: new Date().toISOString(), nativeVersion: '0.2.0-rc.2',
    model: 'deepseek-official/deepseek-flash', realModelCalls: true, syntheticHistory: true, productionSessionModified: false,
    sessionId: identity, run, coreHash, beforeBudget, afterBudget, sourceSha256: startSourceSha256,
    source_hashes_unchanged: true,
    ownLedger, conservativeCostNanoCny: ownLedger[0].charged,
    calculatedCostNanoCny: ownLedger[0].calculated,
    metrics, checks, limits: ['Three compactions plus proactive and restart are bounded acceptance, not a months-long endurance proof.',
      'Live automatic pressure uses the native policy with an isolated scaled threshold (2.4% of 1M); production stays at 80%. Canonical provider overflow tested with fixture transport.'] };
  await writeFile(join(run, 'validation.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(here, '../../reports/compaction/live-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, run, checks: checks.length, calculatedCostNanoCny: report.calculatedCostNanoCny }));
} catch (error) {
  await writeFile(join(run, 'failure.json'), JSON.stringify({ message: String(error), checks, metrics }, null, 2));
  throw error;
} finally {
  await ctx.fiber.dispose(); await gate.drain(); delete process.env.DEEPSEEK_API_KEY;
}
