// The technical profile never accepts attachments. Not a production component.
export function apply(ctx) {
  ctx.provide('fileUploads', { registerAgentResolver() { return () => {}; } });
}
