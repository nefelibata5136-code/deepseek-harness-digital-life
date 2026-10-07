// Technical checks of irreversible write recovery. Not Persona's real acceptance.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bluesky, safeCall, draftTid } from './bundle/client.mjs';
const root = await mkdtemp(join(tmpdir(), 'persona-bluesky-'));
const secret = 'synthetic-disposable-password', token = 'synthetic-disposable-token';
const creds = { resolve: async () => ({ value: secret }), describe: async () => ({ configured: true }) };
const records = new Map(); let writes = 0;
const request = async (url, init) => {
  const method = url.pathname.split('/').at(-1);
  if (method === 'com.atproto.server.createSession') return Response.json({
    did: 'did:plc:example', handle: 'personao.bsky.social', accessJwt: token,
    didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: 'https://auriporia.us-west.host.bsky.network' }] } });
  if (method === 'com.atproto.repo.getRecord') {
    const record = records.get(url.searchParams.get('rkey'));
    if (!record) return Response.json({ error: 'RecordNotFound', message: secret }, { status: 400 });
    // A real server may re-order record properties.
    return Response.json({ uri: record.uri, cid: 'cid-test', value: {
      langs: record.value.langs, createdAt: record.value.createdAt, text: record.value.text, $type: record.value.$type } });
  }
  if (method === 'com.atproto.repo.createRecord') {
    const input = JSON.parse(init.body); writes++;
    assert.match(input.rkey, /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
    records.set(input.rkey, { uri: `at://${input.repo}/${input.collection}/${input.rkey}`, value: input.record });
    // The server committed but the caller never received its response.
    throw new Error(secret + token);
  }
  return Response.json({ error: 'UnexpectedServerError', message: secret + token }, { status: 500 });
};
const client = new Bluesky(creds, { root, request });
try {
  const draft = { text: '一次真实连接之前的技术检查。', draft_id: 'recovery-check' };
  const lost = await safeCall(() => client.publish(draft));
  assert.equal(lost.error, 'WRITE_OUTCOME_UNKNOWN_READ_BEFORE_RETRY');
  const recovered = await client.publish(draft);
  assert.equal(recovered.repositoryVerified, true);
  assert.equal(writes, 1);
  const cold = new Bluesky(creds, { root, request });
  assert.equal((await cold.publish(draft)).uri, recovered.uri); await cold.close();
  assert.equal(writes, 1);
  const repeated = await client.publish(draft);
  assert.equal(repeated.duplicatePrevented, true); assert.equal(writes, 1);
  assert.equal((await safeCall(() => client.publish({ ...draft, text: 'different' }))).error, 'DRAFT_ID_ALREADY_USED_FOR_DIFFERENT_CONTENT');
  assert.equal((await safeCall(() => client.publish({ text: '字'.repeat(301), draft_id: 'too-long' }))).error, 'POST_REQUIRES_1_TO_300_GRAPHEMES');
  const failure = await safeCall(() => client.status());
  assert.equal(failure.error, 'BLUESKY_HTTP_ERROR');
  const outputs = JSON.stringify({ lost, recovered, repeated, failure });
  assert.ok(!outputs.includes(secret)); assert.ok(!outputs.includes(token));
  const journal = await readFile(join(root, (await readdir(root)).find(f => f.endsWith('.json'))), 'utf8');
  assert.ok(!journal.includes(secret)); assert.ok(!journal.includes(token));
  console.log(JSON.stringify({ technicalPassed: true, checks: ['committed-but-response-lost recovery', 'one write after repeated retry',
    'draft identity conflict', '300 grapheme limit', 'canonical readback across property order', 'credentials absent from results and journal',
    'post key conforms to TID Lexicon', 'cold worker retry retains original TID'],
    realAgentAcceptance: false }));
} finally { await client.close(); await rm(root, { recursive: true }); }
