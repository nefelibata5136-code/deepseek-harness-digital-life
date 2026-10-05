// Real native children and tools; only the model transport is deterministic.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { bootNative, here } from '../boot-native.mjs';
import { fixtureTransport } from '../fixture-transport.mjs';
import { aggregateSamples } from './intention.mjs';
const base = resolve(here, '../..'), root = resolve(base, 'reports/intention-sampling/offline-' + randomUUID());
const workspace = resolve(root, 'workspace'), primary = randomUUID(), scope = new AsyncLocalStorage();
await mkdir(resolve(workspace, 'memory'), { recursive: true }); await mkdir(resolve(workspace, 'development'), { recursive: true });
for (const [name, text] of [['persona-core.md', 'CORE_EXACT_SAME_8'], ['AGENTS.md', 'Isolated native fixture.'],
  ['memory/continuity.md', 'SAME_CURRENT_CONTINUITY'], ['development/wants.md', 'SAME_WANTS']]) await writeFile(resolve(workspace, name), text);
const rows = parse(await readFile(resolve(here, 'home/profiles/persona/cordis.patch.yml'), 'utf8')).flatMap(r => r.insert ?? []);
const entry = { id: 'persona-resident-v1', name: pathToFileURL(resolve(here, 'digital-life/resident.mjs')).href, config: { workspace } };
process.env.DEEPSEEK_API_KEY = 'offline-placeholder';
const parentQueue = [], childSteps = new Map(), childIndexes = new Map(), childEvidence = new Map(), wires = [];
let mode = 'repeat';
globalThis.fetch = async (url, init) => {
  const agent = scope.getStore() ?? ctx.agents.currentInitiator(), wire = JSON.parse(init.body); wires.push({ id: String(agent.session.id), wire });
  let answer;
  if (agent.session.header.origin === 'subagent') {
    const id = String(agent.session.id), step = childSteps.get(id) ?? 0; childSteps.set(id, step + 1);
    childEvidence.set(id, { agent, names: agent.ctx.tools.schemas(agent).map(t => t.name) });
    if (!childIndexes.has(id)) childIndexes.set(id, childIndexes.size % 8 + 1);
    const index = childIndexes.get(id);
    if (step === 0) answer = { name: 'intention_internal_read' };
    else answer = { name: 'structured_output', args: { candidates: mode === 'none' || mode === 'mixed' && index > 2 ? [] : [
      { intention: mode === 'diverse' ? '方向 ' + index : index === 8 ? '少数方向' : '重复方向', origin: '内部念头', evidence: ['memory/continuity.md'] }],
      noIntentionReason: mode === 'none' || mode === 'mixed' && index > 2 ? '现在没有特别想做的事' : '' } };
    await new Promise(r => setTimeout(r, 150));
  } else { answer = parentQueue.shift(); assert(answer, 'Unexpected parent re-prompt'); }
  const template = await fixtureTransport(workspace, { startAt: 3 }).transport(url, init);
  const events = (await template.text()).split('\n').map(line => {
    if (!line.startsWith('data: ')) return line;
    const e = JSON.parse(line.slice(6));
    if (e.type === 'content_block_start' && answer.name) e.content_block = { type: 'tool_use', id: randomUUID(), name: answer.name, input: {} };
    if (e.type === 'content_block_delta') e.delta = answer.name ? { type: 'input_json_delta', partial_json: JSON.stringify(answer.args ?? {}) } : { type: 'text_delta', text: answer.text ?? '停止。' };
    if (e.type === 'message_delta') e.delta.stop_reason = answer.name ? 'tool_use' : 'end_turn';
    return 'data: ' + JSON.stringify(e);
  }).join('\n'); return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
};
const ctx = await bootNative({ sessionId: primary, testRoot: root, overlays: [{ id: 'persona-preset-declaration',
  config: { ...rows.find(r => r.id === 'persona-preset-declaration').config, plugins: [entry] } }] });
