/** Official profile and Plugin Manager operations; no alternate package installer. */
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { boot, loadProfileDirectory, createRuntimeResolution, PluginPackages } from '@deepseek-ai/dsh-app-boot';
import PluginManager from '@deepseek-ai/dsh-plugin-manager';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';

export const installAnchor = resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/package.json');
export const validId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(id);
export const validRef = ref => typeof ref === 'string' && /^DL_[A-Z0-9_]+$/.test(ref);
export async function readEntry(root, id) {
  if (!validId(id)) throw new Error('Invalid capability ID');
  const dir = join(root, id);
  if ((await lstat(dir)).isSymbolicLink()) throw new Error('Capability profile must not be a link');
  const entry = JSON.parse(await readFile(join(dir, 'capability.json'), 'utf8'));
  if (entry.id !== id || !['mcp', 'plugin'].includes(entry.kind)
      || typeof entry.description !== 'string' || entry.description.length > 500
      || typeof entry.enabled !== 'boolean' || !Array.isArray(entry.credentialRefs)
      || entry.credentialRefs.length > 64 || !entry.credentialRefs.every(validRef))
    throw new Error('Invalid capability metadata');
  return entry;
}
export async function saveEntry(root, entry) {
  await writeFileAtomic(join(root, entry.id, 'capability.json'), JSON.stringify(entry, null, 2) + '\n', {});
}
export async function registerProfile(root, entry) {
  if (!validId(entry.id) || !['mcp', 'plugin'].includes(entry.kind)
      || typeof entry.description !== 'string' || entry.description.length > 500
      || !(entry.credentialRefs ?? []).every(validRef)) throw new Error('Invalid capability metadata');
  await mkdir(root, { recursive: true });
  const dir = join(root, entry.id);
  await mkdir(dir); // Never overwrite an existing profile.
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dsh: { profile: { bundles: [] } } }, null, 2) + '\n');
  await writeFile(join(dir, 'cordis.yml'), '[]\n');
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n');
  await writeFile(join(dir, '.npmrc'), 'auto-install-peers=false\nignore-scripts=true\n');
  await saveEntry(root, { ...entry, credentialRefs: entry.credentialRefs ?? [], enabled: false, approval: null });
  return readEntry(root, entry.id);
}
export async function profileIds(root) {
  try { return (await readdir(root, { withFileTypes: true })).filter(row => row.isDirectory() && validId(row.name)).map(row => row.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function managerContext(root, id) {
  await readEntry(root, id);
  const dir = join(root, id);
  const profile = loadProfileDirectory('persona-capabilities', dir, installAnchor);
  const resolution = await createRuntimeResolution({ installAnchor, profile, home: resolve(root, '..') });
  // Management reads bundle manifests but never mounts their unreviewed code.
  return boot('persona-capabilities-control', join(dir, 'control.yml'), [], async ctx => {
    ctx.provide('profileContext', { name: id, dir, patchPath: profile.patchPath, installAnchor,
      cwd: dir, home: resolve(root, '..'), startedBundles: [], overlays: [] });
    await ctx.plugin(PluginPackages, { resolution });
    await ctx.plugin(PluginManager, { inspectTimeoutMs: 10000, idleTimeoutMs: 60000, fallbackRegistries: [] });
  });
}
export async function withManager(root, id, action) {
  const dir = join(root, id);
  await writeFile(join(dir, 'control.yml'), '[]\n');
  const ctx = await managerContext(root, id);
  try { return await action(ctx.pluginManager); }
  finally { await ctx.fiber.dispose(); }
}
/** Hash reviewed profile configuration and resolved package bytes, including profile dependencies. */
export async function releaseDigest(root, id) {
  const dir = join(root, id);
  const profile = loadProfileDirectory('persona-capabilities', dir, installAnchor);
  if (profile.skippedBundles.length) throw new Error('Selected bundle is missing or incompatible');
  const resolution = await createRuntimeResolution({ installAnchor, profile, home: resolve(root, '..') });
  const hash = createHash('sha256');
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', '.npmrc', 'plugin-compatibility.json']) {
    let bytes;
    try { bytes = await readFile(join(dir, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; bytes = Buffer.alloc(0); }
    hash.update(name + '\0').update(bytes);
  }
  const walk = async (base, path = '') => {
    const rows = (await readdir(join(base, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const row of rows) {
      if (['node_modules', '.git'].includes(row.name)) continue;
      const file = join(path, row.name);
      if (row.isSymbolicLink()) throw new Error('Reviewed packages may not contain symlinks');
      if (row.isDirectory()) await walk(base, file);
      else if (row.isFile()) {
        hash.update(file + '\0');
        for await (const chunk of createReadStream(join(base, file))) hash.update(chunk);
      }
    }
  };
  const packages = new Map();
  for (const layer of profile.layers) packages.set(layer.packageName, { name: layer.packageName, packageDir: layer.packageDir });
  for (const link of resolution.linkedRoots) packages.set(link.name, { name: link.name, packageDir: link.realPath });
  for (const pkg of resolution.entries.filter(row => row.scope === 'profile')) packages.set(pkg.name, pkg);
  for (const pkg of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(pkg.name + '\0' + pkg.packageDir + '\0');
    await walk(pkg.packageDir);
  }
  return hash.digest('hex');
}
export async function approveProfile(root, id) {
  const entry = await readEntry(root, id);
  entry.approval = { sha256: await releaseDigest(root, id), observedAt: new Date().toISOString() };
  await saveEntry(root, entry);
  return { id, approved: true, sha256: entry.approval.sha256 };
}
