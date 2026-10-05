#!/usr/bin/env node
// Offline acceptance: creates only an isolated OS temp workspace; no Host/API/Git.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from './change.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const tempBase = path.basename(scriptDir) === 'self-maintenance' && path.basename(path.dirname(scriptDir)) === 'tools' ? scriptDir : os.tmpdir();
const root = await fs.mkdtemp(path.join(tempBase, 'persona-change-'));
const workspace = path.join(root, 'workspace');
await fs.mkdir(workspace);
const passed = [];
const file = relative => path.join(workspace, relative);
const write = (relative, data) => fs.writeFile(file(relative), data);
const read = relative => fs.readFile(file(relative), 'utf8');
const command = (action, id, ...extra) => run([action, '--workspace', workspace, '--id', id, ...extra]);
async function rejects(fn, pattern) { await assert.rejects(fn, pattern); }
async function cliRun(script, args, name) {
  // Restricted Windows children cannot create their own capture pipes. Inherit
  // already-open fixture file handles; still exercise the actual CLI and JSON.
  const stdoutPath = path.join(root, name + '-stdout.json');
  const stderrPath = path.join(root, name + '-stderr.txt');
  const stdout = await fs.open(stdoutPath, 'w');
  const stderr = await fs.open(stderrPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, ['--preserve-symlinks-main', '--preserve-symlinks', script, ...args], { stdio: ['inherit', stdout.fd, stderr.fd], windowsHide: true });
  } finally { await stdout.close(); await stderr.close(); }
  return { ...result, stdout: await fs.readFile(stdoutPath, 'utf8'), stderr: await fs.readFile(stderrPath, 'utf8') };
}
try {
  await write('owned.txt', 'preexisting uncommitted change\n');
  await write('other.txt', 'other agent initial\n');
  const anchor = await command('checkpoint', 'dirty', '--file', 'owned.txt');
  await write('owned.txt', 'my change\n');
  await write('other.txt', 'other agent new work\n');
  await command('seal', 'dirty');
  const beforePreview = await read('owned.txt');
  const preview = await command('rollback', 'dirty');
  assert.equal(preview.applied, false); assert.equal(await read('owned.txt'), beforePreview);
  await rejects(() => fs.access(path.join(anchor.anchor, 'rollback-intent.json')), /ENOENT/);
  await command('rollback', 'dirty', '--apply');
  assert.equal(await read('owned.txt'), 'preexisting uncommitted change\n');
  assert.equal(await read('other.txt'), 'other agent new work\n');
  passed.push('dirty baseline restored; unrelated edits kept; preview writes nothing');

  await command('checkpoint', 'conflict', 'owned.txt', 'other.txt');
  await write('owned.txt', 'mine\n'); await write('other.txt', 'mine other\n');
  await command('seal', 'conflict');
  await write('other.txt', 'concurrent after seal\n');
  const conflict = await command('rollback', 'conflict', '--apply');
  assert.equal(conflict.ok, false); assert.equal(conflict.conflicts.length, 1);
  assert.equal(await read('owned.txt'), 'mine\n'); assert.equal(await read('other.txt'), 'concurrent after seal\n');
  passed.push('same-file conflict refuses ALL writes and retains both agents changes');

  await command('checkpoint', 'new_delete', 'new.txt', 'owned.txt');
  await write('new.txt', 'created\n'); await fs.unlink(file('owned.txt'));
  await command('seal', 'new_delete'); await command('rollback', 'new_delete', '--apply');
  await rejects(() => fs.access(file('new.txt')), /ENOENT/); assert.equal(await read('owned.txt'), 'mine\n');
  passed.push('new file removed and deleted file restored');

  for (const bad of ['../outside.txt', '/outside.txt', 'x/../owned.txt', '.. /outside.txt', 'CON.txt', '.Git/config', 'development/.checkpoints/x', '.env', 'private-vault/data.json']) {
    await rejects(() => command('checkpoint', 'invalid', bad), /refused|Expected|traversal|checkpointed/i);
  }
  await rejects(() => run(['checkpoint', '--workspace', workspace, '--store', '../outside', 'owned.txt']), /inside workspace/);
  await write('secret.txt', 'api_key = "unambiguouslySecretToken123"\n');
  await rejects(() => command('checkpoint', 'secret', 'secret.txt'), /credential/);
  const external = path.join(root, 'external'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'file.txt'), 'external\n');
  await fs.symlink(external, file('linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await rejects(() => command('checkpoint', 'link', 'linked/file.txt'), /Links/);
  await fs.mkdir(file('ordinary')); await write('ordinary/file.txt', 'in-workspace target\n');
  await fs.symlink(file('ordinary'), file('linked_inside'), process.platform === 'win32' ? 'junction' : 'dir');
  await rejects(() => command('checkpoint', 'link_inside', 'linked_inside/file.txt'), /Links/);
  await rejects(() => run(['checkpoint', '--workspace', file('linked_inside'), '--id', 'linked_root', 'file.txt']), /real directory/);
  await fs.link(file('owned.txt'), file('hard.txt'));
  await rejects(() => command('checkpoint', 'hardlink', 'hard.txt'), /Hard links/); await fs.unlink(file('hard.txt'));
  passed.push('path traversal, outside store, links, hard links, secret paths/literals refused');

  const crashed = await command('checkpoint', 'crashed', 'owned.txt');
  await write('owned.txt', 'edited but process crashed before seal\n');
  await rejects(() => command('rollback', 'crashed', '--apply'), /Seal required/);
  assert.equal(await fs.readFile(path.join(crashed.anchor, 'before-0.blob'), 'utf8'), 'mine\n');
  await rejects(() => command('checkpoint', 'crashed', 'owned.txt'), /EEXIST/);
  await command('seal', 'crashed'); await command('rollback', 'crashed', '--apply'); assert.equal(await read('owned.txt'), 'mine\n');
  passed.push('pre-seal crash retains immutable baseline; reuse refuses overwrite');

  const sealCrash = await command('checkpoint', 'seal_crash', 'owned.txt');
  await write('owned.txt', 'edit before sealing crash\n');
  await fs.writeFile(path.join(sealCrash.anchor, 'after-0.blob'), 'edit before sealing crash\n');
  await command('seal', 'seal_crash');
  await command('rollback', 'seal_crash', '--apply'); assert.equal(await read('owned.txt'), 'mine\n');
  const sealTorn = await command('checkpoint', 'seal_torn', 'owned.txt');
  await write('owned.txt', 'complete edit\n'); await fs.writeFile(path.join(sealTorn.anchor, 'after-0.blob'), 'incomplete');
  await rejects(() => command('seal', 'seal_torn'), /Existing blob differs/);
  assert.equal(await fs.readFile(path.join(sealTorn.anchor, 'before-0.blob'), 'utf8'), 'mine\n');
  assert.equal(await read('owned.txt'), 'complete edit\n');
  await write('owned.txt', 'mine\n');
  passed.push('interrupted seal reuses identical blob; torn blob refused with baseline retained');

  const damaged = await command('checkpoint', 'damaged', 'owned.txt');
  await write('owned.txt', 'after damage test\n'); await command('seal', 'damaged');
  await fs.writeFile(path.join(damaged.anchor, 'before-0.blob'), 'corrupted');
  await rejects(() => command('rollback', 'damaged', '--apply'), /Damaged checkpoint/);
  await rejects(() => command('checkpoint', 'damaged', 'owned.txt'), /EEXIST/);
  assert.equal(await read('owned.txt'), 'after damage test\n');
  passed.push('damaged checkpoint refuses restore and cannot be overwritten');

  const resume = await command('checkpoint', 'resume', 'owned.txt', 'other.txt');
  await write('owned.txt', 'first edited\n'); await write('other.txt', 'second edited\n'); await command('seal', 'resume');
  const resumePlan = await command('rollback', 'resume');
  // Simulates a durable intent plus process death after restoring first file.
  await fs.writeFile(path.join(resume.anchor, 'rollback-intent.json'), JSON.stringify({ format: 1, id: 'resume', startedAt: new Date().toISOString(), plan: resumePlan.plan }));
  await write('owned.txt', 'after damage test\n');
  await command('rollback', 'resume', '--apply');
  assert.equal(await read('owned.txt'), 'after damage test\n'); assert.equal(await read('other.txt'), 'concurrent after seal\n');
  passed.push('interrupted multi-file rollback resumes safely from durable intent');

  await command('checkpoint', 'accept', 'owned.txt'); await write('owned.txt', 'accepted change\n');
  await command('seal', 'accept'); await command('accept', 'accept');
  assert.equal((await command('status', 'accept')).state, 'accepted');
  assert.equal(await read('owned.txt'), 'accepted change\n');
  const script = fileURLToPath(new URL('./change.mjs', import.meta.url));
  const cli = await cliRun(script, ['status', '--workspace', workspace, '--id', 'accept'], 'status');
  assert.equal(cli.status, 0, JSON.stringify({ error: cli.error?.message, stderr: cli.stderr })); assert.equal(JSON.parse(cli.stdout).state, 'accepted');
  const force = await cliRun(script, ['rollback', '--workspace', workspace, '--id', 'accept', '--force'], 'force');
  assert.equal(force.status, 1); assert.match(JSON.parse(force.stdout).error, /Unknown option/);
  passed.push('accept keeps edits; CLI emits JSON; no force bypass');
  console.log(JSON.stringify({ ok: true, tests: passed, count: passed.length }, null, 2));
} finally {
  // Verified absolute generated temp root only; never the real workspace/store.
  assert.ok(root.startsWith(path.join(tempBase, 'persona-change-')));
  await fs.rm(root, { recursive: true, force: true });
}
