import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { bootNative, here } from '../boot-native.mjs';
import { fixtureTransport } from '../fixture-transport.mjs';
import { inputIdentity, stateChanges } from './state-board.mjs';
const base = resolve(here, '../..'), root = resolve(base, 'reports/state-board/offline-' + randomUUID());
const workspace = resolve(root, 'workspace'), primary = randomUUID();
await mkdir(resolve(workspace, 'memory'), { recursive: true }); await mkdir(resolve(workspace, 'development'), { recursive: true });
for (const [name, text] of [['persona-core.md', 'STABLE_CORE_PREFIX\n'.repeat(1000)], ['AGENTS.md', 'Offline fixture.'],
  ['memory/continuity.md', ''], ['development/wants.md', '']]) await writeFile(resolve(workspace, name), text);
const rows = parse(await readFile(resolve(here, 'home/profiles/persona/cordis.patch.yml'), 'utf8')).flatMap(r => r.insert ?? []);
const entry = { id: 'persona-resident-v1', name: pathToFileURL(resolve(here, 'digital-life/resident.mjs')).href, config: { workspace } };
process.env.DEEPSEEK_API_KEY = 'offline-placeholder'; const queue = [], wires = [];
let childGate;
globalThis.fetch = async (url, init) => {
  wires.push(JSON.parse(init.body));
  const isChild = ctx.agents.currentInitiator()?.session.header.origin === 'subagent';
  if (isChild && childGate) await childGate;
  const answer = isChild && childGate ? { text: '来源测试子Agent确实结束。' } : queue.shift(); assert(answer, 'Unexpected request');
  const template = await fixtureTransport(workspace, { startAt: 3 }).transport(url, init);
  const events = (await template.text()).split('\n').map(line => {
    if (!line.startsWith('data: ')) return line; const e = JSON.parse(line.slice(6));
    if (answer.provisional && e.index !== undefined) e.index++;
    if (e.type === 'content_block_start' && answer.name) e.content_block = { type: 'tool_use', id: randomUUID(), name: answer.name, input: {} };
    if (e.type === 'content_block_delta') e.delta = answer.name ? { type: 'input_json_delta', partial_json: JSON.stringify(answer.args ?? {}) } : { type: 'text_delta', text: answer.text ?? '正式回答。' };
    if (e.type === 'message_delta') e.delta.stop_reason = answer.name ? 'tool_use' : 'end_turn';
    if (answer.provisional && e.type === 'content_block_start') return [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOW_PARTIAL_MUST_NOT_ESCAPE' } },
      { type: 'content_block_stop', index: 0 }, e].map(item => 'event: ' + item.type + '\ndata: ' + JSON.stringify(item)).join('\n\n');
    return 'data: ' + JSON.stringify(e);
  }).join('\n'); return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
};
const ctx = await bootNative({ sessionId: primary, testRoot: root, overlays: [{ id: 'persona-preset-declaration',
  config: { ...rows.find(r => r.id === 'persona-preset-declaration').config, plugins: [entry] } }] });
