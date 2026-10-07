// Isolated installed-Harness integration checks. No credentials or real API calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, LlmError, createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
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
const runRoot = resolve(here, '../../reports/author-pressure/recovery-checkpoint-' + randomUUID());
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



class RecoveryAdapter extends FixtureAdapter {
  session; enabled=false; action=0;
  async *stream(options) {
    if (!this.enabled) {
      const step=[...this.session.ownEvents()].findLast(e=>e.type==='step/start');
      this.session.append('system/message',{turn:step.data.turn,step:step.data.step,message:createMessage({role:'system',content:[{type:'text',text:'HISTORIC_SYSTEM_SNAPSHOT_'+step.seq}],source:{kind:'fixture'}})},{surfaceOp:'append'});
      yield* super.stream(options); return;
    }
    const phase=this.action++;
    const block=phase===0||phase===2 ? {type:'tool-call',id:ToolCallId(randomUUID()),name:'recovery_resume',arguments:'{}'} : phase === 1 ? {type:'tool-call',id:ToolCallId(randomUUID()),name:'recovery_checkpoint',arguments:JSON.stringify({checkpoint:'本人接续：DECISION_KEEP_LOCAL；PENDING_VERIFY_EXPORT。'})} : {type:'text',text:'完成真实兼容工具fixture。'};
    yield {type:'block-start',index:0,blockType:block.type}; yield {type:'block-end',index:0,block};
    yield {type:'finish',reason:{kind:block.type==='tool-call'?'tool-calls':'stop'}};
  }
}
const adapter=new RecoveryAdapter(), f=await boot('historic-system-span',{adapter});
try {
  const {agent}=await f.create();adapter.session=agent.session;
  await writeFile(join(f.root,'persona-core.md'),CORE);await writeFile(join(f.root,'AGENTS.md'),'隔离恢复fixture');
  await mkdir(join(f.root,'recovery'));
  await writeFile(join(f.root,'recovery/main-mode.json'),JSON.stringify({mode:'light',updatedAt:new Date().toISOString()}));
  await mountMainRecovery(f.ctx,{root:join(f.root,'recovery'),workspace:f.root,primary:String(agent.id)});
  await seed(f.ctx,agent,4,9000);const original=await logOf(f.ctx,agent.session);
  adapter.enabled=true;await turn(f.ctx,agent,'真实执行恢复检查点fixture');
  const log=await logOf(f.ctx,agent.session),summary=log.findLast(e=>e.type==='compaction/summary');
  const result=log.findLast(e=>e.type==='tool/result'&&e.data.message.toolName==='recovery_checkpoint');
  check('recovery_checkpoint_commits_with_historic_system_nodes',summary?.data.summary[0].text==='本人接续：DECISION_KEEP_LOCAL；PENDING_VERIFY_EXPORT。'&&log.some(e=>e.type==='compaction/end'&&e.data.compactionId===summary.data.compactionId));
  check('replacement_covers_all_shadowed_nodes',summary.data.shadowedSeqs.some(seq=>agent.session.eventAt(seq).type==='system/message'));
  const landed=log.findLast(e=>e.type==='user/message'&&e.surfaceOp?.op==='replace');
  check('native_source_graph_contains_every_shadowed_node',summary.data.shadowedSeqs.every(seq=>landed.sourceEventSeqs.includes(seq)));
  check('recovery_original_history_unchanged',original.every((e,i)=>JSON.stringify(e)===JSON.stringify(log[i])));
  const resumes=log.filter(e=>e.type==='tool/call'&&e.data.name==='recovery_resume');
  const rejected=log.find(e=>e.type==='tool/result'&&e.data.message.toolCallId===resumes[0].data.callId);
  check('resume_before_checkpoint_rejected',rejected.data.message.isError===true);
  const mode=JSON.parse(await readFile(join(f.root,'recovery/main-mode.json'),'utf8'));
  check('primary_author_can_resume_only_after_commit',mode.mode==='normal'&&mode.authorSessionId===String(agent.id)&&mode.checkpointSeq===summary.seq);
  check('no_auxiliary_summary_model',adapter.calls.every(c=>c.purpose!=='compaction'));
  const after=await sourceHashes();check('source_hashes_unchanged',JSON.stringify(after)===JSON.stringify(sourceSha256));
  await writeFile(join(runRoot,'validation.json'),JSON.stringify({passed:true,checks,sourceSha256,apiCalls:0,observedAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length,report:join(runRoot,'validation.json')}));
} finally {await f.dispose();}
