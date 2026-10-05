// B's assembly creates services as children, so mount it on the Host root.
// A profile plugins have enforced injection; B's root-context validation did not.
import { mountWorkspaceVersions } from '../workspace_foundation/lifecycle.mjs';
import { mountNativeFiles } from '../workspace_foundation/files.mjs';
import { loadHelloPlugin } from '../workspace_foundation/extensions.mjs';
import { native } from '../workspace_foundation/native.mjs';
import { resolve } from 'node:path';
import {createPhaseJournal} from '../activity_progress/phases.mjs';
export const inject = ['tools', 'systemPrompt', 'sessions'];
export async function apply(ctx, config) {
  const root = ctx.root;
  const phases=createPhaseJournal(resolve(config.store,'activity-progress'));
  root.provide('personaProgressPhases',phases);
  root.effect(()=>()=>phases.flush(),'activity progress journal flush');
  const versions = mountWorkspaceVersions(root, config);
  const files = await mountNativeFiles(root, config);
  if (!config.fullAccess) {
  const originalResolve = root.fs.resolve.bind(root.fs);
  root.fs.resolve = (path, ...args) => {
    if (/(^|[\\/])\.credentials(?:\.[^\\/]*)?([\\/]|$)/i.test(String(path))) throw new Error('Credential path excluded');
    return originalResolve(path, ...args);
  };
  }
  const Skills = await native('dsh-skill');
  const Filesystem = await native('dsh-skill-filesystem');
  const Tool = await native('dsh-tool-skill');
  if (!root.get('skills')) await root.plugin(Skills.default);
  await root.plugin(Filesystem, { includeDefaultRoots: false,
    customSkillDirs: [resolve(config.workspace, '.dsh/skills'), resolve(config.workspace, 'development/skills')],
    watch: true, watchFollowSymlinks: false });
  await root.plugin(Tool);
  const hello = await loadHelloPlugin(root, { enabled: config.helloEnabled === true, workspace: config.workspace });
  root.provide('workspaceFoundation', { ...versions, hello, files });
}
