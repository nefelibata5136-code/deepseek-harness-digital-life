import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtended, EXTENDED_TOOLS } from './extended.mjs';

// Behavioral fixtures test retry/permission boundaries only. They are explicitly
// not live Bluesky acceptance; root's native Persona session provides that evidence.
const ownDid = 'did:plc:persona';
const actorDid = 'did:plc:other';
const uri = `at://${actorDid}/app.bsky.feed.post/3mx3tbymzt4ft`;
const feedUri = `at://${actorDid}/app.bsky.feed.generator/science`;
function fixture() {
  const calls = [], records = new Map(), journals = new Map();
  let preferences = [{ $type: 'app.bsky.actor.defs#personalDetailsPref', birthDate: '2000-01-01T00:00:00Z' },
    { $type: 'app.bsky.actor.defs#futurePref', future: { unknown: true } }];
  let bookmark = false, committedWrites = 0, loseWrite = false, loseChatRead = false;
  const normalized = p => ({ uri: p.uri, cid: p.cid, author: p.author, text: p.record?.text });
  const currentPost = () => ({ uri, cid: 'post-cid', author: { did: actorDid }, record: { text: 'real-shaped fixture' }, viewer: { bookmarked: bookmark } });
  const transport = {
    ownDid, normalizeProfile: p => ({ did: p.did, handle: p.handle }), normalizePost: normalized,
    normalizeFeed: d => ({ posts: (d.feed ?? []).map(p => normalized(p.post)), cursor: d.cursor ?? null }),
    journalRead: async k => journals.get(k), journalWrite: async (k, v) => journals.set(k, structuredClone(v)),
    publicRpc: async (method, args, signal) => rpc(method, args, { signal }),
    authedRpc: async (method, args, opts = {}) => rpc(method, args, opts),
  };
  async function rpc(method, args, opts) {
    calls.push({ method, args: structuredClone(args), opts });
    if (method === 'app.bsky.actor.getPreferences') return { preferences: structuredClone(preferences) };
    if (method === 'app.bsky.actor.putPreferences') { preferences = structuredClone(args.preferences); return {}; }
    if (method === 'app.bsky.actor.getProfile') return { did: actorDid, handle: 'other.bsky.social', viewer: {} };
    if (method === 'app.bsky.feed.getPosts') return { posts: [currentPost()] };
    if (method === 'com.atproto.repo.getRecord') {
      const found = records.get(args.collection + '/' + args.rkey);
      if (!found) { const e = new Error('fixed-code'); e.code = 'RecordNotFound'; throw e; }
      return structuredClone(found);
    }
    if (method === 'com.atproto.repo.putRecord') {
      assert.equal(args.repo, ownDid); assert.equal(args.swapRecord, null);
      assert.match(args.rkey, /^[2-7a-z]{13}$/);
      committedWrites++;
      const record = structuredClone(args.record);
      // Model-independent server JSON order must not affect identity comparison.
      if (typeof record.subject === 'object') record.subject = { cid: record.subject.cid, uri: record.subject.uri };
      records.set(args.collection + '/' + args.rkey, { uri: `at://${ownDid}/${args.collection}/${args.rkey}`, cid: 'relation-cid', value: record });
      if (loseWrite) { loseWrite = false; const e = new Error('fixed-code'); e.code = 'WRITE_OUTCOME_UNKNOWN_READ_BEFORE_RETRY'; throw e; }
      return { uri: `at://${ownDid}/${args.collection}/${args.rkey}`, cid: 'relation-cid' };
    }
    if (method === 'com.atproto.repo.deleteRecord') { assert.equal(args.repo, ownDid); records.delete(args.collection + '/' + args.rkey); return {}; }
    if (method === 'app.bsky.bookmark.createBookmark') { assert.deepEqual(args, { uri, cid: 'post-cid' }); bookmark = true; return {}; }
    if (method === 'app.bsky.bookmark.deleteBookmark') { bookmark = false; return {}; }
    if (method === 'app.bsky.bookmark.getBookmarks') return { bookmarks: bookmark ? [{ subject: { uri, cid: 'post-cid' }, item: currentPost() }] : [] };
    if (method.startsWith('chat.')) {
      assert.deepEqual(opts.headers, { 'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat' });
      if (method === 'chat.bsky.convo.sendMessage') { committedWrites++; return { id: 'message-1', text: args.message.text, sender: { did: ownDid }, sentAt: new Date().toISOString() }; }
      if (method === 'chat.bsky.group.createGroup') { committedWrites++; return { convo: { id: 'group-1', members: args.members, kind: { $type: 'chat.bsky.convo.defs#groupConvo', name: args.name } } }; }
      if (method === 'chat.bsky.convo.getMessages') {
        if (loseChatRead) { const e = new Error('fixed-code'); e.code = 'BLUESKY_NETWORK_UNAVAILABLE'; throw e; }
        return { messages: [{ id: 'message-1', text: 'hello', sender: { did: ownDid } }, { $type: 'chat.bsky.convo.defs#systemMessageView', id: 'system-1' }] };
      }
      if (method === 'chat.bsky.convo.getConvoForMembers') return { convo: { id: 'direct-1', members: args.members } };
      if (method === 'chat.bsky.convo.getConvoAvailability') return { canChat: true };
      return { convos: [], messages: [], members: [], requests: [] };
    }
    if (method === 'app.bsky.feed.getFeedGenerator') return { view: { uri: feedUri, cid: 'feed-cid', creator: { did: actorDid }, displayName: 'Science' }, isOnline: true, isValid: true };
    if (method === 'app.bsky.unspecced.getPopularFeedGenerators') return { feeds: [{ uri: feedUri, cid: 'feed-cid', creator: { did: actorDid } }] };
    if (method === 'app.bsky.graph.getStarterPack') return { starterPack: { uri: `at://${actorDid}/app.bsky.graph.starterpack/sample`, cid: 'pack-cid', creator: { did: actorDid }, record: {} } };
    if (method === 'app.bsky.notification.getUnreadCount') return { count: 0 };
    return { actors: [], feeds: [], feed: [], posts: [], followers: [], follows: [], suggestions: [], likes: [], repostedBy: [], starterPacks: [], mutes: [], blocks: [], labels: [] };
  }
  return { transport, calls, records, journals, preferences: () => preferences, writes: () => committedWrites,
    loseNextWrite: () => { loseWrite = true; }, loseChatRead: () => { loseChatRead = true; } };
}

