// Real installed DSH loop + Registry + native Schedule. Offline deterministic
// model transport by default; never writes/sends to the production main Session.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { bootNative, here } from '../boot-native.mjs';
import { fixtureTransport } from '../fixture-transport.mjs';
import { childSessionMeta, applyChildComposition, resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent';
const base = resolve(here, '../..');
const root = resolve(base, 'reports/resident-v1/offline-' + randomUUID());
const workspace = resolve(root, 'workspace'), primary = randomUUID();
await mkdir(resolve(workspace, 'memory'), { recursive: true });
await mkdir(resolve(workspace, 'development'), { recursive: true });
for (const [name, text] of [['persona-core.md', 'Offline acceptance identity.'], ['AGENTS.md', 'Offline fixture.'],
  ['memory/continuity.md', ''], ['development/wants.md', ''], ['audit.txt', 'candidate A\n']])
  await writeFile(resolve(workspace, name), text);
const rows = parse(await readFile(resolve(here, 'home/profiles/persona/cordis.patch.yml'), 'utf8')).flatMap(r => r.insert ?? []);
const declared = rows.find(r => r.id === 'persona-preset-declaration').config.plugins.find(p => p.id === 'persona-resident-v1');
assert.equal(declared.name, pathToFileURL(resolve(here, 'digital-life/resident.mjs')).href, 'Verify formal preset module resolution');
const residentEntry = { ...declared, config: { ...declared.config, workspace } };
const overlays = [{ id: 'persona-preset-declaration', config: {
  ...rows.find(r => r.id === 'persona-preset-declaration').config, plugins: [residentEntry] } }];
process.env.DEEPSEEK_API_KEY = 'offline-placeholder-not-a-secret';
const queue = [], wires = [];
globalThis.fetch = async (url, init) => {
  wires.push(JSON.parse(init.body));
  const answer = queue.shift();
  assert(answer, 'Unexpected model call: Resident must never repeatedly prompt an idle decision');
  const template = await fixtureTransport(workspace, { startAt: 3 }).transport(url, init);
  const events = (await template.text()).split('\n').map(line => {
    if (!line.startsWith('data: ')) return line;
    const e = JSON.parse(line.slice(6));
    if (e.type === 'content_block_start' && answer.name) e.content_block = { type: 'tool_use', id: randomUUID(), name: answer.name, input: {} };
    if (e.type === 'content_block_delta') e.delta = answer.name
      ? { type: 'input_json_delta', partial_json: JSON.stringify(answer.args ?? {}) }
      : { type: 'text_delta', text: answer.text ?? 'Quiet stop.' };
    if (e.type === 'message_delta') e.delta.stop_reason = answer.maxTokens ? 'max_tokens' : answer.name ? 'tool_use' : 'end_turn';
    return 'data: ' + JSON.stringify(e);
  }).join('\n');
  return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
};
const sources = ['digital-life/resident.mjs', 'digital-life/attention.mjs', 'digital-life/verify-resident.mjs',
  'digital-life/intention.mjs', 'digital-life/state-board.mjs', 'digital-life/state-board-model.mjs', 'digital-life/plugin.mjs', 'digital-life/store.mjs', 'persona-plugin.mjs',
  'capabilities/bus.mjs', 'capabilities/read-policy.mjs', 'boot-native.mjs', 'host-components.mjs',
  'task-host.mjs', 'home/profiles/persona/cordis.patch.yml'];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async name =>
  ['runtime/native_dsh/' + name, createHash('sha256').update(await readFile(resolve(here, name))).digest('hex')])));
