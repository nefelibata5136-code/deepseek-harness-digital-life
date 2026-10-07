import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThreadPages } from './bundle/thread-pages.mjs';

test('cold-worker cursor retains every item beyond 30, exact URI/CID and unavailable placeholders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-thread-'));
  const anchor = 'at://did:plc:a/app.bsky.feed.post/root';
  let requests = 0;
  const raw = Array.from({ length: 151 }, (_, i) => ({ uri: anchor + i, depth: i ? 1 : 0,
    value: i === 34 ? { $type: 'blockedPost', blocked: true } : { post: { uri: anchor + i, cid: 'cid' + i }, moreReplies: 3 } }));
  const args = { root, normalizePost: p => p, rpc: async (method, a) => {
    requests++; assert.equal(method, 'app.bsky.unspecced.getPostThreadV2'); assert.equal(a.anchor, anchor);
    return { thread: raw, hasOtherReplies: true };
  } };
  try {
    const first = await createThreadPages(args)({ uri: anchor, limit: 30 });
    assert.equal(first.totalReturned, 151); assert.equal(first.items.length, 30);
    const second = await createThreadPages({ ...args, rpc: () => assert.fail('next page must not refetch') })({ uri: anchor, cursor: first.nextCursor, limit: 30 });
    assert.equal(second.items[0].number, 31); assert.equal(second.items[0].uri, raw[30].uri);
    assert.equal(second.items[0].value.post.cid, 'cid30'); assert.equal(second.items[4].value.blocked, true);
    let page = second; const all = [...first.items, ...second.items];
    while (page.nextCursor) { page = await createThreadPages(args)({ uri: anchor, cursor: page.nextCursor, limit: 30 }); all.push(...page.items); }
    assert.equal(all.length, 151); assert.equal(requests, 1); assert.equal(page.hasMoreSnapshotItems, false);
    await assert.rejects(createThreadPages(args)({ uri: anchor + 'different', cursor: first.nextCursor }), /ANCHOR_OR_MODE_CHANGED/);
    await assert.rejects(createThreadPages(args)({ uri: anchor, cursor: '../../secret:30' }), /CURSOR_REQUIRED/);
    const path = join(root, 'thread-' + first.snapshot_id + '.json');
    const saved = JSON.parse(await readFile(path, 'utf8')); saved.data.items[30].uri = 'changed';
    await writeFile(path, JSON.stringify(saved));
    await assert.rejects(createThreadPages(args)({ uri: anchor, cursor: first.nextCursor }), /BYTES_CHANGED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('other-reply snapshots use their own official view and cursor cannot cross modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-thread-'));
  try {
    const read = createThreadPages({ root, normalizePost: p => p, rpc: async (method, args) => {
      assert.equal(method, 'app.bsky.unspecced.getPostThreadOtherV2'); assert.deepEqual(args, { anchor: 'anchor' });
      return { thread: [{ uri: 'first', value: { notFound: true } }, { uri: 'second', value: { moreReplies: 8 } }] };
    } });
    const first = await read({ uri: 'anchor', mode: 'other_replies', limit: 1 });
    const second = await read({ uri: 'anchor', mode: 'other_replies', limit: 1, cursor: first.nextCursor });
    assert.equal(second.items[0].uri, 'second');
    await assert.rejects(read({ uri: 'anchor', mode: 'snapshot', cursor: first.nextCursor }), /ANCHOR_OR_MODE_CHANGED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
