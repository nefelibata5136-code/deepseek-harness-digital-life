import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootNative, here } from '../boot-native.mjs';
import { fixtureTransport } from '../fixture-transport.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { childSessionMeta, applyChildComposition, resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent';
import { desktopTools } from '../computer-host.mjs';
import { parse } from 'yaml';
const profileRows = parse(await readFile(resolve(here, 'home/profiles/persona/cordis.patch.yml'), 'utf8')).flatMap(row => row.insert ?? []);
const legacyOverlays = root => [
  { id: 'persona-digital-life', config: { ...profileRows.find(row => row.id === 'persona-digital-life').config,
    secondaryFullAccess: false, workspace: resolve(root, 'workspace'), root: resolve(root, 'digital-life') } },
  { id: 'workspace-foundation', config: { ...profileRows.find(row => row.id === 'workspace-foundation').config,
    fullAccess: false, workspace: resolve(root, 'workspace'), store: resolve(root, 'versions'), readRoots: [root] } },
];
if (process.argv[2] === '--resume') {
  const root = process.argv[3], primary = process.argv[4], before = JSON.parse(process.argv[5]);
  process.env.DEEPSEEK_API_KEY = 'offline-placeholder-not-a-secret';
  const fake = fixtureTransport(resolve(root, 'workspace'), { startAt: 3 }); globalThis.fetch = fake.transport;
  const ctx = await bootNative({ sessionId: primary, testRoot: root,
    overlays: legacyOverlays(root) });
  try {
    assert.equal((await ctx.personaLife.store.state()).clock.lastWakeAt, before.clock.lastWakeAt);
    assert.equal((await ctx.personaLife.store.listPending()).items.length, before.pendingCount);
    await ctx.personaLife.store.configure({ residentEnabled: true });
    await ctx.personaLife.store.saveClock({ nextWakeAt: new Date(Date.now() - 3600000).toISOString() });
    const { agent } = await ctx.sessionController.resolveAgent(primary);
    await ctx.personaLife.tick(); await agent.whenIdle();
    assert.equal(fake.count(), 4, 'One eye-opening, no backlog jobs or forced actions');
    assert((await ctx.personaLife.store.state()).clock.lastWakeAt > before.clock.lastWakeAt);
    ctx.personaLife.assertHealthy();
    console.log(JSON.stringify({ passed: true, coldProcessRecovery: true, singleQuietWake: true, paidModelCalls: 0 }));
  } finally { await ctx.fiber.dispose(); }
  process.exit(0);
}
const root = resolve(here, '../../reports/task_A/digital-life-' + randomUUID());
const workspace = resolve(root, 'workspace');
await mkdir(resolve(workspace, 'memory/cards'), { recursive: true });
await writeFile(resolve(workspace, 'persona-core.md'), '# One original identity\n');
await writeFile(resolve(workspace, 'AGENTS.md'), '# Fixture only\n');
await writeFile(resolve(workspace, 'memory/continuity.md'), 'Working marker: paused midway.');
await writeFile(resolve(workspace, 'memory/cards/one.md'), 'Original historical statement.');
await writeFile(resolve(workspace, 'audit.txt'), 'before\n');
process.env.DEEPSEEK_API_KEY = 'offline-placeholder-not-a-secret';
const fake = fixtureTransport(workspace);
let authored = false;
const authorSource = fixtureTransport(workspace);
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const text = JSON.stringify(body.messages);
  if (text.includes('native-author-mental') && !authored) {
    const template = await authorSource.transport(url, init);
    const data = (await template.text()).split('\n').map(line => {
      if (!line.startsWith('data: ')) return line;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'content_block_start') event.content_block.name = 'life_mental_write';
      if (event.type === 'content_block_delta') event.delta.partial_json = JSON.stringify({ text: 'Own mental marker.' });
      return 'data: ' + JSON.stringify(event);
    }).join('\n');
    authored = true;
    return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (text.includes('native-author-mental') && authored && !text.includes('Offline fixture transport validation.')) {
    return fixtureTransport(workspace, { startAt: 2 }).transport(url, init);
  }
  return fake.transport(url, init);
};
const primary = randomUUID();
const sources = ['boot-native.mjs', 'native-host.mjs', 'persona-plugin.mjs', 'task-host.mjs', 'persona-compaction.mjs',
  'fixture-transport.mjs', 'computer-host.mjs', 'home/profiles/persona/cordis.patch.yml', 'digital-life/plugin.mjs', 'digital-life/store.mjs', 'digital-life/codex-advisor.mjs'];
