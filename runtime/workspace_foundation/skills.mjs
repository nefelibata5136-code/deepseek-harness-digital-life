import { resolve } from 'node:path';
import { native } from './native.mjs';

export async function mountWorkspaceSkills(ctx, config) {
  const Skills = await native('dsh-skill');
  const Filesystem = await native('dsh-skill-filesystem');
  const Tool = await native('dsh-tool-skill');
  if (!ctx.get('skills')) await ctx.plugin(Skills.default);
  await ctx.plugin(Filesystem, {
    includeDefaultRoots: false,
    customSkillDirs: [resolve(config.workspace, '.dsh/skills'), resolve(config.workspace, 'development/skills')],
    watch: false, watchFollowSymlinks: false,
  });
  // Native filesystem writes invalidate discovery; get() re-reads the current body.
  // Terminal edits can be inspected with read, or a fresh Harness load rediscovers the catalog.
  if (!ctx.tools.get('skill')) await ctx.plugin(Tool);
}
