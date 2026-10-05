#!/usr/bin/env node
/**
 * Local file-scoped recovery, independent of Git and Host/runtime.
 * checkpoint -> edit/test -> seal -> accept OR rollback [--apply].
 * Stable interface: CLI below; one JSON result on stdout, exit 1 on refusal.
 * Before checkpoint, explicitly own each listed file until seal. A seal cannot
 * distinguish your edits from somebody else's intervening edits. Stop all writers
 * to these files during rollback: Node/filesystems offer no cross-process hash CAS.
 * Do not checkpoint secrets, personal records, databases, or generated archives.
 * Dirty working-tree contents ARE the baseline, never Git HEAD. No Git operation.
 * Immutable before/after blobs and rollback intent survive interrupted processes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FORMAT = 1;
const MAX_FILES = 64;
const MAX_BYTES = 16 * 1024 * 1024;
const ABSENT = { exists: false, hash: null, bytes: 0 };
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = message => { throw new Error(message); };
const within = (root, item) => { const rel = path.relative(root, item); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const same = (a, b) => a.exists === b.exists && a.hash === b.hash && a.bytes === b.bytes;
const canonicalComparable = item => process.platform === 'win32' ? path.normalize(item).toLowerCase() : path.normalize(item);
async function exists(file) { try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

// Reject every link below workspace, including junctions. Under the real Windows
// restricted/Low terminal, lstat(junction).isSymbolicLink() can return false and
// readlink can return EINVAL; realpath still reveals its target. Compare each
// existing component with its canonical lexical location, including in-workspace
// links. Never follow links to blobs/metadata or replace links with restored files.
async function safePath(workspace, relative, { directory = false } = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /[:\0]/.test(relative)) fail('Expected a workspace-relative path');
  const parts = relative.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('Path traversal, Windows alias, or empty path component refused');
  let current = workspace;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await exists(current);
    if (stat?.isSymbolicLink()) fail('Links/junctions refused: ' + relative);
    if (stat && canonicalComparable(await fs.realpath(current)) !== canonicalComparable(current)) fail('Links/junctions refused by canonical path: ' + relative);
    if (stat && (index < parts.length - 1 || directory) && !stat.isDirectory()) fail('Non-directory path component: ' + relative);
    if (stat && index === parts.length - 1 && !directory && !stat.isFile()) fail('Only regular files supported: ' + relative);
    if (stat?.isFile() && stat.nlink > 1) fail('Hard links refused: ' + relative);
  }
  return current;
}
function allowedSource(relative, storeRelative) {
  if (within(storeRelative, relative) || relative.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) fail('Checkpoint storage and .git cannot be checkpointed');
  if (/(^|[\\/])(?:\.env(?:\..*)?|private[-_]?vault|credentials?|secrets?)(?:[\\/]|$)/i.test(relative) || /\.(?:pem|key|p12|pfx|db|sqlite3?|zip)$/i.test(relative)) fail('Sensitive/data/archive path refused: ' + relative);
}
function noCredentials(data, relative) {
  const text = data.toString('utf8');
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{20,}\b/.test(text)
      || /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|cookie)\s*[=:]\s*["'][^"'\r\n]{8,}["']/i.test(text)) fail('Possible credential literal refused: ' + relative);
}
async function readSource(workspace, relative) {
  const target = await safePath(workspace, relative);
  const stat = await exists(target);
  if (!stat) return { snapshot: { ...ABSENT }, data: null };
  if (stat.size > MAX_BYTES) fail('File too large: ' + relative);
  const data = await fs.readFile(target);
  if (data.length > MAX_BYTES) fail('File too large: ' + relative);
  noCredentials(data, relative);
  return { snapshot: { exists: true, hash: hash(data), bytes: data.length, mode: stat.mode & 0o777 }, data };
}
async function durableExclusive(file, data) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
async function jsonExclusive(file, value) { await durableExclusive(file, JSON.stringify(value, null, 2) + '\n'); }
async function jsonRead(workspace, relative) { return JSON.parse(await fs.readFile(await safePath(workspace, relative), 'utf8')); }
function options(argv) {
  const result = { command: argv[0], files: [], apply: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') result.apply = true;
    else if (arg === '--json') {} // JSON is always the stable output format.
    else if (['--workspace', '--store', '--id', '--file'].includes(arg)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) fail('Missing value: ' + arg);
      if (arg === '--file') result.files.push(value); else result[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) fail('Unknown option: ' + arg);
    else result.files.push(arg);
  }
  return result;
}
async function context(opts) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  // Installed under workspace/tools/self-maintenance. Source-tree invocation
  // intentionally requires --workspace so repository/runtime is never guessed.
  const inferred = path.basename(scriptDir) === 'self-maintenance' && path.basename(path.dirname(scriptDir)) === 'tools' ? path.resolve(scriptDir, '../..') : null;
  if (!opts.workspace && !inferred) fail('--workspace required outside workspace/tools/self-maintenance');
  const workspace = path.resolve(opts.workspace || inferred);
  const stat = await fs.lstat(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Workspace must be a real directory');
  if (canonicalComparable(await fs.realpath(workspace)) !== canonicalComparable(workspace)) fail('Workspace must be a real directory without linked ancestors');
  const store = path.resolve(workspace, opts.store || 'development/.checkpoints');
  if (store === workspace || !within(workspace, store)) fail('Store must be inside workspace');
  const storeRelative = path.relative(workspace, store);
  if (storeRelative.split(path.sep).some(part => part.toLowerCase() === '.git')) fail('Store cannot be inside .git');
  await safePath(workspace, storeRelative, { directory: true });
  return { workspace, store, storeRelative };
}
async function blobWrite(dir, name, data) {
  if (data === null) return;
  const target = path.join(dir, name);
  try { await durableExclusive(target, data); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A crash while sealing may have left complete immutable blobs. Reuse only
    // exact contents; a torn/damaged/different blob is never overwritten.
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || canonicalComparable(await fs.realpath(target)) !== canonicalComparable(target) || !Buffer.from(await fs.readFile(target)).equals(data)) fail('Existing blob differs or is unsafe; original anchor retained: ' + name);
  }
}
async function load(ctx, id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id || '')) fail('A safe --id is required');
  const relative = path.join(ctx.storeRelative, id);
  const dir = await safePath(ctx.workspace, relative, { directory: true });
  const manifest = await jsonRead(ctx.workspace, path.join(relative, 'checkpoint.json'));
  if (manifest.format !== FORMAT || manifest.id !== id || manifest.workspace !== ctx.workspace || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES) fail('Invalid checkpoint manifest');
  const unique = new Set();
  for (let index = 0; index < manifest.files.length; index++) {
    const entry = manifest.files[index];
    if (entry.index !== index || unique.has(entry.path)) fail('Invalid or duplicate checkpoint entry');
    unique.add(entry.path); allowedSource(entry.path, ctx.storeRelative);
    await safePath(ctx.workspace, entry.path);
    await checkBlob(ctx, relative, entry.before, `before-${index}.blob`);
  }
  let seal = null;
  if (await exists(path.join(dir, 'seal.json'))) {
    seal = await jsonRead(ctx.workspace, path.join(relative, 'seal.json'));
    if (seal.format !== FORMAT || seal.id !== id || seal.files?.length !== manifest.files.length) fail('Invalid seal');
    for (let index = 0; index < seal.files.length; index++) {
      if (seal.files[index].path !== manifest.files[index].path) fail('Seal path mismatch');
      await checkBlob(ctx, relative, seal.files[index].after, `after-${index}.blob`);
    }
  }
  return { dir, relative, manifest, seal };
}
async function checkBlob(ctx, relative, snapshot, name) {
  if (!snapshot || typeof snapshot.exists !== 'boolean') fail('Invalid snapshot');
  if (!snapshot.exists) { if (snapshot.hash !== null || snapshot.bytes !== 0) fail('Invalid absent snapshot'); return; }
  if (!/^[a-f0-9]{64}$/.test(snapshot.hash) || !Number.isInteger(snapshot.bytes) || snapshot.bytes < 0 || snapshot.bytes > MAX_BYTES || !Number.isInteger(snapshot.mode) || snapshot.mode < 0 || snapshot.mode > 0o777) fail('Invalid blob metadata');
  const data = await fs.readFile(await safePath(ctx.workspace, path.join(relative, name)));
  if (hash(data) !== snapshot.hash || data.length !== snapshot.bytes) fail('Damaged checkpoint blob: ' + name);
}

export async function run(argv) {
  const opts = options(argv);
  if (opts.command === 'help' || !opts.command) return { ok: true, usage: 'node change.mjs checkpoint|seal|status|accept|rollback --workspace DIR [--store RELATIVE_DIR] [--id ID] [--file RELATIVE_FILE ...] [--apply]', limits: { maxFiles: MAX_FILES, maxBytes: MAX_BYTES }, contract: 'Own listed files from checkpoint to seal. Stop same-file writers during rollback. Rollback defaults to read-only preview. Conflicts preserve all current files; resolve with a minimal manual patch. Never use git checkout/reset/clean/stash for this loop.' };
  if (!['checkpoint', 'seal', 'status', 'accept', 'rollback'].includes(opts.command)) fail('Unknown command');
  if (opts.apply && opts.command !== 'rollback') fail('--apply only supported for rollback');
  if (opts.command !== 'checkpoint' && opts.files.length) fail('Files only accepted by checkpoint');
  const ctx = await context(opts);
  if (opts.command === 'checkpoint') {
    const id = opts.id || randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) fail('Invalid --id');
    const files = [...new Set(opts.files.map(file => file.replaceAll('\\', '/')))];
    if (!files.length || files.length > MAX_FILES) fail('Checkpoint needs 1 to ' + MAX_FILES + ' explicit files');
    const collected = [];
    let total = 0;
    for (const relative of files) {
      allowedSource(relative, ctx.storeRelative);
      const item = await readSource(ctx.workspace, relative); total += item.snapshot.bytes;
      if (total > MAX_BYTES) fail('Checkpoint total exceeds byte limit');
      collected.push({ relative, ...item });
    }
    await fs.mkdir(ctx.store, { recursive: true });
    await safePath(ctx.workspace, ctx.storeRelative, { directory: true });
    const dir = path.join(ctx.store, id);
    await fs.mkdir(dir); // Exclusive creation: never overwrite even incomplete anchors.
    const manifest = { format: FORMAT, id, workspace: ctx.workspace, createdAt: new Date().toISOString(), files: collected.map((item, index) => ({ index, path: item.relative, before: item.snapshot })) };
    for (let index = 0; index < collected.length; index++) await blobWrite(dir, `before-${index}.blob`, collected[index].data);
    await jsonExclusive(path.join(dir, 'checkpoint.json'), manifest);
    return { ok: true, command: 'checkpoint', id, anchor: dir, state: 'checkpointed', files: manifest.files };
  }
  const loaded = await load(ctx, opts.id);
  const { dir, relative, manifest, seal } = loaded;
  const accepted = await exists(path.join(dir, 'accept.json'));
  const completed = await exists(path.join(dir, 'rollback.json'));
  const intentExists = await exists(path.join(dir, 'rollback-intent.json'));
  if (opts.command === 'status') return { ok: true, command: 'status', id: opts.id, anchor: dir, state: completed ? 'rolled_back' : intentExists ? 'rollback_interrupted' : accepted ? 'accepted' : seal ? 'sealed' : 'checkpointed', files: manifest.files, seal };
  if (opts.command === 'seal') {
    if (seal || accepted || completed || intentExists) fail('Checkpoint already sealed or finalized; use a new checkpoint for a new edit');
    const after = [];
    let total = 0;
    for (const entry of manifest.files) { const item = await readSource(ctx.workspace, entry.path); total += item.snapshot.bytes; if (total > MAX_BYTES) fail('Seal total exceeds byte limit'); after.push(item); }
    for (let index = 0; index < after.length; index++) await blobWrite(dir, `after-${index}.blob`, after[index].data);
    const value = { format: FORMAT, id: opts.id, sealedAt: new Date().toISOString(), files: manifest.files.map((entry, index) => ({ path: entry.path, after: after[index].snapshot })) };
    await jsonExclusive(path.join(dir, 'seal.json'), value);
    return { ok: true, command: 'seal', id: opts.id, state: 'sealed', files: value.files };
  }
  if (!seal) fail('Seal required; unsealed rollback cannot identify edits safely');
  if (completed) fail('Checkpoint already rolled back');
  const conflicts = [];
  const plan = [];
  for (let index = 0; index < manifest.files.length; index++) {
    const entry = manifest.files[index]; const after = seal.files[index].after;
    const current = (await readSource(ctx.workspace, entry.path)).snapshot;
    const resumed = intentExists && same(current, entry.before);
    if (!same(current, after) && !resumed) conflicts.push({ path: entry.path, expectedHash: after.hash, currentHash: current.hash, reason: 'Current contents changed after seal; preserve current file and resolve with a minimal manual patch' });
    plan.push({ path: entry.path, before: entry.before, after, action: same(entry.before, after) ? 'unchanged' : resumed ? 'already_restored' : entry.before.exists ? 'restore' : 'remove_created_file' });
  }
  if (conflicts.length) return { ok: false, command: opts.command, id: opts.id, error: 'Conflict; no files written', conflicts, anchor: dir };
  if (opts.command === 'accept') {
    if (intentExists) fail('Interrupted rollback must be resolved before accept');
    if (!accepted) await jsonExclusive(path.join(dir, 'accept.json'), { format: FORMAT, id: opts.id, acceptedAt: new Date().toISOString() });
    return { ok: true, command: 'accept', id: opts.id, state: 'accepted', anchor: dir };
  }
  if (!opts.apply) return { ok: true, command: 'rollback', id: opts.id, applied: false, plan, anchor: dir };
  if (!intentExists) await jsonExclusive(path.join(dir, 'rollback-intent.json'), { format: FORMAT, id: opts.id, startedAt: new Date().toISOString(), plan });
  else { const intent = await jsonRead(ctx.workspace, path.join(relative, 'rollback-intent.json')); if (intent.format !== FORMAT || intent.id !== opts.id || JSON.stringify(intent.plan?.map(item => ({ path: item.path, before: item.before, after: item.after }))) !== JSON.stringify(plan.map(item => ({ path: item.path, before: item.before, after: item.after })))) fail('Invalid rollback intent'); }
  for (let index = 0; index < plan.length; index++) {
    const item = plan[index]; if (item.action === 'unchanged' || item.action === 'already_restored') continue;
    const current = (await readSource(ctx.workspace, item.path)).snapshot;
    if (!same(current, item.after)) fail('File changed during rollback; stopped with durable intent: ' + item.path);
    const target = await safePath(ctx.workspace, item.path);
    if (item.before.exists) {
      const data = await fs.readFile(await safePath(ctx.workspace, path.join(relative, `before-${index}.blob`)));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await safePath(ctx.workspace, item.path);
      // Blob integrity checked above and again directly before replacement.
      if (hash(data) !== item.before.hash) fail('Damaged before blob');
      const temporary = target + '.self-maintenance-' + randomUUID();
      await durableExclusive(temporary, data);
      await fs.chmod(temporary, item.before.mode);
      if (!same((await readSource(ctx.workspace, item.path)).snapshot, item.after)) { await fs.unlink(temporary); fail('File changed immediately before restore: ' + item.path); }
      await fs.rename(temporary, target);
    } else await fs.unlink(target);
  }
  await jsonExclusive(path.join(dir, 'rollback.json'), { format: FORMAT, id: opts.id, completedAt: new Date().toISOString() });
  return { ok: true, command: 'rollback', id: opts.id, applied: true, state: 'rolled_back', plan, anchor: dir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await run(process.argv.slice(2)); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.ok) process.exitCode = 1; }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; }
}
