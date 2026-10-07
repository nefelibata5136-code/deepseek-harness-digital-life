// A can mount this native Cordis plugin in the protected composition BEFORE agents start.
import { mountWorkspaceVersions } from './lifecycle.mjs';
import { mountNativeFiles } from './files.mjs';
import { mountWorkspaceSkills } from './skills.mjs';
import { loadHelloPlugin } from './extensions.mjs';
export const name = 'persona-workspace-foundation';
export const inject = ['tools', 'systemPrompt', 'sessions'];
export async function apply(ctx, config) {
  const versions = mountWorkspaceVersions(ctx, config);
  await mountNativeFiles(ctx, config);
  await mountWorkspaceSkills(ctx, config);
  const hello = await loadHelloPlugin(ctx, { enabled: config.helloEnabled === true, workspace: config.workspace });
  ctx.provide('workspaceFoundation', { ...versions, hello });
}
