// This deployment accepts text prompts only. No upload route or attachment tool is exposed.
export function apply(ctx) {
  let resolver;
  ctx.provide('fileUploads', {
    registerAgentResolver(value) { resolver = value; return () => { if (resolver === value) resolver = undefined; }; },
    bindPrompt(_agent, receiptIds) {
      if (receiptIds.length) throw new Error('File receipts are not configured');
      return { commit() {}, [Symbol.dispose]() {} };
    },
    resolve() { throw new Error('File receipts are not configured'); },
    retirePrompt() {},
    upload() { throw new Error('Attachment uploads are not configured in this text channel'); }
  });
}
