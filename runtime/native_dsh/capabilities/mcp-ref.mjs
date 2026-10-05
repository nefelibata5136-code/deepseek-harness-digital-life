/** Credential-reference adapter; protocol, discovery and reconnect belong to native MCP. */
import * as Mcp from '@deepseek-ai/dsh-mcp-client';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

export const name = 'persona-mcp-ref';
export const inject = ['tools', 'credentials'];
export function assertCredentialSafeConfig(config) {
  if (config.url !== undefined) {
    let url;
    try { url = new URL(config.url); } catch { throw new Error('Invalid MCP transport URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
        || [...url.searchParams.keys()].some(key => /token|secret|password|passwd|api.?key|credential|authorization|signature|^key$/i.test(key)))
      throw new Error('MCP URL authentication must use credential references');
  }
  if (Object.keys(config.env ?? {}).some(key => /key|token|secret|password/i.test(key))
      || Object.keys(config.headers ?? {}).some(key => /authorization|key|token|cookie/i.test(key)))
    throw new Error('Use credential references for secret environment variables and headers');
}
export async function apply(ctx, config) {
  const { envRefs = {}, headerRefs = {}, ...nativeConfig } = config;
  assertCredentialSafeConfig(nativeConfig);
  const values = async refs => Object.fromEntries(await Promise.all(Object.entries(refs).map(async ([key, ref]) => {
    const spec = typeof ref === 'string' ? { ref, prefix: '' } : ref;
    const result = await ctx.credentials.resolve(credentialRef(spec.ref));
    if (!result) throw new Error('Required capability credential is unavailable');
    return [key, (spec.prefix ?? '') + result.value];
  })));
  // Native MCP takes transport values rather than CredentialRef. Resolve only in
  // this isolated worker; never persist the resolved config in a profile.
  const resolved = Mcp.Config({ ...nativeConfig,
    env: { ...nativeConfig.env, ...await values(envRefs) },
    headers: { ...nativeConfig.headers, ...await values(headerRefs) },
    failOnStartupError: true });
  await ctx.plugin(Mcp, resolved);
}
