// Isolated composition check. No model request, no child start, no desktop attachment.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootNative, here } from './boot-native.mjs';
const root = resolve(here, '../../reports/subagents/composition-' + randomUUID());
const workspace = resolve(root, 'workspace');
const sources = ['home/profiles/persona/cordis.patch.yml', 'home/profiles/persona/package.json',
  'persona-plugin.mjs', 'package.json', 'package-lock.json'];
const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async name =>
  ['runtime/native_dsh/' + name, createHash('sha256').update(await readFile(resolve(here, name))).digest('hex')])));
await mkdir(workspace, { recursive: true });
await writeFile(resolve(workspace, 'persona-core.md'), '# Isolated composition check\n');
await writeFile(resolve(workspace, 'AGENTS.md'), '# No model calls\n');
process.env.DEEPSEEK_API_KEY = 'offline-placeholder-not-a-secret';
const id = randomUUID();
const ctx = await bootNative({ sessionId: id, testRoot: root });
try {
  await ctx.sessionController.create({ sessionId: id, cwd: workspace });
  const resolved = await ctx.sessionController.resolveAgent(id);
  if ('error' in resolved) throw resolved.error;
  const names = resolved.agent.ctx.tools.schemas(resolved.agent).map(t => t.name);
  const expected = ['subagent', 'send_message', 'list_agents', 'interrupt_agent', 'subagent_codex'];
  for (const name of expected) assert(names.includes(name), 'Missing model-facing tool: ' + name);
  assert(ctx.subagents.getProvider('spawn').prepareContinuable);
  assert(!ctx.subagents.getProvider('codex').prepareContinuable);
  const result = { passed: true, observedAt: new Date().toISOString(), modelCalls: 0,
    tools: expected, spawnContinuable: true, codexOneShot: true, sourceSha256, root };
  await writeFile(resolve(here, '../../reports/subagents/composition.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await ctx.fiber.dispose(); }