const hashes = () => Promise.all(sources.map(async name => ['runtime/native_dsh/' + name,
  createHash('sha256').update(await readFile(resolve(here, name))).digest('hex')]));
const initialHashes = Object.fromEntries(await hashes());
let ctx = await bootNative({ sessionId: primary, testRoot: root,
  overlays: legacyOverlays(root) });
const call = async (agent, name, args, error) => {
  const result = await agent.ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: new AbortController().signal });
  if (error) { assert(result.isError, JSON.stringify(result)); assert.match(JSON.stringify(result), error); }
  else assert(!result.isError, JSON.stringify(result));
  return result;
};
try {
  assert(ctx.personaLife, 'Mode lifecycle must actually activate');
  // Real native schema/guard paths, synthetic driver; never touch the desktop.
  for (const name of desktopTools) ctx.tools.register(defineTool({ name,
    description: 'Offline desktop permission fixture', parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: () => ({ fixture: true, name }) }));
  await ctx.sessionController.create({ sessionId: primary, cwd: workspace });
  const { agent: seat } = await ctx.sessionController.resolveAgent(primary);
  const id = (await ctx.personaTasks.create({ title: 'A parallel hand' })).sessionId;
  const { agent: hand } = await ctx.sessionController.resolveAgent(id);
  assert.equal(ctx.personaLife.isAuthority(seat), true);
  assert.equal(ctx.personaLife.isAuthority(hand), false);
  const schemas = hand.ctx.tools.schemas(hand).map(t => t.name);
  for (const absent of ['private_read', 'private_write', 'terminal', 'capability_search', 'life_mental_write', 'life_configure'])
    assert(!schemas.includes(absent), 'Activity exposed ' + absent);
  for (const name of desktopTools) {
    assert(schemas.includes(name), 'Activity missing desktop schema ' + name);
    const result = await call(hand, name, {});
    assert.equal(result.value.name, name, 'Activity desktop dispatch did not reach fixture');
  }
  const childHandle = await hand.ctx.agents.create({ sessionId: randomUUID(), parentAgent: hand,
    meta: childSessionMeta(hand, 1, false), agentOptions: resolveChildAgentOptions(hand, {}, 1),
    setup: childCtx => applyChildComposition(childCtx, hand, {}) });
  try {
    const child = childHandle.agent;
    const childSchemas = child.ctx.tools.schemas(child).map(t => t.name);
    for (const name of desktopTools) {
      assert(childSchemas.includes(name), 'Child missing desktop schema ' + name);
      await call(child, name, {});
    }
    for (const name of ['terminal', 'private_read', 'life_mental_write', 'life_configure'])
      assert(!childSchemas.includes(name), 'Child exposed ' + name);
  } finally { await childHandle.dispose(); }
  await call(hand, 'terminal', { command: 'echo fixture' }, /restricted|ACTIVITY|not found|not available|not allowed/i);
  await call(hand, 'write', { file_path: resolve(workspace, 'persona-core.md'), content: 'second identity' }, /CONSCIOUSNESS_SEAT_REQUIRED/);
  await call(hand, 'write', { file_path: workspace + '/work/../memory/cards/one.md', content: 'traversal' }, /CONSCIOUSNESS_SEAT_REQUIRED|Path|path/i);
  await symlink(resolve(workspace, 'memory'), resolve(workspace, 'ordinary-link'), 'junction');
  await call(hand, 'write', { file_path: resolve(workspace, 'ordinary-link/cards/one.md'), content: 'junction bypass' }, /Links|junction|alias/i);
  assert.equal(await readFile(resolve(workspace, 'memory/cards/one.md'), 'utf8'), 'Original historical statement.');
  await call(hand, 'write', { file_path: resolve(workspace, 'work.txt'), content: 'ordinary parallel work' });
  assert.equal(await readFile(resolve(workspace, 'work.txt'), 'utf8'), 'ordinary parallel work');
  await call(hand, 'life_mental_write', { text: 'forged first person' }, /restricted|ACTIVITY|not found|not available|not allowed/i);
  assert.equal(await ctx.personaLife.store.readMental(), null);
  await call(seat, 'life_mental_write', { text: 'system-forged mental' }, /MENTAL_REQUIRES_OWN_NATIVE_CALL/);
  await ctx.sessionController.prompt({ sessionId: primary, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'native-author-mental' }] }, new AbortController().signal);
  await seat.whenIdle();
  assert.equal((await ctx.personaLife.store.readMental()).sessionId, primary);
  await call(seat, 'write', { file_path: resolve(workspace, 'memory/cards/one.md'), content: 'erase history' }, /MEMORY_APPEND/);
  await call(seat, 'read', { file_path: resolve(workspace, 'memory/cards/one.md') });
  await call(seat, 'write', { file_path: resolve(workspace, 'memory/cards/one.md'), content: 'Original historical statement.\nCorrection preserved separately.' });
  await call(seat, 'life_working_write', { text: 'Working marker: one more step remains.' });
  await call(hand, 'life_pending_post', { text: 'Advice A: choose left.' });
  await call(hand, 'life_pending_post', { text: 'Advice B: choose right.' });
  const proposals = await ctx.personaLife.store.listPending();
  assert.equal(proposals.items.length, 2);
  assert.equal(await ctx.personaLife.store.readMental().then(m => m.text), 'Own mental marker.');
  await call(seat, 'life_pending_decide', { id: proposals.items[0].id, decision: 'deferred', note: 'Keep both distinct.' });
  await call(seat, 'life_rest', {});
  assert.equal((await ctx.personaLife.store.state()).clock.lastOutcome, 'rest');
  assert.equal(fake.count(), 0, 'Rest requires no model call');
  // Actual native loop: logged independent state snapshots and an activity result.
  const prompt = async (agent, text) => {
    await ctx.sessionController.prompt({ sessionId: agent.session.id, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' }, new AbortController().signal);
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
  };
  await prompt(seat, 'Offline fixture transport validation.');
  const wire = JSON.stringify(fake.wires[0]);
  for (const marker of ['One original identity', 'Working marker', 'Own mental marker', 'Advice A', 'Advice B']) assert(wire.includes(marker), marker);
  const contexts = [...seat.session.ownEvents()].filter(e => e.type === 'user/message').map(e => e.data.source?.sections?.[0]?.name);
  for (const name of ['persona:working-state', 'persona:mental-state', 'persona:time-continuity', 'persona:pending-advice']) assert(contexts.includes(name));
  const visibleStates = seat.session.surface.nodes.map(seq => seat.session.eventAt(seq))
    .filter(e => e?.type === 'user/message' && e.data.source?.kind === 'persona-state');
  assert.equal(visibleStates.length, 4, 'Only four distinct current snapshots survive, older raw evidence stays logged');
  assert([...seat.session.ownEvents()].some(e => e.type === 'user/message' && e.data.source?.kind === 'persona-state-retired'));
  await prompt(hand, 'Complete an offline activity.');
  assert.equal((await ctx.personaLife.store.listPending()).total, proposals.total,
    'Ordinary activity completion stays in native history; it does not author a pending input');
  const explicitAdvice = 'Offline integrated activity result: I choose to post this for continuation.';
  await call(hand, 'life_pending_post', { text: explicitAdvice });
  const advice = await ctx.personaLife.store.listPending();
  assert(advice.items.some(p => p.sourceSessionId === id && p.text === explicitAdvice));
  assert(!JSON.stringify(fake.wires.at(-1)).includes('Own mental marker'), 'Mental must not flow into activities');
  assert(!JSON.stringify(fake.wires.at(-1)).includes('One original identity'), 'Activity must not impersonate core');
  const before = await ctx.personaLife.store.state();
  await ctx.fiber.dispose();
  const restarted = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--resume', root, primary,
    JSON.stringify({ clock: before.clock, pendingCount: advice.items.length })], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
  assert.deepEqual(Object.fromEntries(await hashes()), initialHashes, 'Sources changed during validation');
  const report = { passed: true, observedAt: new Date().toISOString(), root, paidModelCalls: 0,
    sourceSha256: initialHashes,
    checks: ['official native preset and lifecycle', 'single authoritative seat', 'parallel work files',
      'activity core/mental/private/terminal/capability rejection', 'activity and native child expose and execute all 21 reviewed desktop tools (synthetic driver)', 'author-only mental', 'historical card corrections preserve original',
      'working/mental/advice/time snapshots logged separately', 'conflicting advice retained without fusion',
      'rest succeeds without a model call', 'activity advice survives restart without duplicate', 'downtime resumes one wake without catch-up loop'] };
  await writeFile(resolve(here, '../../reports/digital-life/runtime-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await ctx.fiber.dispose(); }