const initial = await hashes();
const ctx = await bootNative({ sessionId: primary, testRoot: root, overlays });
const cases = {};
const events = agent => [...agent.session.ownEvents()];
const offers = rows => rows.filter(e => e.type === 'user/message' && e.data.source?.kind === 'resident-attention');
const prompt = async (agent, answers, text) => {
  const start = events(agent).at(-1)?.seq ?? -1, before = wires.length;
  queue.push(...answers);
  await ctx.sessionController.prompt({ sessionId: agent.session.id, requestId: randomUUID(), mode: 'queue',
    clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text }] }, new AbortController().signal);
  await agent.whenIdle(); await ctx.sessions.flush(agent.session);
  const actual = events(agent).filter(e => e.seq > start);
  assert(!queue.length, 'Expected calls did not run');
  assert.equal(actual.filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind, answers.some(a => a.maxTokens) ? 'max-tokens' : 'completed');
  assert(!actual.some(e => e.type === 'tool/result' && e.data.isError), JSON.stringify(actual.filter(e => e.type === 'tool/result')));
  return { actual, calls: wires.length - before };
};
try {
  await ctx.sessionController.create({ sessionId: primary, cwd: workspace });
  const { agent } = await ctx.sessionController.resolveAgent(primary);
  assert.equal(ctx.agentPresets.composedPreset(agent.ctx), 'persona');
  assert((await ctx.agentPresets.readDocument('persona')).content.includes('resident.mjs'));
  assert(agent.ctx.tools.schemas(agent).some(t => t.name === 'life_continue'), 'Preset lifecycle tools actually mounted: '+JSON.stringify({composition:await ctx.agentPresets.compositionInventory(),authority:ctx.personaLife.isAuthority(agent),capability:ctx.personaLife.residentCapability,names:agent.ctx.tools.schemas(agent).map(t=>t.name)}));
  await ctx.personaLife.store.configure({ residentEnabled: true });
  await ctx.personaLife.store.appendPending({ id: 'offline-candidate', kind: 'subagent', sourceSessionId: randomUUID(),
    text: '候选 A：可读 audit.txt，之后可自由决定是否做候选 B。' });
  const a = await prompt(agent, [{ text: '普通任务完成。' }, { name: 'read', args: { file_path: resolve(workspace, 'audit.txt') } },
    { text: 'A 做完。' }, { name: 'write', args: { file_path: resolve(workspace, 'result.txt'), content: 'B really executed.' } },
    { text: 'B 做完。' }, { text: '不想处理剩下候选，我现在休息。' }], 'Case A：完成普通任务后自主选两个真实候选，最后停止。');
  assert.equal(offers(a.actual).length, 3);
  assert(offers(a.actual)[1].data.content[0].text.includes('注意力候选没有新增或变化'));
  assert(!offers(a.actual)[1].data.content[0].text.includes('offline-candidate'));
  assert.equal(new Set(offers(a.actual).map(e => e.data.source.rpcId)).size, 3, 'Decision IDs must be unique, never undefined');
  assert.equal(a.actual.filter(e => e.type === 'turn/start').length, 1);
  assert.equal(await readFile(resolve(workspace, 'result.txt'), 'utf8'), 'B really executed.');
  assert.equal((await ctx.sessionController.resolveAgent(primary)).agent, agent);
  cases.A = { passed: true, sameAgent: true, sameSession: primary, oneNativeTurn: true, attentionDecisions: 3, modelCalls: a.calls, tools: ['read', 'write'] };
  const b = await prompt(agent, [{ text: '任务完成。' }, { text: '今天不想继续，先这样。' }], 'Case B：主动停止。');
  assert.equal(b.calls, 2); assert.equal(offers(b.actual).length, 1);
  cases.B = { passed: true, modelCalls: b.calls, noReprompt: true, reason: 'completed' };
  const dRest = await prompt(agent, [{ text: '任务完成。' }, { name: 'life_rest' }], '主动 life_rest 必须结束工具循环。');
  assert.equal(dRest.calls, 2); assert.equal(offers(dRest.actual).length, 1);
  cases.explicitRest = { passed: true, concludesNativeTurn: true, noPostRestModelCall: true };
  const timed = await prompt(agent, [{ text: '调查完成。' }, { name: 'life_rest', args: {
    nextWakeAt: new Date(Date.now() + 12000).toISOString(), reason: '我完成了调查，想稍后回到候选 A；这是我自己安排的。' } }], 'Case C：本人给未来自己安排一次唤醒。');
  assert.equal(timed.calls, 2);
  const scheduled = (await ctx.personaHost.schedule.list({ sessionId: primary }))[0];
  assert(scheduled.prompt.includes('自己安排') && scheduled.prompt.includes('调查'));
  queue.push({ text: '我知道这是自己之前安排的唤醒，上次完成了调查；现在继续休息。' }, { name: 'life_rest' });
  const beforeWake = events(agent).at(-1).seq;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !events(agent).some(e => e.seq > beforeWake && e.type === 'turn/end'))
    await new Promise(r => setTimeout(r, 100));
  await agent.whenIdle(); await ctx.sessions.flush(agent.session);
  const awakened = events(agent).filter(e => e.seq > beforeWake);
  assert(awakened.some(e => e.type === 'user/message' && e.data.source?.kind === 'schedule'));
  assert(awakened.some(e => e.type === 'assistant/message' && JSON.stringify(e.data).includes('上次完成了调查')));
  assert.equal(queue.length, 0);
  cases.C = { passed: true, scheduleId: scheduled.id, nativeScheduleDelivered: true, sameSession: primary,
    selfAuthoredReason: true, previousActivityUnderstoodInOfflineModelResponse: true };
  await ctx.personaLife.store.resolvePending({ id: 'offline-candidate', decision: 'rejected', sessionId: primary, callId: randomUUID() });
  const d = await prompt(agent, [{ text: '任务完成。' }, { text: '清单为空，我选择休息。' }], 'Case D：没有候选。');
  assert.equal(offers(d.actual).length, 1);
  assert(offers(d.actual)[0].data.content[0].text.includes('当前没有特别需要注意的事项。'));
  cases.D = { passed: true, emptyExplicit: true, fabricatedCandidates: 0 };
  const free = await prompt(agent, [{ text: '任务完成。' }, { name: 'life_continue', args: { intention: '写一行自己突然想到的话。' } },
    { text: '这是我自己想到的新文字。' }, { text: '现在休息。' }], '空清单也可自主产生纯文字活动。');
  assert.equal(offers(free.actual).length, 2); assert.equal(free.calls, 4);
  cases.freeIdea = { passed: true, nativeContinuation: true, attentionDecisions: 2 };
  const secondaryId = (await ctx.personaTasks.create({ title: 'Resident副对话排除验收' })).sessionId;
  const { agent: secondary } = await ctx.sessionController.resolveAgent(secondaryId);
  const secondarySchemas = secondary.ctx.tools.schemas(secondary).map(t => t.name);
  for (const name of ['life_rest', 'life_configure', 'life_continue', 'life_attention']) assert(!secondarySchemas.includes(name), name);
  const e = await prompt(secondary, [{ text: '普通活动完成，直接结束。' }], '副对话不进入Resident。');
  assert.equal(e.calls, 1); assert.equal(offers(e.actual).length, 0);
  const handle = await secondary.ctx.agents.create({ sessionId: randomUUID(), parentAgent: secondary,
    meta: childSessionMeta(secondary, 1, false), agentOptions: resolveChildAgentOptions(secondary, {}, 1),
    setup: childCtx => applyChildComposition(childCtx, secondary, {}) });
  try { for (const name of ['life_rest', 'life_configure', 'life_continue', 'life_attention'])
    assert(!handle.agent.ctx.tools.schemas(handle.agent).some(t => t.name === name), 'Child exposed ' + name); }
  finally { await handle.dispose(); }
  cases.secondary = { passed: true, permissionParityEnabled: true, modelCalls: e.calls, decisions: 0, childResidentToolsHidden: true };
  await ctx.agentPresets.register({ id: 'standard', name: 'Standard', plugins: [] });
  const standardId = randomUUID();
  await ctx.sessionController.create({ sessionId: standardId, cwd: workspace });
  const { agent: standard } = await ctx.sessionController.resolveAgent(standardId);
  await ctx.agentPresets.select(standard, 'standard');
  const ordinary = await prompt(standard, [{ text: 'Standard完成。' }], 'Case E：普通预设结束。');
  assert.equal(ordinary.calls, 1); assert.equal(offers(ordinary.actual).length, 0);
  cases.E = { passed: true, preset: 'standard', modelCalls: 1, decisions: 0 };
  const max = await prompt(agent, [{ text: 'token ceiling', maxTokens: true }], '预算/输出上限不得伪装成自然结束。');
  assert.equal(max.calls, 1); assert.equal(offers(max.actual).length, 0);
  cases.maxTokens = { passed: true, modelCalls: 1, residentDidNotBypassLimit: true };
  assert.deepEqual(await hashes(), initial, 'Sources changed during validation; preserve evidence and rerun on final bytes');
  const report = { passed: true, observedAt: new Date().toISOString(), root, paidModelCalls: 0,
    transport: 'deterministic offline model responses; real installed DSH Agent/Registry/Schedule/tool dispatch',
    sessionId: primary, cases, sourceSha256: initial };
  await writeFile(resolve(root, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(base, 'reports/resident-v1/offline-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, root, cases, paidModelCalls: 0 }));
} finally { await ctx.fiber.dispose(); }