ctx.on('agent/request', (req, next) => scope.run(req.agent, next), { prepend: true });
const cases = {};
try {
  await ctx.sessionController.create({ sessionId: primary, cwd: workspace }); await ctx.sessionController.rename({ sessionId: primary, title: '八次同源意向展开：隔离验收' });
  const { agent } = await ctx.sessionController.resolveAgent(primary);
  const prompt = async answers => {
    const start = ([...agent.session.ownEvents()].at(-1)?.seq ?? -1) + 1; parentQueue.push(...answers);
    await ctx.sessionController.prompt({ sessionId: primary, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '结束活动，然后自由选择。' }] }, AbortSignal.timeout(30000));
    await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    const events = [...agent.session.ownEvents()].filter(e => e.seq >= start);
    assert.equal(events.findLast(e => e.type === 'turn/end')?.data.reason.kind, 'completed', JSON.stringify(events.filter(e => ['turn/end', 'tool/result'].includes(e.type))));
    assert.equal(parentQueue.length, 0);
    return events;
  };
  await prompt([{ name: 'life_sampling_configure', args: { enabled: true, understanding: '接受单一身份的八次草稿；频次不替我决定，允许没有。' } }, { text: '说明已理解。' }]);
  await ctx.personaLife.store.configure({ residentEnabled: true });
  const extract = events => {
    const text = events.find(e => e.type === 'user/message' && e.data.source?.kind === 'resident-attention').data.content[0].text;
    return JSON.parse(text.split('[八次独立意向展开｜思考草稿]\n')[1].split('\n[/八次独立意向展开]')[0]);
  };
  mode = 'repeat'; let events = await prompt([{ text: '活动完成。' }, { text: '我全部拒绝，先停。' }]); let batch = extract(events);
  assert.equal(batch.completed, 8, JSON.stringify(batch)); assert(batch.parallel); assert(batch.raw.every(s => s.internalReviewed));
  assert.equal(new Set(batch.raw.map(s => s.sameSourceSha256)).size, 1); assert(batch.groups.some(g => g.frequency === '7/8'));
  assert.equal(events.filter(e => e.type === 'tool/call').length, 0);
  cases.A = { passed: true, actualNativeChildren: 8, sameSource: true, parallel: true, frequency: '7/8', mainRejectsAll: true };
  if (process.argv.includes('--smoke')) {
    for (const { agent: child, names } of childEvidence.values()) {
      const boards = [...child.session.ownEvents()].filter(e => e.type === 'system/message' && e.data.message.source.producer === 'digital-life-state-board');
      assert(boards.length); assert(boards.every(e => e.data.message.source.board.facts.role.startsWith('parallel intention branch')));
      assert(!names.includes('digital_life_state_update'));
    }
    await ctx.personaLife.recover(); assert.equal((await ctx.personaLife.store.listPending()).total, 0);
    const report = { passed: true, root, sessionId: primary, cases, branchBoardsTransparent: true, draftsExcludedAfterRecovery: true, paidModelCalls: 0 };
    await writeFile(resolve(root, 'result.json'), JSON.stringify(report, null, 2));
    await writeFile(resolve(base, 'reports/intention-sampling/state-board-integration.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); await ctx.fiber.dispose(); process.exit(0);
  }
  mode = 'diverse'; batch = extract(await prompt([{ text: '完成。' }, { text: '全部不同也可以；我停止。' }]));
  assert.equal(batch.groups.length, 8); cases.B = { passed: true, distinctDirections: 8 };
  mode = 'mixed'; batch = extract(await prompt([{ text: '完成。' }, { text: '大多没有也是正常。停止。' }]));
  assert.equal(batch.noIntention.count, 6); cases.C = { passed: true, noIntention: '6/8', failed: batch.failed.length };
  mode = 'repeat'; events = await prompt([{ text: '完成。' }, { name: 'life_continue', args: { intention: '我自己选择少数方向' } }, { text: '少数活动结束。' }, { text: '停止。' }]);
  assert(events.some(e => e.type === 'user/message' && e.data.source?.kind === 'resident-continuation' && e.data.content[0].text.includes('少数'))); cases.D = { passed: true, minorityChosenByMain: true };
  events = await prompt([{ text: '完成。' }, { name: 'life_continue', args: { intention: '我自己想到第九个念头' } }, { text: '新活动结束。' }, { text: '停止。' }]);
  assert(events.some(e => e.type === 'user/message' && e.data.source?.kind === 'resident-continuation' && e.data.content[0].text.includes('第九')));
  cases.E = { passed: true, independentNewIntention: true };
  mode = 'none'; batch = extract(await prompt([{ text: '完成。' }, { name: 'life_rest' }])); assert.equal(batch.noIntention.count, 8);
  cases.F = { passed: true, noIntention: '8/8', explicitRest: true };
  events = await prompt([{ text: '完成。' }, { name: 'life_rest', args: { nextWakeAt: new Date(Date.now() + 3600000).toISOString(), reason: '我自己想以后再看看。' } }]);
  assert((await ctx.personaHost.schedule.list({ sessionId: primary })).some(s => s.prompt.includes('我自己想')));
  cases.G = { passed: true, nativeSelfSchedule: true };
  await new Promise(r => setTimeout(r, 100)); assert.equal((await ctx.personaLife.store.listPending()).total, 0, 'Sampling drafts must not become experiences');
  const children = [...childIndexes.keys()];
  for (const id of children) {
    const { agent: child, names } = childEvidence.get(id);
    assert(!names.some(n => ['terminal', 'write', 'subagent', 'life_mental_write', 'life_rest', 'schedule_create', 'send_message'].includes(n)));
    assert.equal((await ctx.personaLife.intention.guard({ agent: child, name: 'write', arguments: {} })), 'INTENTION_CANDIDATES_ONLY');
  }
  await ctx.personaLife.recover(); assert.equal((await ctx.personaLife.store.listPending()).total, 0);
  cases.isolation = { passed: true, independentContexts: children.length, draftsExcludedAfterRecovery: true, noWritesOrDelegation: true };
  const result = { passed: true, root, sessionId: primary, cases, paidModelCalls: 0 };
  await mkdir(resolve(base, 'reports/intention-sampling'), { recursive: true }); await writeFile(resolve(root, 'result.json'), JSON.stringify(result, null, 2));
  await writeFile(resolve(base, 'reports/intention-sampling/offline-validation.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await ctx.fiber.dispose(); }
