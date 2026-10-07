/** Offline provider-boundary checks; only a synthetic login and mock Codex run are used. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ADVISOR_CONFIG, apply, createCodexAdvisor } from './codex-advisor.mjs';

test('full-access runs retain parent cwd, isolate login/records, preserve results and disposal', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'persona-advisor-'));
  try {
    const authSource = join(fixture, 'user-codex', 'auth.json');
    await mkdir(join(fixture, 'user-codex'));
    const synthetic = JSON.stringify({ tokens: { access_token: 'synthetic-offline-only' } });
    await writeFile(authSource, synthetic);
    await writeFile(join(fixture, 'user-codex', 'config.toml'), 'sandbox_mode = "danger-full-access"\n[mcp_servers.unsafe]\ncommand = "unsafe"\n');
    let disposed = 0;
    const calls = [];
    const originalParent = { session: { header: { id: 'seat', cwd: join(fixture, 'original-space') } } };
    await mkdir(originalParent.session.header.cwd);
    const output = '完整建议' + 'abcdef'.repeat(10000);
    const raw = { capabilities: {}, async start(request) {
      calls.push(request);
      await writeFile(join(request.parent.session.header.cwd, 'advice.txt'), output);
      return { id: 'mock-' + calls.length, result: Promise.resolve({ output: [{ type: 'text', text: output }], stopReason: 'completed' }),
        dispose() { disposed++; } };
    } };
    const advisor = createCodexAdvisor(raw, { protectedRoot: join(fixture, 'life'), authSource });
    const request = { parent: originalParent, signal: new AbortController().signal, prompt: [{ type: 'text', text: '分析' }] };
    const runs = await Promise.all([advisor.provider.start(request), advisor.provider.start(request)]);
    const actualConfig = await readFile(join(advisor.home, 'config.toml'), 'utf8');
    assert.ok(actualConfig.startsWith(ADVISOR_CONFIG));
    assert.match(actualConfig, /sandbox_mode = "danger-full-access"/);
    assert.match(actualConfig, /approval_policy = "never"/);
    assert.match(actualConfig, /shell_tool = true/);
    assert.match(actualConfig, /apps = false/);
    assert.equal(await readFile(join(advisor.home, 'auth.json'), 'utf8'), synthetic);
    assert.equal(await readFile(authSource, 'utf8'), synthetic);
    assert.match(await readFile(join(fixture, 'user-codex', 'config.toml'), 'utf8'), /danger-full-access/);
    assert.equal(calls[0].parent.session.header.cwd, originalParent.session.header.cwd);
    assert.equal(calls[1].parent.session.header.cwd, originalParent.session.header.cwd);
    assert.equal(request.parent, originalParent);
    assert.equal(originalParent.session.header.cwd, join(fixture, 'original-space'));
    assert.match(calls[0].prompt[0].text, /没有人格身份和正式发言权/);
    const result = await runs[0].result;
    assert.equal(result.output[0].text, output);
    const metadata = JSON.parse(result.output[1].text);
    assert.equal(metadata.source, 'advisor');
    assert.equal(metadata.authoritative, false);
    assert.equal(metadata.access,'danger-full-access');
    assert.notEqual(metadata.runRecordDirectory,JSON.parse((await runs[1].result).output[1].text).runRecordDirectory);
    assert.equal(await readFile(join(metadata.workDirectory, 'advice.txt'), 'utf8'), output);
    assert.equal(JSON.stringify(result).includes('synthetic-offline-only'), false);
    await Promise.all(runs.map(run => run.dispose()));
    assert.equal(disposed, 2);
    const refreshed = JSON.stringify({ tokens: { access_token: 'synthetic-refreshed-in-isolation' } });
    await writeFile(join(advisor.home, 'auth.json'), refreshed);
    const repeated = await advisor.provider.start(request);
    assert.equal(await readFile(join(advisor.home, 'auth.json'), 'utf8'), refreshed);
    await repeated.dispose();
    const sourceChanged = JSON.stringify({ tokens: { access_token: 'synthetic-source-login-changed' } });
    await writeFile(authSource, sourceChanged);
    const resynced = await advisor.provider.start(request);
    assert.equal(await readFile(join(advisor.home, 'auth.json'), 'utf8'), sourceChanged);
    await resynced.dispose();
    await assert.rejects(advisor.provider.start({ ...request,
      parent: { session: { header: { cwd: fixture } } } }), /WORKSPACE_OVERLAP/);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(advisor.provider.start({ ...request, signal: cancelled.signal }));
    assert.equal(calls.length, 4);
    const invalid = createCodexAdvisor(raw, { protectedRoot: join(fixture, 'missing-life'), authSource: join(fixture, 'absent-auth') });
    await assert.rejects(invalid.provider.start(request), /LOGIN_HOME_UNAVAILABLE/);
    assert.equal(calls.length, 4);
  } finally {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
    assert.ok(resolve(fixture).split(sep).at(-1).startsWith('persona-advisor-'));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('registration uses the official effect-owned provider registry', () => {
  let registered;
  let removed = 0;
  const listeners = {};
  const effects = [];
  const raw = { name: 'codex-native', capabilities: {}, start() { throw new Error('not called'); } };
  const ctx = { subagents: { getProvider: name => name === 'codex-native' ? raw : undefined,
    registerProvider: provider => { registered = provider; return () => { removed++; }; } },
    on: (name, fn) => { listeners[name] = fn; }, effect: fn => { effects.push(fn()); } };
  apply(ctx, { protectedRoot: join(tmpdir(), 'offline-no-write') });
  assert.equal(registered.name, 'codex');
  assert.equal(registered.capabilities, raw.capabilities);
  listeners['subagent/provider-added'](raw);
  assert.equal(removed, 0);
  listeners['subagent/provider-removed']('codex-native');
  assert.equal(removed, 1);
  listeners['subagent/provider-added'](raw);
  assert.equal(registered.name, 'codex');
  effects[0]();
  assert.equal(removed, 2);
  registered = undefined;
  const lateCtx = { ...ctx, subagents: { ...ctx.subagents, getProvider: () => undefined } };
  apply(lateCtx, { protectedRoot: join(tmpdir(), 'offline-no-write') });
  assert.equal(registered, undefined);
  listeners['subagent/provider-added'](raw);
  assert.equal(registered.name, 'codex');
});
