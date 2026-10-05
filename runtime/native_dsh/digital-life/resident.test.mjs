import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { collectAttention, renderAttention } from './attention.mjs';

const fixtures = async fn => {
  const root = await mkdtemp(resolve(tmpdir(), 'resident-attention-'));
  await mkdir(resolve(root, 'memory')); await mkdir(resolve(root, 'development'));
  const input = { workspace: root, agent: { session: { id: 'primary', ownEvents: () => [] } },
    store: { listPending: async () => ({ total: 0, items: [] }) }, schedule: { list: async () => [] },
    tasks: { running: () => [], list: async () => [] } };
  try { await fn(input); } finally { await rm(root, { recursive: true }); }
};
test('honest empty list; missing files do not manufacture ideas', () => fixtures(async input => {
  const inbox = await collectAttention(input);
  assert.equal(inbox.empty, true); assert.deepEqual(inbox.candidates, []);
  assert(renderAttention(inbox).includes('当前没有特别需要注意的事项。'));
}));
test('unavailable data is distinct from empty; provenance and omissions remain explicit', () => fixtures(async input => {
  input.schedule.list = async () => { throw Object.assign(new Error('offline'), { code: 'EIO' }); };
  const inbox = await collectAttention(input);
  assert.equal(inbox.empty, false); assert.deepEqual(inbox.unavailable, [{ source: 'schedule', error: 'EIO' }]);
}));
test('original file excerpts, pending counts, actual schedules and active activities are fair and bounded', () => fixtures(async input => {
  await writeFile(resolve(input.workspace, 'memory/continuity.md'), '本人留下的接续条：' + '原文'.repeat(2000));
  await writeFile(resolve(input.workspace, 'development/wants.md'), '本人以后想看月亮。');
  input.store.listPending = async () => ({ total: 20, items: Array.from({ length: 12 }, (_, i) =>
    ({ id: `pending-${i}`, kind: 'subagent', sourceSessionId: `child-${i}`, text: '顾问原文', observedAt: null, occurredAt: null })) });
  input.schedule.list = async () => [{ id: 'wake-1', title: '本人设定的唤醒', scheduledAt: '2026-10-05T10:00:00Z' }];
  input.tasks.running = () => ['primary', 'running'];
  input.tasks.list = async () => [{ sessionId: 'primary', primary: true }, { sessionId: 'running', title: '正在运行' }, { sessionId: 'old', title: '已经结束' }];
  const inbox = await collectAttention({ ...input, maxBytes: 60 });
  assert.equal(inbox.knownTotal, 24); assert.equal(inbox.omitted, 12); assert.equal(inbox.candidates.length, 12);
  for (const kind of ['continuity', 'wants', 'schedule', 'running-activity', 'subagent'])
    assert(inbox.candidates.some(c => c.kind === kind), kind);
  const excerpt = inbox.candidates.find(c => c.kind === 'continuity');
  assert(excerpt.truncated); assert(excerpt.text.startsWith('本人留下')); assert(!excerpt.text.includes('\ufffd'));
  assert(inbox.candidates.every(c => c.source && c.reason));
  assert(!inbox.candidates.some(c => c.text === '已经结束'));
}));
test('only explicitly unfinished todos from current turn; historical or completed todos excluded', () => fixtures(async input => {
  input.agent.session.ownEvents = () => [
    { type: 'todo/write', seq: 1, data: { todos: [{ content: '旧任务', status: 'pending' }] }, time: 1 },
    { type: 'turn/start', seq: 2, data: { turn: 2 }, time: 2 },
    { type: 'todo/write', seq: 3, data: { todos: [{ content: '明确未完成', status: 'in_progress' }, { content: '已完成', status: 'completed' }] }, time: 3 } ];
  const inbox = await collectAttention(input);
  assert.equal(inbox.candidates.length, 1); assert.equal(inbox.candidates[0].text, '明确未完成');
  assert.equal(inbox.candidates[0].source, 'session:primary:seq:3');
}));
