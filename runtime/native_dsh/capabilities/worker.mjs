/** One disposable native Cordis composition per capability; no model loop. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { boot, loadProfileDirectory, createRuntimeResolution, PluginPackages } from '@deepseek-ai/dsh-app-boot';
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Resources from '@deepseek-ai/dsh-mcp-resources';
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials';
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory';

const pendingCredentials = new Map();
const calls = new Map();
let ctx;
let stopping = false;
let maxOutputBytes = 4 * 1024 * 1024;
const send = value => {
  if (!process.connected) return;
  // Bound messages before the IPC serializer allocates them in the parent.
  if (Buffer.byteLength(JSON.stringify(value)) > maxOutputBytes)
    return process.send({ type: 'output-limit' });
  process.send(value);
};
function credentialRequest(action, name) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    pendingCredentials.set(id, { resolve, reject });
    send({ type: 'credential', id, action, name });
  });
}
class References extends CredentialProvider {
  resolve(ref) { return credentialRequest('resolve', String(credentialRef(ref))); }
  describe(ref) { return credentialRequest('describe', String(credentialRef(ref))); }
  set() { throw new Error('Set capability credentials through the maintainer credential command'); }
  unset() { throw new Error('Remove capability credentials through the maintainer credential command'); }
  readRecord() { throw new Error('OAuth records require a reviewed native credential provider'); }
  describeRecord() { return Promise.resolve({ configured: false, writable: false }); }
  listRecords() { return Promise.resolve([]); }
  modifyRecord() { throw new Error('OAuth records require a reviewed native credential provider'); }
  deleteRecord() { throw new Error('OAuth records require a reviewed native credential provider'); }
}
async function start(input) {
  maxOutputBytes = input.maxOutputBytes;
  const installAnchor = resolve(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/package.json');
  const profile = loadProfileDirectory('persona-capability', input.profile, installAnchor);
  if (profile.skippedBundles.length) throw new Error('Bundle could not be loaded');
  const resolution = await createRuntimeResolution({ installAnchor, profile, home: input.home });
  ctx = await boot('persona-capability', resolve(profile.dir, 'cordis.yml'),
    [...profile.layers.flatMap(layer => layer.patches), ...profile.patches], async inner => {
      await inner.plugin(PluginPackages, { resolution });
      await inner.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false,
        personaPrefix: '', personaSuffix: '' });
      await inner.plugin(Tools, { mode: 'native' });
      await inner.plugin(Resources);
      await inner.plugin(References);
    });
  const inventory = await readPluginInventory(ctx);
  if (inventory.entries.some(row => row.enabled && row.fiberPhase !== 'active'))
    throw new Error('Capability plugin did not activate; required service may be unavailable');
  const discovery = async () => ({ schemas: ctx.tools.schemas(),
    instructions: (await ctx.systemPrompt.assemble()).sections.filter(section => section.name.startsWith('mcp:'))
      .map(section => ({ source: section.name, text: section.text })) });
  ctx.on('tools/change', () => void discovery().then(data => send({ type: 'schemas', ...data })).catch(() => send({ type: 'startup-failed' })));
  send({ type: 'ready', ...await discovery(), pid: process.pid });
}
async function execute(input) {
  const controller = new AbortController();
  calls.set(input.id, controller);
  try {
    const schema = ctx.tools.schemas().find(row => row.name === input.name);
    if (!schema || validateJsonSchemaValue(schema.parameters, input.arguments).length)
      throw new Error('Invalid or unavailable tool');
    const result = await ctx.tools.execute({ name: input.name, arguments: input.arguments,
      callId: input.callId, signal: controller.signal });
    // Agent contexts/attachments cannot be transplanted across a process.
    if (result.additionalContexts?.length || result.concludesTurn)
      throw new Error('This plugin requires an Agent-scoped Host integration');
    send({ type: 'result', id: input.id, result });
  } catch {
    send({ type: 'failure', id: input.id, error: 'CAPABILITY_TOOL_FAILED' });
  } finally { calls.delete(input.id); }
}
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const controller of calls.values()) controller.abort();
  for (const entry of pendingCredentials.values()) entry.reject(new Error('Worker stopping'));
  pendingCredentials.clear();
  await ctx?.fiber.dispose();
  process.exit(0);
}
process.on('message', input => {
  if (input.type === 'credential-result') {
    const entry = pendingCredentials.get(input.id);
    pendingCredentials.delete(input.id);
    if (input.ok) entry?.resolve(input.result ?? undefined);
    else entry?.reject(new Error('Credential reference denied or unavailable'));
  } else if (input.type === 'init') {
    void start(input).catch(() => { send({ type: 'startup-failed' }); process.exit(1); });
  } else if (input.type === 'call') void execute(input);
  else if (input.type === 'cancel') calls.get(input.id)?.abort();
  else if (input.type === 'stop') void stop();
});
process.on('disconnect', () => void stop());
