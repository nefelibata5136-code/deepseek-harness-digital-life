// Real native capability worker + real read-only Bluesky API. No model or writes to Bluesky.
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBus } from '../native_dsh/capabilities/bus.mjs';
const reports = resolve(import.meta.dirname, '../../reports/bluesky');
await mkdir(reports, { recursive: true });
const bus = createBus({ root: resolve(import.meta.dirname, '../native_dsh/capabilities/profiles'),
  python: 'python' });
const checks = [];
try {
  await bus.manage({ action: 'enable', capability: 'bluesky' });
  const first = await bus.search({ capability: 'bluesky', limit: 30 });
  const last = await bus.search({ capability: 'bluesky', limit: 30, offset: 30 });
  const search = { tools: [...first.tools,...last.tools] };
  assert.equal(search.tools.length, 39);
  assert.ok(!JSON.stringify(search).includes('accessJwt'));
  assert.ok(search.tools.every(t => t.parameters.additionalProperties === false));
  for (const [name, args] of [ ['bluesky_status', {}], ['bluesky_explore', { per_direction: 3 }],
    ['bluesky_own_posts', { limit: 2 }], ['bluesky_notifications', { limit: 2 }],
    ['bluesky_search',{query:'night sky',media:'images',limit:3}], ['bluesky_chat_read',{mode:'list',limit:2}],
    ['bluesky_video_limits',{}], ['bluesky_bookmarks_list',{limit:2}],['bluesky_trends',{limit:2}] ]) {
    const r = await bus.call('bluesky', name, args, 'technical-' + name);
    assert.equal(r.value.error, undefined);
    if (name === 'bluesky_status') assert.equal(r.value.account.did, 'did:plc:example');
    checks.push({ name, passed: true, candidates: r.value.candidates?.length,
      posts: r.value.repositoryRecords?.length, notifications: r.value.notifications?.length });
  }
  const result = { passed: true, observedAt: new Date().toISOString(), tools: search.tools.map(t => t.name), checks,
    nativeWorkerAndLiveReadOnlyApi: true, realAgentAcceptance: false };
  await writeFile(resolve(reports, 'worker-validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await bus.dispose(); }