test('all declared methods exist and read tools never perform hidden writes/create chat', async () => {
  const f = fixture(), x = createExtended(f.transport);
  for (const s of EXTENDED_TOOLS) assert.equal(typeof x[s.method], 'function');
  await x.feedRead({ kind: 'home' }); await x.feedRead({ kind: 'author', actor: actorDid, filter: 'posts_with_media' });
  await x.feedRead({ kind: 'custom', uri: feedUri }); await x.feedDiscover({ mode: 'search', query: 'sky' });
  await x.people({ mode: 'search', query: 'someone' }); await x.socialRead({ kind: 'following', actor: actorDid });
  await x.postContext({ kind: 'likes', uri }); await x.starterPacks({ mode: 'actor', actor: actorDid });
  await x.bookmarksList({}); await x.notificationsState({});
  await x.chatRead({ mode: 'list', unread_only: true }); await x.chatRead({ mode: 'availability', members: [actorDid] });
  await x.safetyRead({ kind: 'mutes' }); await x.safetyRead({ kind: 'preferences' });
  assert.ok(f.calls.every(c => c.opts.write !== true));
  assert.ok(!f.calls.some(c => c.method === 'chat.bsky.convo.getConvoForMembers'));
  assert.equal(f.calls.find(c => c.method === 'chat.bsky.convo.listConvos').args.readState, 'unread');
  assert.ok(EXTENDED_TOOLS.find(s => s.name === 'bluesky_chat_send').readOnly === false);
});

test('like committed-response-loss and cold worker retry use exactly one account-bound TID record', async () => {
  const f = fixture(); f.loseNextWrite();
  const first = await createExtended(f.transport).socialAction({ action: 'like', uri });
  assert.equal(first.verified, true); assert.equal(f.writes(), 1);
  const again = await createExtended(f.transport).socialAction({ action: 'like', uri });
  assert.equal(first.uri, again.uri); assert.equal(f.writes(), 1);
  const removed = await createExtended(f.transport).socialAction({ action: 'unlike', uri });
  assert.equal(removed.verified, true); assert.equal(f.records.size, 0);
});

test('preferences preserve future unknown fields and personal data while hiding birthdate from model', async () => {
  const f = fixture(), x = createExtended(f.transport);
  await x.feedSave({ action: 'save', uri: feedUri, pinned: true });
  await x.safetyUpdate({ kind: 'muted_word', action: 'add', word: 'annoying', exclude_following: true });
  const result = await x.safetyUpdate({ kind: 'interest_tags', action: 'replace', tags: ['sky', 'railways'] });
  assert.equal(result.verified, true); assert.equal(result.unrelatedPreferencesPreserved, true);
  assert.equal(f.preferences().find(p => p.$type.endsWith('#personalDetailsPref')).birthDate, '2000-01-01T00:00:00Z');
  assert.deepEqual(f.preferences().find(p => p.$type.endsWith('#futurePref')).future, { unknown: true });
  const read = await x.safetyRead({ kind: 'preferences' });
  assert.ok(!JSON.stringify(read).includes('birthDate'));
  assert.deepEqual(read.preferences.find(p => p.$type.endsWith('#interestsPref')).tags, ['sky', 'railways']);
  await x.feedSave({ action: 'remove', uri: feedUri });
  assert.deepEqual(f.preferences().find(p => p.$type.endsWith('#savedFeedsPrefV2')).items, []);
});