ctx.on('agent/request-error', (request, next) => { let error = request.error; while(error){ console.error(error.message); error = error.cause; } return next(); });
const cases = {};
try {
  await ctx.sessionController.create({ sessionId: primary, cwd: workspace }); const { agent } = await ctx.sessionController.resolveAgent(primary);
  const prompt = async (answers, text = '这是当前问题。', target = agent, origin) => {
    const start = [...target.session.ownEvents()].at(-1)?.seq ?? -1, before = wires.length;
    const requestId = randomUUID(); if (origin) ctx.personaLife.stateBoard.annotateInput(target, requestId, origin);
    queue.push(...answers); await ctx.sessionController.prompt({ sessionId: target.session.id, requestId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal);
    await target.whenIdle(); await ctx.sessions.flush(target.session); const events = [...target.session.ownEvents()].filter(e => e.seq > start);
    assert.equal(events.findLast(e => e.type === 'turn/end')?.data.reason.kind, 'completed', JSON.stringify(events.filter(e => ['turn/end', 'tool/result'].includes(e.type)))); assert.equal(queue.length, 0);
    return { events, wires: wires.slice(before), boards: events.filter(e => e.type === 'system/message' && e.data.message.source.producer === 'digital-life-state-board').map(e => e.data.message.source.board) };
  };
  const first = await prompt([{ text: '现在确实是当前真实时间。' }], '历史旧时间09:00不应当作现在。');
  assert(Math.abs(first.boards[0].facts.now - Date.now()) < 10000); assert.equal(first.wires[0].output_config.effort, 'low');
  assert.equal(first.boards.length, 1, 'Normal requests should receive one short board, not duplicate boundary boards');
  const boardWire = first.wires[0].messages.flatMap(m => m.content.filter(c => c.type === 'text').map(c => ({ role: m.role, text: c.text }))).find(c => c.text.includes('[DIGITAL_LIFE_STATE]'));
  assert(boardWire, JSON.stringify({ systemHasBoard: first.wires[0].system?.includes('[DIGITAL_LIFE_STATE]'), messages: first.wires[0].messages.map(m => ({role:m.role, types:m.content.map(c=>c.type), last:m.content.at(-1)?.text?.slice(0,150)})) }));
  assert.equal(boardWire.role, 'system'); assert(!first.wires[0].system.includes('[DIGITAL_LIFE_STATE]'));
  cases.A = { passed: true, actualCurrentTime: true, realSystemWireInput: true, largeStablePrefixUnchanged: true };
  assert.equal(first.boards[0].facts.input.sender, 'unknown');
  assert.equal(inputIdentity({ source: { kind: 'schedule' } }).type, 'schedule_wake');
  assert.equal(inputIdentity({ source: { kind: 'user', rpcId: 'resident:2026' } }).type, 'resident_wake');
  assert.equal(inputIdentity({ source: { kind: 'subagent-settled' } }).sender, 'child_agent');
  cases.B = { passed: true, nativeIngressSenderUnknownWithoutTrustedIdentity: true, scheduleAndResidentAndChildDistinct: true };
  const setA = await prompt([{ name: 'digital_life_state_update', args: { activity: '活动 A' } }, { text: 'A已设定。' }], '隔离测试', agent,
    {sender:'codex',sourceType:'test_harness',channel:'isolated acceptance',reason:'functional test'});
  assert.equal(setA.boards[0].facts.input.sender,'codex'); assert.equal(setA.boards[0].facts.input.type,'test_harness');
  cases.B.trustedExactRequestAnnotation = true;
  // Actual native continuable child + relay + settlement admission, not a
  // fabricated kind containing the word child. Hold its model reply while the
  // adjacent-Agent relay gets a separate real request in the parent.
  let releaseChild; childGate = new Promise(resolve => { releaseChild = resolve; });
  const child = await ctx.subagents.startContinuable({ provider: 'spawn', label: '状态板原生来源隔离验收',
    request: { parent: agent, prompt: [{ type: 'text', text: '只结束一次来源测试。' }] }, signal: AbortSignal.timeout(30000) });
  const childAgent = ctx.agents.get(child.childId); assert(childAgent);
  const sourceStart = [...agent.session.ownEvents()].at(-1).seq;
  queue.push({ text: '确认这是其他Agent的原生消息。' });
  await ctx.subagents.sendMessage(childAgent, primary, [{ type: 'text', text: '真实相邻Agent消息；正文不决定身份。' }], { signal: AbortSignal.timeout(30000) });
  await agent.whenIdle(); await ctx.sessions.flush(agent.session);
  const relayBoard = [...agent.session.ownEvents()].filter(e => e.seq > sourceStart && e.type === 'system/message' && e.data.message.source.producer === 'digital-life-state-board').at(-1).data.message.source.board;
  assert.equal(relayBoard.facts.input.type, 'agent_message'); assert.equal(relayBoard.facts.input.senderSessionId, child.childId);
  queue.push({ text: '确认子Agent真实结束通知。' }); releaseChild();
  const deadline = Date.now() + 10000;
  while (queue.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  await agent.whenIdle(); await ctx.sessions.flush(agent.session); assert.equal(queue.length, 0);
  const settledBoard = [...agent.session.ownEvents()].filter(e => e.seq > sourceStart && e.type === 'system/message' && e.data.message.source.producer === 'digital-life-state-board').at(-1).data.message.source.board;
  assert.equal(settledBoard.facts.input.type, 'child_result'); assert.equal(settledBoard.facts.input.senderSessionId, child.childId);
  cases.B.actualNativeRelayAndChildSettlement = { passed: true, childSessionId: child.childId };
  childGate = null;
  const timeA = setA.boards.at(-1).self.activityStartedAt;
  const raised = await prompt([{ name: 'digital_life_state_update', provisional: true, args: { activity: '活动 B', desired_reasoning_effort: 'high', reason: '当前问题较复杂' } }, { text: '高档正式答案。' }], 'SAME_CURRENT_COMPLEX_INPUT');
  assert.deepEqual(raised.wires.map(w => w.output_config.effort), ['low', 'high']);
  assert.equal(raised.boards.at(-1).self.activity, '活动 B'); assert.notEqual(raised.boards.at(-1).self.activityStartedAt, timeA);
  assert.equal(raised.boards.at(-1).facts.actualEffort, 'high');
  assert(raised.events.some(e => e.type === 'user/message' && e.data.source?.kind === 'digital-life-state-reentry'));
  assert(stateChanges(raised.events).some(change => change.provisional?.withheldTextCharacters === 'LOW_PARTIAL_MUST_NOT_ESCAPE'.length));
  assert(!raised.events.some(e => e.type === 'assistant/message' && JSON.stringify(e.data.message.content).includes('LOW_PARTIAL_MUST_NOT_ESCAPE')));
  assert(raised.wires[1].messages.some(m => m.content.some(c => c.type === 'text' && c.text.includes('SAME_CURRENT_COMPLEX_INPUT'))));
  cases.C = { passed: true, activityChangeVisible: true, activityTimeRuntimeOwned: true };
  cases.D = { passed: true, actualProviderEfforts: raised.boards[0].facts.supportedEfforts, wireTransition: ['low', 'high'] };
  cases.E = { passed: true, sameNativeTurn: raised.events.filter(e => e.type === 'turn/start').length === 1, sameCurrentInputReentered: true, provisionalSuppressionHookRan: true };
  const continued = await prompt([{ text: '活动与档位保持。' }]); assert.equal(continued.boards[0].self.activity, '活动 B'); assert.equal(continued.wires[0].output_config.effort, 'high');
  const low = await prompt([{ name: 'digital_life_state_update', args: { desired_reasoning_effort: 'low' } }, { text: '接下来用低档。' }]);
  assert.deepEqual(low.wires.map(w => w.output_config.effort), ['high', 'low']); assert(!low.events.some(e => e.data.source?.kind === 'digital-life-state-reentry'));
  cases.F = { passed: true, sustainedAcrossTurns: true, downgradeNextRequestWithoutReentry: true };
  const immutable = await prompt([{ name: 'digital_life_state_update', args: { current_time: 'fake09:00' } }, { text: '事实字段被拒绝。' }]);
  assert(immutable.events.some(e => e.type === 'tool/result' && e.data.message.isError)); assert.equal(ctx.personaLife.stateBoard.get(agent).activity, '活动 B');
  cases.ownership = { passed: true, objectiveMutationRejected: true, provenanceNativeSessionAndCall: true };
  const removeLateOverride = ctx.on('agent/request', async (request, next) => {
    const proposed = await next();
    return ctx.llm.resolveCallConfig({ ...proposed, reasoningEffort: 'off' }, request.signal);
  }, { prepend: true });
  const finalBoundary = await prompt([{ name: 'digital_life_state_read', args: {} }, { text: '最终请求仍看见真实档位。' }]);
  removeLateOverride();
  assert.equal(finalBoundary.wires[0].output_config?.effort ?? 'off', 'off');
  assert.equal(finalBoundary.boards.at(-1).facts.actualEffort, 'off');
  assert(finalBoundary.boards.at(-1).facts.mismatch);
  const finalRead = finalBoundary.events.find(event => event.type === 'tool/result' && !event.data.message.isError);
  assert.equal(JSON.parse(finalRead.data.message.content[0].text).facts.actualEffort, 'off');
  assert(finalBoundary.wires[0].messages.some(message => message.role === 'system' && message.content.some(block => block.type === 'text' && block.text.includes('[DIGITAL_LIFE_STATE]'))));
  cases.finalRequestBoundary = { passed: true, nativeRequestOverridePreservesBoard: true, actualLateEffortVisible: true, readToolActualEffortMatches: true, explicitMismatch: true };
  if (ctx.personaRecovery) {
    await ctx.personaRecovery.command({ action: 'set_mode', mode: 'light', reason: '独立状态板恢复兼容测试' });
    const light = await prompt([{ text: '轻量上下文仍包含当前状态。' }]);
    await ctx.personaRecovery.command({ action: 'set_mode', mode: 'normal', reason: '兼容测试结束' });
    assert.equal(light.wires.length, 1, 'Restoring the board must not create an extra paid model forward');
    assert(light.wires[0].messages.some(message => message.role === 'system' && message.content.some(block => block.type === 'text' && block.text.includes('[DIGITAL_LIFE_STATE]'))));
    assert.equal(light.boards.at(-1).facts.actualEffort, light.wires[0].output_config?.effort ?? 'off');
    cases.recoveryCompatibility = { passed: true, actualLightModeWireContainsBoard: true, modelForwards: 1, immutableNativeRequestPreserved: true };
  }
  await ctx.personaLife.store.configure({ residentEnabled: true });
  const wakeAt = new Date(Date.now() + 3600000).toISOString();
  const resident = await prompt([{ text: '活动结束。' }, { name: 'digital_life_state_update', args: { activity: '休息', resident_state: 'sleeping', next_self_wake: wakeAt, reason: '自己希望以后再醒' } }, { name: 'life_rest' }]);
  assert(resident.boards.some(b => b.facts.phase === 'Resident Decision')); assert(resident.boards.at(-1).facts.nextSelfWake); assert.equal(resident.boards.at(-1).self.resident_state, 'sleeping');
  cases.G = { passed: true, residentDecisionVisible: true, selfSleepingAndNativeWake: true };
  assert.equal(first.wires[0].system, raised.wires[0].system); cases.H = { passed: true, stableSystemPrefixByteEqual: true, realCacheTest: 'see live validation, no cache claim from offline transport' };
  await ctx.agentPresets.register({ id: 'standard', name: 'Standard', plugins: [] }); const standardId = randomUUID();
  await ctx.sessionController.create({ sessionId: standardId, cwd: workspace }); const { agent: standard } = await ctx.sessionController.resolveAgent(standardId);
  await ctx.agentPresets.select(standard, 'standard'); const ordinary = await prompt([{ text: '普通Agent。' }], '普通问题', standard); assert.equal(ordinary.boards.length, 0);
  assert(!standard.ctx.tools.schemas(standard).some(t => t.name === 'digital_life_state_update')); cases.I = { passed: true, standardUnchanged: true };
  const report = { passed: true, observedAt: new Date().toISOString(), root, sessionId: primary, cases, paidModelCalls: 0 };
  await writeFile(resolve(root, 'result.json'), JSON.stringify(report, null, 2)); await writeFile(resolve(base, 'reports/state-board/offline-validation.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await ctx.fiber.dispose(); }
