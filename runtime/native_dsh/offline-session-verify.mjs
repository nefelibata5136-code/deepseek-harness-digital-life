// Real installed profile, native JSONL, SQLite query and model-facing consumer.
// Dedicated test home; no model request or production Session is created.
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { boot, loadProfile, createRuntimeResolution, PluginPackages } from '@deepseek-ai/dsh-app-boot';
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';

const here = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(here, '../../reports/task_A');
const run = join(reportRoot, 'session-test-' + randomUUID());
await mkdir(run, { recursive: true });
process.env.DSH_HOME = resolve(here, 'home');
process.env.DSH_TELEMETRY_DISABLED = '1';
delete process.env.DEEPSEEK_API_KEY;
const cwd = '.local/workspace';
const installAnchor = resolve(here, 'node_modules/@deepseek-ai/dsh/package.json');
const profile = loadProfile('persona-session-test', 'persona', installAnchor);
const resolution = await createRuntimeResolution({ installAnchor, profile });
// Cordis resolves plugin packages relative to this deployment root.
const rootConfig = join(here, 'session-test-cordis.yml');
await writeFile(rootConfig, '[]\n');
async function open() {
  const patches = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches,
    { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
    { id: 'sessions', config: { root: join(run, 'sessions'), compression: 'none' } },
    { id: 'session-query-sqlite', config: { path: join(run, 'query.sqlite'), openAt: 'first-search' } }];
  return boot('persona-session-test', rootConfig, patches, async ctx => {
    ctx.provide('profileContext', { name: 'persona', dir: profile.dir, patchPath: profile.patchPath,
      installAnchor, cwd, home: process.env.DSH_HOME, startedBundles: profile.layers.map(layer => layer.packageName),
      overlays: [], telemetryDisabledEnv: '1' });
    await ctx.plugin(PluginPackages, { resolution });
  });
}
const target = SessionId(randomUUID()), other = SessionId(randomUUID());
const text = 'native-session-verification-needle ' + '完整原文'.repeat(6000) + ' END_OF_ORIGINAL';
let ctx = await open();
try {
  for (const [id, workspace, content] of [[target, cwd, text], [other, 'C:/unrelated-test-workspace', 'private workspace needle']]) {
    const writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id,
      createdAt: Date.now(), cwd: workspace, isSeeded: false });
    await writer.append([{ type: 'user/message', seq: SessionSeq(0), time: Date.now(),
      data: createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } }), surfaceOp: 'append' }]);
    await writer.close();
  }
} finally { await ctx.fiber.dispose(); }
async function files(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await files(path));
    else if (path.endsWith('.jsonl')) paths.push(path);
  }
  return paths;
}
const logFiles = await files(join(run, 'sessions'));
const hashes = async () => Promise.all(logFiles.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
const before = await hashes();
ctx = await open();
const checks = [];
function check(name, passed) { checks.push({ name, passed: Boolean(passed) }); if (!passed) throw new Error(name); }
try {
  const restored = await ctx.sessionQuery.readSession(target);
  check('restart_reads_exact_original_text', JSON.stringify(restored).includes(text));
  check('query_does_not_activate_target_session', !ctx.sessions.get(target));
  const caller = ctx.sessions.create(SessionId(randomUUID()), { meta: { cwd } });
  caller.append('turn/start', { turn: 1 });
  caller.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'technical query test' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  caller.append('step/start', { turn: 1, step: 1 });
  let id = 0;
  const execute = (name, args) => ctx.tools.execute({ name, arguments: args,
    callId: ToolCallId('offline-session-' + (++id)), signal: new AbortController().signal,
    agent: { id: caller.id, session: caller } });
  const content = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const found = await execute('session_search', { query: 'native-session-verification-needle' });
  check('native_model_facing_search_after_restart', !found.isError && content(found).includes(target));
  const read = await execute('session_event_read', { session_id: target, seq: 0 });
  check('native_event_read_no_silent_truncation', !read.isError && content(read).includes(text));
  const searched = await execute('session_event_search', { session_id: target, query: 'native-session-verification-needle' });
  check('native_event_search_after_restart', !searched.isError && content(searched).includes('seq 0'));
  const denied = await execute('session_event_read', { session_id: other, seq: 0 });
  check('other_workspace_is_rejected', denied.isError && !content(denied).includes('private workspace needle'));
  check('source_jsonl_unchanged_by_queries', JSON.stringify(before) === JSON.stringify(await hashes()));
  const result = { observed_at: new Date().toISOString(), passed: true, model_called: false,
    production_session_created: false, test_root: run, exact_original_characters: text.length,
    native_logs: before, checks };
  await writeFile(join(reportRoot, 'session_validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await ctx.fiber.dispose(); }
