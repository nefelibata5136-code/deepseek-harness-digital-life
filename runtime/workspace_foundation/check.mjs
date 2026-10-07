// Read-only inspection: no Agent, model, shell tool, watcher, commit or workspace write.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { native, nativeRequire, here } from './native.mjs';
import { controller } from './lifecycle.mjs';
import { mountNativeFiles } from './files.mjs';
import { mountWorkspaceSkills } from './skills.mjs';
const config = { python: process.env.TASK_B_PYTHON ?? 'python',
  workspace: '.local/workspace', store: resolve(here, 'protected/persona') };
const { Context } = await native('cordis');
const ctx = new Context();
try {
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools'])
    await ctx.plugin((await native(name)).default);
  await mountNativeFiles(ctx, config);
  await mountWorkspaceSkills(ctx, config);
  const approved = JSON.parse(await readFile(resolve(here, 'approved-plugins.json'), 'utf8'));
  const releaseHash = createHash('sha256').update(await readFile(resolve(here, 'hello-plugin.mjs'))).digest('hex');
  const candidateHash = createHash('sha256').update(await readFile(resolve(config.workspace, 'development/plugins/hello-world/plugin.mjs'))).digest('hex');
  const catalog = await ctx.skills.list({ cwd: config.workspace });
  const skill = await ctx.skills.get('persona-hello-world', { cwd: config.workspace });
  console.log(JSON.stringify({ native_version: nativeRequire('@deepseek-ai/dsh/package.json').version,
    versions: controller(config)('check'), skills: catalog.map(s => ({ name: s.name, description: s.description })),
    hello_skill_readable: !!skill?.content, hello_plugin_release_approved: releaseHash === approved['persona-hello-world'].sha256,
    hello_plugin_candidate_matches: candidateHash === releaseHash, plugin_loaded: false,
    agent_created: false, model_called: false, workspace_written: false }, null, 2));
} finally { await ctx.fiber.dispose(); }
