// Audited tool names, not untrusted MCP readOnlyHint. These tools cannot write
// workspace files; images go to the official attachment store outside workspace.
// Unknown names and all public social writes retain the normal protection path.
const names=new Set(['check_login_status','get_login_qrcode','list_feeds','search_feeds',
  'get_feed_detail','read_comments','read_images','user_profile','next_feed',
  'diandian_read','diandian_chat','diandian_open_reference','capture_open_note','resolve_note_link',
  'export_note','read_export']
  .map(n=>'cap__xiaohongshu__xhs_'+n));
// Native read_image reads through the existing FS guard and only writes into
// the native attachment store outside workspace; it has no workspace write.
names.add('read_image');
export const isXiaohongshuWorkspaceRead=name=>names.has(name);
