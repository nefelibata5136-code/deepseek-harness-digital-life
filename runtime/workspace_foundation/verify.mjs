// Real pinned Harness services and Agent loop, distinct technical Sessions, no adapter/API.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, copyFile, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { native, nativeRequire, here } from './native.mjs';
import { mountWorkspaceVersions } from './lifecycle.mjs';
import { mountNativeFiles } from './files.mjs';
import { mountWorkspaceSkills } from './skills.mjs';
import { loadHelloPlugin } from './extensions.mjs';

const reports = resolve(here, '../../reports/task_B');
const root = resolve(reports, 'acceptance-' + randomUUID());
await mkdir(root, { recursive: true });
const python = process.env.TASK_B_PYTHON ?? 'python';
const checks = [];
const evidence = { observed_at: new Date().toISOString(), native_version: nativeRequire('@deepseek-ai/dsh/package.json').version,
  root, model_calls: 0, formal_persona_started: false, checks };
const runPython = (file, args, input) => {
  const result = spawnSync(python, ['-B', '-X', 'utf8', resolve(here, file), ...args],
    { input, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => ['DL_PYTHON', 'DL_WORKSPACE', 'DL_DATA', 'DSH_HOME', 'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(k.toUpperCase()))) });
  if (result.status !== 0) throw new Error(result.stderr || 'Python verification failed');
  return JSON.parse(result.stdout);
};
evidence.versions = runPython('verify_versions.py', [resolve(root, 'version-fixtures')]);
checks.push(...evidence.versions.checks);
const workspace = resolve(root, 'native-workspace');
const readonly = resolve(root, 'readonly');
await mkdir(workspace);
await mkdir(readonly);
await writeFile(resolve(workspace, 'existing.txt'), 'initial\n');
await writeFile(resolve(workspace, 'rename.txt'), 'rename content\n');
await writeFile(resolve(workspace, 'delete.txt'), 'delete content\n');
await writeFile(resolve(readonly, 'original.txt'), 'read-only original\n');
await mkdir(resolve(workspace, '.dsh/skills/persona-hello-world'), { recursive: true });
await mkdir(resolve(workspace, 'development/plugins/hello-world'), { recursive: true });
await copyFile('.local/workspace/.dsh/skills/persona-hello-world/SKILL.md', resolve(workspace, '.dsh/skills/persona-hello-world/SKILL.md'));
await copyFile(resolve(here, 'hello-plugin.mjs'), resolve(workspace, 'development/plugins/hello-world/plugin.mjs'));
const { Context } = await native('cordis');
const ctx = new Context();
let foundation, testError;
const toolReceipts = [];
const sessionEvents = [];
try {
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop']) {
    const plugin = await native(name);
    await ctx.plugin(plugin.default, name === 'dsh-agent-loop' ? { agents: [] } : {});
  }
  // Zero model requests is enforced at both lifecycle and transport.
  ctx.on('llm/stream', () => { evidence.model_calls++; throw new Error('No model calls permitted in task B acceptance'); });
  await mountNativeFiles(ctx, { workspace, readRoots: [readonly] });
  await mountWorkspaceSkills(ctx, { workspace });
  foundation = mountWorkspaceVersions(ctx, { python, workspace, store: resolve(root, 'native-versions') });
  ctx.on('session/event', (session, event) => { sessionEvents.push({ session: session.id, ...event }); });
  const { ToolCallId, createUserMessage } = await native('dsh-llm');
  const { defineTool } = await native('dsh-tools');
  // Test registration uses the existing production terminal backend; removed on ctx disposal.
  ctx.tools.register(defineTool({ name: 'terminal', description: 'task B restricted terminal fixture',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return runPython('terminal_bridge.py', ['--workspace', workspace], JSON.stringify({ command: args.command })); },
  }));
  const { SessionId } = await native('dsh-session');
  const agent = await ctx.agentLoop.create(SessionId('task-B-' + randomUUID()), {}, { cwd: workspace });
  const call = async (name, args, error) => {
    const result = await agent.ctx.tools.execute({ name, arguments: args, agent,
      callId: ToolCallId(randomUUID()), signal: new AbortController().signal });
    toolReceipts.push({ name, args, result });
    if (error) {
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result), error);
    } else assert.notEqual(result.isError, true, JSON.stringify(result));
    return result;
  };
  let phase = 0;
  ctx.on('agent/pre-step', async ({ agent: subject }, _next) => {
    if (subject !== agent) return _next();
    try {
      if (phase++ === 0) {
        assert.equal(foundation.run('check').active_turn.session, agent.session.id);
        await call('write', { file_path: resolve(workspace, 'existing.txt'), content: 'must fail\n' }, /FS_ALREADY_EXISTS|already exists|not been read/);
        assert.equal(await readFile(resolve(workspace, 'existing.txt'), 'utf8'), 'initial\n');
        await call('read', { file_path: resolve(workspace, 'existing.txt') });
        await call('write', { file_path: resolve(workspace, 'existing.txt'), content: 'native write\n' });
        await call('edit', { file_path: resolve(workspace, 'existing.txt'), old_string: 'native', new_string: 'official' });
        assert.equal(await readFile(resolve(workspace, 'existing.txt'), 'utf8'), 'official write\n');
        await writeFile(resolve(workspace, 'existing.txt'), 'external update\n');
        await call('write', { file_path: resolve(workspace, 'existing.txt'), content: 'stale must fail' }, /FS_STALE_VERSION|stale|changed/);
        assert.equal(await readFile(resolve(workspace, 'existing.txt'), 'utf8'), 'external update\n');
        await call('read', { file_path: resolve(workspace, 'existing.txt') });
        await call('write', { file_path: resolve(workspace, 'existing.txt'), content: 'fresh native write\n' });
        await call('read', { file_path: resolve(readonly, 'original.txt') });
        await call('write', { file_path: resolve(readonly, 'original.txt'), content: 'deny' }, /read-only|authorized|sandbox/i);
        await writeFile(resolve(workspace, '.env'), 'DUMMY=exclude');
        await call('read', { file_path: resolve(workspace, '.env') }, /credential/i);
        await writeFile(resolve(workspace, 'sensitive.txt'), 'api_key=' + 'X'.repeat(24));
        await call('read', { file_path: resolve(workspace, 'sensitive.txt') }, /credential/i);
        const skillPath = resolve(workspace, '.dsh/skills/persona-hello-world/SKILL.md');
        evidence.skill_catalog = await ctx.skills.list({ cwd: workspace, scope: agent });
        assert.ok(evidence.skill_catalog.some(item => item.name === 'persona-hello-world'));
        await call('skill', { name: 'persona-hello-world' });
        await call('read', { file_path: skillPath });
        const updated = (await readFile(skillPath, 'utf8')).replace('Hello from Persona skill', 'UPDATED skill body');
        await call('write', { file_path: skillPath, content: updated });
        const loaded = await call('skill', { name: 'persona-hello-world' });
        assert.match(JSON.stringify(loaded), /UPDATED skill body/);
        const disabled = await loadHelloPlugin(ctx);
        assert.equal(disabled.enabled, false);
        assert.equal(ctx.tools.get('persona_hello'), undefined);
        const enabled = await loadHelloPlugin(ctx, { enabled: true, workspace });
        await call('persona_hello', {});
        await enabled.stop();
        assert.equal(ctx.tools.get('persona_hello'), undefined);
        await call('persona_hello', {}, /UNKNOWN_TOOL|not found|unknown|unavailable/i);
        const candidate = resolve(workspace, 'development/plugins/hello-world/plugin.mjs');
        await writeFile(candidate, '// changed unreviewed\n');
        await assert.rejects(loadHelloPlugin(ctx, { enabled: true, workspace }), /reviewed release/);
        await copyFile(resolve(here, 'hello-plugin.mjs'), candidate);
        // Reuse actual Windows restricted-token terminal. It is not a new production tool.
        const terminalResult = await call('terminal', {
          command: 'node -e "const fs=require(\'fs\');fs.writeFileSync(\'terminal.txt\',\'terminal change\');fs.renameSync(\'rename.txt\',\'renamed.txt\');fs.unlinkSync(\'delete.txt\');"' });
        const terminal = terminalResult.value;
        evidence.terminal = terminal;
        assert.equal(terminal.returncode, 0, JSON.stringify(terminal));
        assert.equal(terminal.restricted, true);
        assert.equal(await readFile(resolve(workspace, 'terminal.txt'), 'utf8'), 'terminal change');
        assert.equal(await readFile(resolve(workspace, 'renamed.txt'), 'utf8'), 'rename content\n');
        evidence.protected_terminal = runPython('terminal_bridge.py', ['--workspace', workspace], JSON.stringify({
          command: 'node -e "const fs=require(\'fs\');try{fs.writeFileSync(' + JSON.stringify(resolve(here, 'protected-denial-test.txt')).replaceAll('"', '\\"') + ',\'deny\');process.exit(9)}catch(e){console.log(e.code)}"' }));
        assert.equal(evidence.protected_terminal.returncode, 0, JSON.stringify(evidence.protected_terminal));
        assert.match(evidence.protected_terminal.stdout, /EACCES|EPERM/);
        const protectedPaths = [resolve(here, 'snapshots.py'), resolve(here, 'protected/persona/history.git/HEAD')];
        evidence.protected_existing_handles = runPython('terminal_bridge.py', ['--workspace', workspace], JSON.stringify({
          command: 'node -e "const fs=require(\'fs\');for(const p of ' + JSON.stringify(protectedPaths).replaceAll('"', '\\"')
            + '){try{fs.closeSync(fs.openSync(p,\'r+\'));process.exit(9)}catch(e){console.log(e.code)}}"' }));
        assert.equal(evidence.protected_existing_handles.returncode, 0, JSON.stringify(evidence.protected_existing_handles));
        assert.equal(evidence.protected_existing_handles.stdout.trim().split(/\r?\n/).length, 2);
        assert.match(evidence.protected_existing_handles.stdout, /EACCES|EPERM/);
      } else {
        const result = await call('skill', { name: 'persona-hello-world' });
        assert.match(JSON.stringify(result), /TERMINAL UPDATED body/);
      }
    } catch (error) { testError = error; }
    // A real native turn closes without ever assembling/dispatching a model request.
    return { kind: 'reject' };
  });
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'isolated technical acceptance' }] }));
  await agent.whenIdle();
  if (testError) throw testError;
  foundation.assertHealthy();
  const after = foundation.run('check');
  assert.equal(after.active_turn, null);
  assert.deepEqual(after.changes, []);
  evidence.native_post_turn = after;
  const skillPath = resolve(workspace, '.dsh/skills/persona-hello-world/SKILL.md');
  await writeFile(skillPath, (await readFile(skillPath, 'utf8')).replace('UPDATED skill body', 'TERMINAL UPDATED body'));
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'verify skill body reread' }] }));
  await agent.whenIdle();
  if (testError) throw testError;
  foundation.assertHealthy();
  assert.equal(sessionEvents.filter(e => e.type === 'turn/start').length, 2);
  assert.equal(sessionEvents.filter(e => e.type === 'turn/end').length, 2);
  assert.equal(evidence.model_calls, 0);
  // Verify the exact aggregate plugin entry handed to A, not only its component functions.
  const aggregateWorkspace = resolve(root, 'aggregate-workspace');
  await mkdir(aggregateWorkspace);
  await writeFile(resolve(aggregateWorkspace, 'baseline.txt'), 'aggregate baseline\n');
  const aggregateCtx = new Context();
  try {
    for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop'])
      await aggregateCtx.plugin((await native(name)).default, name === 'dsh-agent-loop' ? { agents: [] } : {});
    aggregateCtx.on('llm/stream', () => { evidence.model_calls++; throw new Error('No model calls'); });
    await aggregateCtx.plugin(await import('./plugin.mjs'), { python, workspace: aggregateWorkspace,
      store: resolve(root, 'aggregate-versions'), helloEnabled: false });
    assert.ok(aggregateCtx.get('workspaceFoundation'));
    aggregateCtx.on('agent/pre-step', async () => ({ kind: 'reject' }));
    aggregateCtx.on('session/event', (session, event) => { sessionEvents.push({ session: session.id, ...event }); });
    const aggregateAgent = await aggregateCtx.agentLoop.create(SessionId('task-B-composition-' + randomUUID()), {}, { cwd: aggregateWorkspace });
    aggregateAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'composition acceptance only' }] }));
    await aggregateAgent.whenIdle();
    aggregateCtx.workspaceFoundation.assertHealthy();
    assert.equal(aggregateCtx.workspaceFoundation.run('check').active_turn, null);
    evidence.aggregate_plugin = { loaded: true, native_turn_completed: true, hello_default_disabled: aggregateCtx.tools.get('persona_hello') === undefined };
  } finally { await aggregateCtx.fiber.dispose(); }
  assert.equal(evidence.model_calls, 0);
  checks.push('real-native-agent-loop-two-turns', 'native-read-before-write', 'native-write-and-edit',
    'native-stale-write-denied', 'native-readonly-denied', 'credential-read-denied',
    'skill-real-discovery', 'skill-official-write-refresh', 'skill-external-update-read',
    'plugin-default-disabled', 'plugin-official-load-tool', 'plugin-dispose-unregisters',
    'plugin-modified-code-denied', 'restricted-terminal-write-rename-delete', 'protected-controller-terminal-denied',
    'protected-controller-and-real-history-write-handles-denied', 'post-turn-all-changes-captured',
    'aggregate-cordis-entry-real-session-verified', 'zero-model-calls');
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await ctx.fiber.dispose();
  await writeFile(resolve(root, 'native-session-events.jsonl'), sessionEvents.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(resolve(root, 'tool-receipts.json'), JSON.stringify(toolReceipts, null, 2) + '\n');
  evidence.session_events_sha256 = createHash('sha256').update(await readFile(resolve(root, 'native-session-events.jsonl'))).digest('hex');
  // Keep append-only Git evidence and logs; remove only owned technical workspaces.
  for (const path of [workspace, readonly, resolve(root, 'aggregate-workspace'), resolve(root, 'version-fixtures/workspace')]) {
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe fixture cleanup');
    await rm(path, { recursive: true, force: true });
  }
  evidence.test_workspaces_removed = true;
  await writeFile(resolve(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  await writeFile(resolve(reports, 'latest-acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ passed: evidence.passed, checks: checks.length, model_calls: evidence.model_calls,
    evidence: resolve(root, 'result.json'), error: evidence.error?.message }, null, 2));
}
