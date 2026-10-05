import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { here } from './native.mjs';

// Deliberately no arbitrary module path, eval, npm, shell, watcher or config loader.
// Only this exact reviewed example is admitted. New host plugins require A/human review.
export async function loadHelloPlugin(ctx, { enabled = false, workspace } = {}) {
  if (!enabled) return { enabled: false, stop: async () => {} };
  const path = resolve(here, 'hello-plugin.mjs');
  const manifest = JSON.parse(await readFile(resolve(here, 'approved-plugins.json'), 'utf8'));
  const hash = createHash('sha256').update(await readFile(path)).digest('hex');
  if (manifest['persona-hello-world']?.sha256 !== hash) throw new Error('Plugin release hash mismatch; leave disabled and review locally');
  if (workspace) {
    const candidate = resolve(workspace, 'development/plugins/hello-world/plugin.mjs');
    const candidateHash = createHash('sha256').update(await readFile(candidate)).digest('hex');
    if (candidateHash !== hash) throw new Error('Workspace plugin differs from reviewed release; do not load it in the host');
  }
  const plugin = await import(pathToFileURL(path).href);
  const fork = ctx.plugin(plugin);
  await fork;
  return { enabled: true, sha256: hash, stop: async () => { await fork.dispose(); } };
}
