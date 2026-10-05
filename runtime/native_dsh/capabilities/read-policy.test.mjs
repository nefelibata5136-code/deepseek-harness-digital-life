import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedReadTool, allowedIntentionReadTool, assertCapabilityAccess, blueskyReadTools } from './read-policy.mjs';

test('delegation uses reviewed exact read names on the Bluesky capability only', () => {
  for (const name of blueskyReadTools) assert.doesNotThrow(() => assertCapabilityAccess('delegate-read', 'bluesky', name));
  for (const name of ['bluesky_post', 'bluesky_profile_update', 'bluesky_avatar_set',
    'bluesky_bookmarks', 'bluesky_social', 'bluesky_chat', 'bluesky_exploration_preferences_update',
    'bluesky_post_read', 'bluesky_status_extra', 'read_secret', 'credential_resolve']) {
    assert.equal(allowedReadTool('bluesky', name), false);
    assert.throws(() => assertCapabilityAccess('delegate-read', 'bluesky', name), /READ_ONLY/);
  }
  assert.throws(() => assertCapabilityAccess('delegate-read', 'other', 'bluesky_status'), /READ_ONLY/);
  assert.throws(() => assertCapabilityAccess('denied', 'bluesky', 'bluesky_status'), /READ_ONLY/);
  assert.doesNotThrow(() => assertCapabilityAccess('authority', 'bluesky', 'bluesky_post'));
});

test('intention expansion reads reviewed memory and Bluesky without inheriting writes', () => {
  for (const name of ['memory_search', 'memory_open', 'memory_catalog', 'memory_pending', 'memory_status']) {
    assert.equal(allowedIntentionReadTool('memory', name), true);
    assert.doesNotThrow(() => assertCapabilityAccess('intention-read', 'memory', name));
    assert.throws(() => assertCapabilityAccess('delegate-read', 'memory', name), /READ_ONLY/);
  }
  for (const name of blueskyReadTools) assert.doesNotThrow(() => assertCapabilityAccess('intention-read', 'bluesky', name));
  for (const [capability, name] of [['memory', 'memory_accept'], ['memory', 'memory_append'], ['memory', 'memory_delete'],
    ['bluesky', 'bluesky_post'], ['bluesky', 'bluesky_social'], ['other', 'memory_open']]) {
    assert.equal(allowedIntentionReadTool(capability, name), false);
    assert.throws(() => assertCapabilityAccess('intention-read', capability, name), /READ_ONLY/);
  }
});
