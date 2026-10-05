import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DigitalLifeStore } from './store.mjs';

async function fixture(t, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-life-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new DigitalLifeStore(root, options).init();
  return { root, store };
}
const proposal = (id, text = 'A separately retained thought') => ({ id, text, kind: 'activity', sourceSessionId: 'hand-1', turn: 4, seq: 2, occurredAt: null });

test('idle first boot is valid; clock survives downtime without invented work', async (t) => {
  const { root, store } = await fixture(t);
  const initial = await store.state();
  assert.equal(initial.identity, 'persona');
  assert.equal(initial.settings.residentEnabled, false);
  assert.equal(initial.clock.nextWakeAt, null);
  await store.saveClock({ lastWakeAt: '2026-10-05T01:00:00Z', nextWakeAt: '2026-10-05T03:00:00Z', lastRestAt: '2026-10-05T01:00:01Z', lastOutcome: 'rest' });
  const restored = await new DigitalLifeStore(root).init();
  assert.equal((await restored.state()).clock.lastWakeAt, '2026-10-05T01:00:00.000Z');
  assert.equal((await restored.status()).pendingCount, 0);
  await assert.rejects(store.saveClock({ identity: 'persona2' }), /clock field/);
});

test('configuration is validated, versioned and recovered from its journal', async (t) => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.configure({ intervalMs: 59999 }), /intervalMs/);
  await assert.rejects(store.configure({ identity: 'other' }), /Unknown setting/);
  await Promise.all([store.configure({ residentEnabled: true }), store.configure({ directive: 'Rest is allowed.' })]);
  const restored = await new DigitalLifeStore(root).init();
  assert.deepEqual(await restored.settings(), { residentEnabled: true, intervalMs: 7200000, directive: 'Rest is allowed.', version: 2,
    intentionSamplingEnabled: false, intentionSamplingConsent: null });
  assert.equal((await fs.readFile(path.join(root, 'settings-history.jsonl'), 'utf8')).trim().split('\n').length, 2);
});

test('mental state is explicit, separately stored, expires and has no history', async (t) => {
  let now = Date.parse('2026-10-05T00:00:00Z');
  const { root, store } = await fixture(t, { now: () => now });
  assert.equal(await store.readMental(), null);
  await assert.rejects(store.writeMental({ text: 'Invented for her' }), /sessionId/);
  await store.writeMental({ text: 'I am still thinking about the town.', expiresAt: '2026-10-05T01:00:00Z', sessionId: 'seat', callId: 'mental-1' });
  assert.equal((await store.readMental()).sessionId, 'seat');
  assert.equal(JSON.stringify(await store.state()).includes('town'), false);
  assert.equal(JSON.stringify(await store.status()).includes('town'), false);
  now = Date.parse('2026-10-05T01:00:00Z');
  assert.equal(await store.readMental(), null);
  await store.writeMental({ text: '', sessionId: 'seat', callId: 'mental-2' });
  assert.equal(await new DigitalLifeStore(root).init().then((item) => item.readMental()), null);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('mental')), ['mental.json']);
  assert.equal((await store.status()).totalExperiences, 0);
});

test('parallel proposals remain distinct, paginate explicitly and retain decisions', async (t) => {
  const { root, store } = await fixture(t);
  await Promise.all([store.appendPending(proposal('a', 'A')), store.appendPending({ ...proposal('b', 'B'), kind: 'subagent' }), store.appendPending(proposal('c', 'C'))]);
  assert.equal((await store.appendPending(proposal('a', 'A'))).text, 'A');
  await assert.rejects(store.appendPending(proposal('a', 'different')), /ID conflict/);
  const first = await store.listPending({ limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ['a', 'b']);
  assert.equal(first.hasMore, true);
  assert.equal(first.total, 3);
  assert.deepEqual((await store.listPending({ offset: 2, limit: 2 })).items.map((item) => item.id), ['c']);
  await store.resolvePending({ id: 'a', decision: 'defer', sessionId: 'seat', callId: 'decision-1' });
  await store.resolvePending({ id: 'a', decision: 'accept', note: 'Keep this.', sessionId: 'seat', callId: 'decision-2' });
  await store.resolvePending({ id: 'a', decision: 'accept', note: 'Keep this.', sessionId: 'seat', callId: 'decision-2' });
  assert.equal((await store.status()).decisionsCount, 2);
  assert.equal((await store.listPending()).total, 2);
  assert.equal((await store.listPending({ includeResolved: true })).total, 3);
  const restored = await new DigitalLifeStore(root).init();
  assert.equal((await restored.listPending({ includeResolved: true })).items[0].resolution.decision, 'accepted');
  assert.equal((await fs.readFile(path.join(root, 'pending.jsonl'), 'utf8')).trim().split('\n').length, 3);
  assert.equal((await fs.readFile(path.join(root, 'decisions.jsonl'), 'utf8')).trim().split('\n').length, 2);
  assert.equal(await restored.readMental(), null);
});

test('torn journal tails fail loudly while preserving the entire file', async (t) => {
  const { root, store } = await fixture(t);
  await store.appendPending(proposal('a'));
  const target = path.join(root, 'pending.jsonl');
  await fs.appendFile(target, '{"id":"torn');
  const before = await fs.readFile(target, 'utf8');
  await assert.rejects(new DigitalLifeStore(root).init(), /incomplete journal tail.*retained/);
  assert.equal(await fs.readFile(target, 'utf8'), before);
});

test('corrupt complete journal records fail loudly and do not erase valid experiences', async (t) => {
  const { root, store } = await fixture(t);
  await store.appendPending(proposal('a'));
  const target = path.join(root, 'pending.jsonl');
  await fs.appendFile(target, 'not-json\n');
  const before = await fs.readFile(target, 'utf8');
  await assert.rejects(new DigitalLifeStore(root).init(), /corrupt journal record 2.*retained/);
  assert.equal(await fs.readFile(target, 'utf8'), before);
});
