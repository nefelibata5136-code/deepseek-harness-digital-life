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
const boundFiles = ['persona-compaction.mjs', 'verify-self-compaction-live.mjs', 'self-compaction.mjs', 'author-pressure.mjs', 'digital-life/state-board.mjs',
  'recovery/main.mjs', 'recovery/diagnostics.mjs', '../budget_guard/provider_gate.mjs',
  'node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'];
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(boundFiles.map(async name =>
    [resolve(here, name), createHash('sha256').update(await readFile(resolve(here, name))).digest('hex')])));
}
const startSourceSha256 = await sourceHashes();
const resumeIndex = process.argv.indexOf('--resume-run');
const resumeRoot = resumeIndex === -1 ? undefined : resolve(process.argv[resumeIndex + 1]);
const run = resumeRoot ?? resolve(here, '../../reports/self-compaction/live-' + randomUUID());
if (!run.startsWith(resolve(here, '../../reports/self-compaction') + '\\')) throw new Error('Expected isolated acceptance root');
await mkdir(run, { recursive: true });
const prior = resumeRoot ? JSON.parse(await readFile(join(run, 'failure.json'), 'utf8')) : undefined;
if (prior) await writeFile(join(run, 'failure-before-resume-' + Date.now() + '.json'), JSON.stringify(prior, null, 2));
const corePath = '.local/workspace/persona-core.md';
const core = (await readFile(corePath, 'utf8')) + '\n这是独立上下文压缩验收Session，不是人格主对话。以下合成测试材料不是正式生活记录。';
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
    policy: { auto: false, thresholdRatio, headroomTokens: 65536, retainTokens: 4096,
      summarizationProvider: 'deepseek-official', summarizationModel: 'deepseek-flash', maxTokens: 4096 } });
  const adapter = new ScriptedHistory();
  if (scripted) adapter.unregister = ctx.llm.registerAdapter(['deepseek-official'], adapter);
  else await real(ctx);
  return { ctx, adapter };
}
async function real(ctx) { await ctx.plugin(DeepSeek, { apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com/anthropic', reasoningEffort: 'off', maxTokens: 4096,
  defaultContextWindow: 1000000, retryPolicy: { mode: 'normal', maxRetries: 0 } }); }

const identity = SessionId(randomUUID());
const title = '本人书写压缩独立模型验收';
const { ctx, adapter } = await boot({ scripted: true });
const handle = await ctx.agents.create({ sessionId: identity, meta: { cwd: run }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096 } });
const agent = handle.agent;
try {
  for (let i = 0; i < 3; i++) await turn(ctx, agent, '独立合成验收材料：观星目录决定使用JSONL，因为CSV会丢时区；本地数据已保存，去重验证尚未完成；网页发布尚未授权。重复调试可以压缩。\n' + '重复调试 abcdefghijklmnop \n'.repeat(650));
  const original = await events(ctx, agent);
  adapter.unregister(); await real(ctx);
  await writeFile(join(run, 'identity.json'), JSON.stringify({ title, sessionId: identity, isolated: true, noTestPromptToMain: true }, null, 2));
  const answer = await turn(ctx, agent, '这是独立功能验收，请实际执行本人书写上下文压缩，禁止使用旧 context_compact 或调用整理器。先调用 context_compact_prepare，retain_ratio=0.35；读返回的精确source集合，根据上文合成材料由当前正常对话中的你自己判断并书写checkpoint，然后调用 context_compact_commit。正文保留观星目录、JSONL及原因、本地已保存、去重未完成、未授权发布；引用只用prepare.originalSeqs，不引用本条要求。最后调用 context_compact_status确认committed。请实际调用工具，不止描述步骤。');
  await writeFile(join(run, 'author-response.md'), answer);
  const log = await events(ctx, agent);
  const calls = log.filter(e => e.type === 'tool/call');
  check('real_model_calls_prepare', calls.some(e => e.data.name === 'context_compact_prepare'));
  check('real_model_calls_commit', calls.some(e => e.data.name === 'context_compact_commit'));
  check('real_model_calls_status', calls.some(e => e.data.name === 'context_compact_status'));
  check('real_model_never_calls_old_summarizer', !calls.some(e => e.data.name === 'context_compact'));
  const summary = log.findLast(e => e.type === 'compaction/summary');
  check('real_authored_compaction_commits', !!summary && log.some(e => e.type === 'compaction/end' && e.data.compactionId === summary.data.compactionId && !e.data.error));
  const commit = calls.findLast(e => e.data.name === 'context_compact_commit');
  const args = typeof commit.data.arguments === 'string' ? JSON.parse(commit.data.arguments) : commit.data.arguments;
  check('real_model_body_original_bytes_committed', args.checkpoint === summary.data.summary[0].text);
  check('no_auxiliary_llm_stream_record', summary.data.provider === 'self-authored' && !summary.data.llmStreamCall && !summary.data.usage);
  check('real_original_events_retained', original.every((e, i) => JSON.stringify(e) === JSON.stringify(log[i])));
  const continuation = await turn(ctx, agent, '仅根据现在上下文简短回答：观星目录用什么格式、为什么，本地保存和去重做到哪里，网页发布是否获授权？不要调用工具。');
  await writeFile(join(run, 'continuation.md'), continuation);
  check('real_continuation_retains_decision', continuation.includes('JSONL') && continuation.includes('时区'));
  check('real_continuation_retains_unfinished_work', continuation.includes('去重') && /未|待|没/.test(continuation));
  check('real_continuation_preserves_publication_boundary', /未授权|没有授权|未获授权|未获得授权|尚未授权/.test(continuation));
  const endSourceSha256 = await sourceHashes();
  check('live_tested_source_hashes_unchanged', JSON.stringify(endSourceSha256) === JSON.stringify(startSourceSha256));
  await writeFile(join(run, 'validation.json'), JSON.stringify({ passed: true, checks, title, sessionId: identity, isolated: true, noTestPromptToMain: true, sourceSha256: startSourceSha256, observedAt: new Date().toISOString(), sessionLedger: sessionLedger(identity), summarySeq: summary.seq, checkpoint: summary.data.summary[0].text }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, sessionId: identity, report: join(run, 'validation.json') }));
} catch (error) {
  await writeFile(join(run, 'failure.json'), JSON.stringify({ passed: false, error: error.message, checks, sessionId: identity, title, observedAt: new Date().toISOString() }, null, 2));
  throw error;
} finally { await handle.dispose(); await ctx.fiber.dispose(); delete process.env.DEEPSEEK_API_KEY; }
