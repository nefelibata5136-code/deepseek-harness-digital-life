// Official fs tools + official CAS observation policy; policy only, no replacement tools.
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { native } from './native.mjs';

const secret = /\bsk-[A-Za-z0-9_-]{18,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|app[_-]?secret|password|access[_-]?token|refresh[_-]?token|cookie)\s*["']?\s*[:=]\s*["']?[^\s"'\r\n,}]{8,}/im;
const denied = /(^|[\\/])(?:\.env[^\\/]*|credentials(?:\.[^\\/]*)?|\.credentials|secrets|id_rsa|id_ed25519|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|auth\.json|cookies\.(?:json|txt))([\\/]|$)|\.(?:key|pem|p12|pfx|token|credentials)$/i;
const inside = (root, path) => {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

export async function checkPath(fs, path, roots, writeRoot) {
  const target = await fs.resolve(path);
  const actual = fs.processPath(target);
  if (denied.test(path) || denied.test(actual)) throw new Error('Credential paths are excluded');
  const root = roots.find(root => inside(root, actual));
  if (!root || (writeRoot && !inside(writeRoot, actual))) throw new Error('Path outside authorized area or read-only');
  // Preserve the existing file bridge's stricter no-link rule, also for aliases inside root.
  let part = resolve(isAbsolute(path) ? path : resolve(writeRoot ?? roots[0], path));
  while (inside(root, part)) {
    try { if ((await lstat(part)).isSymbolicLink()) throw new Error('Links/junctions are excluded'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (part === dirname(part)) break;
    part = dirname(part);
  }
  return { target, actual };
}

export async function mountNativeFiles(ctx, config) {
  if (ctx.get('fs')) throw new Error('Mount foundation fs instead of the existing fs provider');
  if (ctx.tools.get('read') || ctx.tools.get('write') || ctx.tools.get('edit'))
    throw new Error('Remove bridge read/write registrations before mounting official tools');
  const Policy = await native('dsh-sandbox-policy');
  const Fs = await native(config.fullAccess ? 'dsh-fs-local' : 'dsh-fs-sandbox');
  const Observation = await native('dsh-fs-observation-policy');
  const Tools = await native('dsh-tool-fs');
  if (!ctx.get('sandboxPolicy')) await ctx.plugin(Policy.default, { mode: config.fullAccess ? 'danger-full-access' : 'workspace-write', workspaceRoot: config.workspace });
  await ctx.plugin(Fs.default, { cwd: config.workspace });
  if (!config.fullAccess) await ctx.plugin(Observation);
  if (config.fullAccess) {
    // Explicit deployment choice: no path, credential, content or link allowlist.
    ctx.on('agent/created', ({ agent }) => {
      if (ctx.sandboxPolicy.overrideOf(agent.session) !== 'danger-full-access')
        Policy.setSandboxMode(agent.session, 'danger-full-access');
    });
    await ctx.plugin(Tools, { readMaxLineLength: 65536, readMaxBytes: 131072 });
    return { nativeFiles: true, observationPolicy: false, mode: 'danger-full-access',
      allowedReads: 'current-user-access', allowedWrites: 'current-user-access' };
  }
  // Authoritative backend seam: covers tools AND the filesystem skill provider.
  // All storage/version operations remain delegated to the official backend.
  // This service is created by this function; the aggregate plugin cannot declare
  // fs as a startup inject (that would prevent it from mounting the provider).
  const fs = ctx.get('fs');
  const roots = [config.workspace, ...(config.readRoots ?? [])].map(resolvePath => resolve(resolvePath));
  const originalResolve = fs.resolve.bind(fs);
  const secureResolve = async (...args) => {
    const target = await originalResolve(...args);
    const path = fs.processPath(target);
    if (denied.test(String(args[0])) || denied.test(path) || !roots.some(root => inside(root, path)))
      throw new Error('Filesystem path outside authorized areas or credential path');
    const raw = resolve(args[1]?.cwd ?? config.workspace, String(args[0]));
    if (!roots.some(root => inside(root, raw))) throw new Error('Aliases outside authorized areas excluded');
    let ancestor = raw;
    while (roots.some(root => inside(root, ancestor))) {
      try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Links/junctions excluded'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (ancestor === dirname(ancestor)) break;
      ancestor = dirname(ancestor);
    }
    return target;
  };
  fs.resolve = secureResolve;
  for (const method of ['readText', 'streamText', 'readBytes', 'readByteRange']) {
    const original = fs[method].bind(fs);
    fs[method] = async (target, ...args) => {
      const path = fs.processPath(target);
      await checkPath(fs, path, roots);
      if (secret.test((await readFile(path)).toString('utf8'))) throw new Error('Credential-bearing file excluded');
      return original(target, ...args);
    };
    ctx.effect(() => () => { fs[method] = original; }, 'foundation fs read boundary:' + method);
  }
  for (const method of ['writeText', 'editText']) {
    const original = fs[method].bind(fs);
    fs[method] = async (target, change, ...args) => {
      const { actual } = await checkPath(fs, fs.processPath(target), roots, config.workspace);
      if (secret.test(typeof change === 'string' ? change : JSON.stringify(change))) throw new Error('Credential content excluded');
      try { if (secret.test((await readFile(actual)).toString('utf8'))) throw new Error('Credential-bearing file excluded'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return original(target, change, ...args);
    };
    ctx.effect(() => () => { fs[method] = original; }, 'foundation fs write boundary:' + method);
  }
  ctx.effect(() => () => { fs.resolve = originalResolve; }, 'foundation fs resolve boundary');
  await ctx.plugin(Tools, { readMaxLineLength: 65536, readMaxBytes: 131072 });
  return { nativeFiles: true, observationPolicy: true, allowedReads: roots, allowedWrites: config.workspace };
}
