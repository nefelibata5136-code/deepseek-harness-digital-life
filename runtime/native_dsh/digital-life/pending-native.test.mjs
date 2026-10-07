import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DigitalLifeStore } from './store.mjs';
import { apply } from './plugin.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-pending-native-'));
  t.after(async () => {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert(path.basename(root).startsWith('persona-pending-native-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = await new DigitalLifeStore(root).init();
  return { root, store };
}
const row = (id, extra = {}) => ({ id, kind: 'activity', sourceSessionId: 'activity', turn: 4, seq: 12,
  text: 'Retained original proposal', occurredAt: null, ...extra });

test('explicit posts remain visible and Agent decisions survive reopen', async t => {
  const { root, store } = await fixture(t);
  await store.appendPending(row('post:activity:call-1'));
  assert.equal((await store.listPending()).total, 1);
  await store.resolvePending({ id: 'post:activity:call-1', decision: 'defer', sessionId: 'seat', callId: 'decision-1' });
  const reopened = await new DigitalLifeStore(root).init();
  assert.equal((await reopened.listPending()).items[0].resolution.decision, 'deferred');
  assert.equal((await reopened.listPending()).items[0].legacy_generated, undefined);
});

test('legacy automatic rows remain exact on disk and explicitly queryable without new attention', async t => {
  const { root, store } = await fixture(t);
  await store.appendPending(row('session:activity:turn:4'));
  await store.appendPending(row('codex:activity:tool-call'));
  await store.appendPending(row('post:activity:explicit'));
  await store.resolvePending({ id: 'session:activity:turn:4', decision: 'accept', sessionId: 'seat', callId: 'old-decision' });
  const before = await Promise.all(['pending.jsonl', 'decisions.jsonl'].map(name => fs.readFile(path.join(root, name))));
  const reopened = await new DigitalLifeStore(root).init();
  assert.deepEqual((await reopened.listPending()).items.map(x => x.id), ['post:activity:explicit']);
  assert.equal((await reopened.listPending({ includeLegacy: true })).total, 2);
  const all = await reopened.listPending({ includeLegacy: true, includeResolved: true });
  assert.equal(all.total, 3);
  assert.equal(all.items[0].resolution.decision, 'accepted');
  assert.equal(all.items[0].legacy_generated, true);
  assert.equal(all.items[0].sourceUnverified, true);
  assert.equal((await reopened.status()).legacyGeneratedCount, 2);
  assert.equal((await reopened.status()).pendingCount, 1);
  const after = await Promise.all(['pending.jsonl', 'decisions.jsonl'].map(name => fs.readFile(path.join(root, name))));
  assert.deepEqual(after, before);
});

test('legacy classification requires actual generated identity pattern', async t => {
  const { store } = await fixture(t);
  await store.appendPending(row('session:different:turn:4'));
  await store.appendPending(row('codex:different:call'));
  assert.equal((await store.listPending()).total, 2);
});

async function pluginFixture(t, { freshClock = false } = {}) {
  const { root, store } = await fixture(t);
  const primary = 'seat';
  const workspace = path.join(root, 'workspace');
  const lastWakeAt = '2026-10-07T01:00:00.000Z';
  const nextWakeAt = '2099-01-01T00:00:00.000Z';
  if (!freshClock) await store.saveClock({ lastWakeAt, nextWakeAt, lastOutcome: 'rest' });
  const oldPrimary = process.env.DL_SESSION_ID;
  process.env.DL_SESSION_ID = primary;
  t.after(() => { if (oldPrimary === undefined) delete process.env.DL_SESSION_ID; else process.env.DL_SESSION_ID = oldPrimary; });
  const handlers = new Map(), tools = new Map(), effects = [];
  const history = Object.freeze([
    Object.freeze({ seq: 12, type: 'turn/start', time: Date.parse(lastWakeAt), data: Object.freeze({ turn: 4 }) }),
    Object.freeze({ seq: 13, type: 'turn/end', time: Date.parse(lastWakeAt) + 1000, data: Object.freeze({ turn: 4, reason: { kind: 'completed' } }) })
  ]);
  const reads = [];
  const ctx = {
    fs: { writeText: async () => {}, editText: async () => {}, processPath: p => p },
    workspaceFoundation: { files: { mode: 'read-only' } },
    agents: { currentInitiator: () => null, withInitiator: (_agent, next) => next() },
    tools: { guard() {}, register(tool) { tools.set(tool.name, tool); }, schemas: () => [] },
    systemPrompt: { section() {} },
    personaTasks: { running: () => [], allRecords: async () => {
      assert(freshClock, 'restored startup must not list Session corpus');
      return [{ header: { id: primary } }, { header: { id: 'seeded-child', isSeeded: true } }];
    } },
    sessionQuery: { readSession: async id => {
      reads.push(id); assert.equal(id, primary, 'startup must never copy a child inherited history');
      return { session: { id }, events: history, inheritedEventCount: 0 };
    } },
    sessionController: { resolveAgent: async () => { throw Error('no model wake allowed'); } },
    personaHost: { status: async () => { throw Error('no budget/model work on startup'); } },
    get(name) { return this[name]; }, provide(name, value) { this[name] = value; },
    on(name, fn) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    effect(fn) { effects.push(fn); }
  };
  t.after(async () => { for (const effect of effects.reverse()) await effect()?.(); });
  await apply(ctx, { root, workspace, pollMs: 3600000 });
  return { ctx, tools, handlers, history, reads, workspace, lastWakeAt, nextWakeAt };
}

test('restored startup delegates recovery without reading any native history or adding inherited inputs', async t => {
  const { ctx, history, reads, lastWakeAt, nextWakeAt } = await pluginFixture(t);
  assert.deepEqual(await ctx.personaLife.recover(), { delegated: 'native-session-task-continuation', automaticReplay: false,
    legacyRecordsRetained: true, legacyListing: { tool: 'life_pending_list', includeLegacy: true } });
  assert.deepEqual(reads, []);
  assert.equal((await ctx.personaLife.store.listPending({ includeLegacy: true })).total, 0);
  assert.equal((await ctx.personaLife.store.state()).clock.lastWakeAt, lastWakeAt);
  assert.equal((await ctx.personaLife.store.state()).clock.nextWakeAt, nextWakeAt);
  assert.equal(history[0].seq, 12);
  assert.equal(history[1].type, 'turn/end');
});

test('fresh clock reads only primary native facts and never creates child output mirror', async t => {
  const { ctx, reads, lastWakeAt } = await pluginFixture(t, { freshClock: true });
  assert.deepEqual(reads, ['seat']);
  assert.equal((await ctx.personaLife.store.state()).clock.lastWakeAt, lastWakeAt);
  assert.equal((await ctx.personaLife.store.state()).clock.lastOutcome, 'completed');
  assert.equal((await ctx.personaLife.store.listPending({ includeLegacy: true })).total, 0);
});

test('native child output and tool result stay native, explicit post works, primary clock still settles', async t => {
  const { ctx, tools, handlers, workspace } = await pluginFixture(t);
  const child = { id: 'child', header: { cwd: workspace }, ownEvents() { throw Error('must not inspect child outputs'); } };
  const ended = { type: 'turn/end', time: Date.parse('2026-10-07T02:00:00Z'), data: { turn: 1, reason: { kind: 'completed' } } };
  for (const handler of handlers.get('session/event')) handler(child, ended);
  const result = Object.freeze({ output: 'native result is retained by the caller' });
  const returned = await handlers.get('tools/execute')[0]({ name: 'subagent_codex', callId: 'tool-call', agent: { session: { id: 'seat', header: { cwd: workspace } } } }, async () => result);
  assert.equal(returned, result);
  assert.equal((await ctx.personaLife.store.listPending({ includeLegacy: true })).total, 0);
  assert.equal(tools.get('life_pending_list').parameters.properties.includeLegacy.type, 'boolean');
  await tools.get('life_pending_post').execute({ text: 'I choose to post this advice.' }, { callId: 'explicit', agent: { session: child } });
  assert.equal((await ctx.personaLife.store.listPending()).items[0].id, 'post:child:explicit');
  const primary = { id: 'seat', header: { cwd: workspace } };
  for (const handler of handlers.get('session/event')) handler(primary, ended);
  await new Promise(resolve => setImmediate(resolve));
  const state = await ctx.personaLife.store.state();
  assert.equal(state.clock.lastRestAt, '2026-10-07T02:00:00.000Z');
  assert.equal(state.clock.lastOutcome, 'rest');
  ctx.personaLife.assertHealthy();
});
