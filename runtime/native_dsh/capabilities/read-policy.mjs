/** Reviewed read operations for native delegated work. Names are exact, fail closed.
 * Mixed-action tools (bookmarks, preferences, social, chat) must expose separate
 * read tools before delegation. Neither descriptions nor prefixes grant access.
 */
export const blueskyReadTools = new Set([
  'bluesky_status', 'bluesky_explore', 'bluesky_feed_catalog', 'bluesky_thread',
  'bluesky_author', 'bluesky_own_posts', 'bluesky_notifications', 'bluesky_avatar_catalog',
  'bluesky_search', 'bluesky_batch_preview', 'bluesky_open_preview',
  'bluesky_exploration_preferences_read', 'bluesky_feed', 'bluesky_feed_read', 'bluesky_feed_discover',
  'bluesky_trends', 'bluesky_people', 'bluesky_profile', 'bluesky_social_read',
  'bluesky_starter_packs', 'bluesky_post_context', 'bluesky_bookmarks_list',
  'bluesky_chat_read', 'bluesky_stream', 'bluesky_media', 'bluesky_safety_read', 'bluesky_notifications_state',
  'bluesky_video_limits', 'bluesky_video_status',
]);
export const allowedReadTool = (capability, name) => capability === 'bluesky' && blueskyReadTools.has(name);
export const allowedIntentionReadTool = (capability, name) => allowedReadTool(capability, name)
  || capability === 'memory' && new Set(['memory_search', 'memory_open', 'memory_catalog', 'memory_pending', 'memory_status']).has(name);

export function assertCapabilityAccess(access, capability, name) {
  // Omitted access is the existing trusted Host API; model-facing callers always
  // pass an explicit mode derived from native Session identity, never arguments.
  if (access === undefined || access === 'authority') return;
  if (access === 'delegate-read' && allowedReadTool(capability, name)) return;
  if (access === 'intention-read' && allowedIntentionReadTool(capability, name)) return;
  throw new Error('CAPABILITY_DELEGATE_READ_ONLY');
}