test('bookmarks use strong reference and return verified private state', async () => {
  const x = createExtended(fixture().transport);
  assert.equal((await x.bookmarkAction({ action: 'create', uri })).verified, true);
  const list = await x.bookmarksList({}); assert.equal(list.bookmarks[0].subject.uri, uri);
  assert.equal((await x.bookmarkAction({ action: 'delete', uri })).verified, true);
  assert.equal((await x.bookmarksList({})).bookmarks.length, 0);
});

test('first saved-feeds V2 write migrates legacy channels and following position', async () => {
  const f = fixture(), legacyUri = `at://${actorDid}/app.bsky.graph.list/friends`;
  await f.transport.authedRpc('app.bsky.actor.putPreferences', { preferences: [{ $type: 'app.bsky.actor.defs#savedFeedsPref',
    saved: [legacyUri], pinned: [legacyUri], timelineIndex: 0 }] }, { write: true });
  const result = await createExtended(f.transport).feedSave({ action: 'save', uri: feedUri });
  assert.equal(result.unrelatedPreferencesPreserved, true);
  assert.deepEqual(result.preference.items.map(i => [i.type, i.value, i.pinned]),
    [['timeline', 'following', true], ['list', legacyUri, true], ['feed', feedUri, false]]);
});

test('malicious foreign viewer record URI cannot cause another account mutation', async () => {
  const f = fixture(), original = f.transport.authedRpc;
  f.transport.authedRpc = async (m, a, o) => {
    const d = await original(m, a, o);
    if (m === 'app.bsky.feed.getPosts') d.posts[0].viewer.like = `at://${actorDid}/app.bsky.feed.like/3mx3tbymzt4ft`;
    return d;
  };
  await assert.rejects(createExtended(f.transport).socialAction({ action: 'unlike', uri }), /CANNOT_CHANGE_OTHER_ACCOUNT_RECORD/);
  assert.equal(f.writes(), 0);
});

test('chat direct creation is explicit action; group and reply schemas use fixed service proxy', async () => {
  const f = fixture(), x = createExtended(f.transport);
  assert.equal((await x.chatSend({ action: 'create_direct', members: [actorDid] })).convo.id, 'direct-1');
  assert.ok(f.calls.some(c => c.method === 'chat.bsky.convo.getConvoForMembers'));
  const sent = await x.chatSend({ action: 'send', conversation_id: 'direct-1', text: 'hello', draft_id: 'reply-1', reply_to_message_id: 'old-1' });
  assert.equal(sent.verified, true);
  const request = f.calls.find(c => c.method === 'chat.bsky.convo.sendMessage');
  assert.deepEqual(request.args.message.replyTo, { messageId: 'old-1' });
  const group = await x.chatSend({ action: 'create_group', members: [actorDid], name: 'Friends', draft_id: 'group-1' });
  assert.equal(group.convo.id, 'group-1');
  const again = await createExtended(f.transport).chatSend({ action: 'create_group', members: [actorDid], name: 'Friends', draft_id: 'group-1' });
  assert.equal(again.duplicatePrevented, true); assert.equal(f.writes(), 2);
  await assert.rejects(x.chatSend({ action: 'send', conversation_id: 'direct-1', text: 'different', draft_id: 'reply-1' }), /DRAFT_ID_CONTENT_CONFLICT/);
});

test('unknown chat write outcome is persisted and never silently duplicated after restart', async () => {
  const f = fixture(); f.loseChatRead();
  await assert.rejects(createExtended(f.transport).chatSend({ action: 'send', conversation_id: 'direct-1', text: 'hello', draft_id: 'unknown-1' }), /fixed-code/);
  assert.equal(f.writes(), 1);
  await assert.rejects(createExtended(f.transport).chatSend({ action: 'send', conversation_id: 'direct-1', text: 'hello', draft_id: 'unknown-1' }), /CHAT_OUTCOME_UNKNOWN/);
  assert.equal(f.writes(), 1);
});

test('invalid IDs/pages/group limits/interests fail before sending writes', async () => {
  const f = fixture(), x = createExtended(f.transport);
  await assert.rejects(x.feedRead({ kind: 'custom', uri: 'https://attacker.example/' }), /AT_URI_REQUIRED/);
  await assert.rejects(x.feedRead({ kind: 'home', limit: 101 }), /PAGE_LIMIT/);
  await assert.rejects(x.chatSend({ action: 'create_direct', members: [actorDid, 'did:plc:third'] }), /ONE_OTHER_DID/);
  await assert.rejects(x.chatSend({ action: 'create_group', members: [actorDid], name: 'a'.repeat(51), draft_id: 'bad' }), /GROUP_NAME/);
  await assert.rejects(x.safetyUpdate({ kind: 'interest_tags', action: 'replace', tags: Array.from({ length: 101 }, (_, i) => String(i)) }), /MAXIMUM_100/);
  assert.equal(f.writes(), 0); assert.ok(!f.calls.some(c => c.opts.write));
});
