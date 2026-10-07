// Verify the durable native A–G run after holders have disposed their children.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const base = resolve(import.meta.dirname, '../../..'), root = resolve(process.argv[2]);
assert(root.startsWith(resolve(base, 'reports/intention-sampling')));
const files = await readdir(resolve(root, 'sessions'), { recursive: true });
const sessions = await Promise.all(files.filter(f => f.endsWith('session.v4.jsonl')).map(async f => {
  const records = (await readFile(resolve(root, 'sessions', f), 'utf8')).trim().split('\n').map(JSON.parse);
  return { header: records[0], events: records.slice(1) };
}));
const primary = sessions.find(s => !s.header.origin); assert(primary);
const turns = primary.events.filter(e => e.type === 'turn/start'); assert.equal(turns.length, 8);
const batches = primary.events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'resident-attention').map(e => ({
  turn: turns.findLast(t => t.seq < e.seq).data.turn,
  result: JSON.parse(e.data.content[0].text.split('[八次独立意向展开｜思考草稿]\n')[1].split('\n[/八次独立意向展开]')[0]) }));
assert.equal(batches.length, 9);
for (const { result: b } of batches) {
  assert.equal(b.completed, 8); assert(b.parallel); assert(b.raw.every(s => s.internalReviewed));
  assert.equal(new Set(b.raw.map(s => s.sameSourceSha256)).size, 1);
}
assert(batches.find(b => b.turn === 2).result.groups.some(g => g.frequency === '7/8'));
assert.equal(batches.find(b => b.turn === 3).result.groups.length, 8);
assert.equal(batches.find(b => b.turn === 4).result.noIntention.count, 6);
for (const [turn, word] of [[5, '少数'], [6, '第九']]) assert(primary.events.some(e => e.type === 'user/message'
  && e.data.source?.kind === 'resident-continuation' && e.data.content[0].text.includes(word)
  && turns.findLast(t => t.seq < e.seq).data.turn === turn));
assert.equal(batches.find(b => b.turn === 7).result.noIntention.count, 8);
assert(primary.events.some(e => e.type === 'tool/call' && e.data.name === 'life_rest' && e.data.arguments.includes('nextWakeAt')));
assert(primary.events.filter(e => e.type === 'turn/end').every(e => e.data.reason.kind === 'completed'));
const children = sessions.filter(s => s.header.origin === 'subagent'); assert.equal(children.length, 72);
for (const child of children) {
  assert(child.events.some(e => e.type === 'subagent/descriptor' && e.data.provider === 'persona-intention'));
  const names = child.events.find(e => e.type === 'request/header').data.header.tools.map(t => t.name);
  assert(!names.some(n => ['terminal', 'write', 'subagent', 'life_mental_write', 'life_rest', 'schedule_create', 'send_message'].includes(n)));
  assert(child.events.some(e => e.type === 'tool/call' && e.data.name === 'intention_internal_read'));
}
let pending = ''; try { pending = await readFile(resolve(root, 'digital-life/pending.jsonl'), 'utf8'); } catch (e) { if(e.code !== 'ENOENT') throw e; }
assert.equal(pending.trim(), '');
const sources = ['resident.mjs', 'intention.mjs', 'plugin.mjs', 'store.mjs', 'verify-intention.mjs', 'replay-intention.mjs'];
const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async f => ['runtime/native_dsh/digital-life/' + f,
  createHash('sha256').update(await readFile(resolve(import.meta.dirname, f))).digest('hex')])));
const report = { passed: true, observedAt: new Date().toISOString(), root, sessionId: primary.header.id, paidModelCalls: 0,
  transport: 'deterministic responses, real installed native children; durable post-disposal trace replay',
  cases: { A: { nativeChildren: 8, parallel: true, sameSource: true, repeat: '7/8', mainRejectsAll: true }, B: { diverse: 8 },
    C: { noIntention: '6/8' }, D: { mainChoseMinority: true }, E: { mainCreatedNinthIdea: true }, F: { noIntention: '8/8', rested: true },
    G: { nativeSelfSchedule: true }, isolation: { children: 72, noWriterTools: true, pendingDrafts: 0 } }, sourceSha256 };
await writeFile(resolve(root, 'result.json'), JSON.stringify(report, null, 2)); await writeFile(resolve(base, 'reports/intention-sampling/offline-validation.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, root, cases: report.cases }));
