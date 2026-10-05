/** Actual native spawn creation/scoped Tools/bus policy, with local worker fixture.
 * No paid model, production Session, real credentials or Bluesky writes.
 * The fixture verifies permissions; live Bluesky acceptance remains separate.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { childSessionMeta, applyChildComposition, resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent';
import { bootNative, here } from '../boot-native.mjs';
import { registerProfile, approveProfile, withManager, readEntry, saveEntry } from './profiles.mjs';
const root = resolve(here, '../../reports/bluesky-child-access-' + randomUUID());
const profiles = join(root, 'capability-profiles');
const workspace = join(root, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'AGENTS.md'), '# Isolated permission fixture\n');
await writeFile(join(workspace, 'persona-core.md'), '# Isolated original seat\n');
const toolNames = ['bluesky_status', 'bluesky_batch_preview', 'bluesky_open_preview',
  'bluesky_post', 'bluesky_profile_update', 'bluesky_bookmarks', 'bluesky_exploration_preferences_update', 'credential_resolve'];
for (const id of ['bluesky', 'other']) {
  const bundle = join(root, id + '-bundle');
  await mkdir(bundle);
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-' + id, version: '1.0.0', type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: fixture\n      name: ./plugin.mjs\n');
  await writeFile(join(bundle, 'plugin.mjs'), `export const inject=['tools'];export async function apply(ctx){
    for(const name of ${JSON.stringify(toolNames)})ctx.tools.register({name,description:'Local permission fixture '+name,
      parameters:{type:'object',properties:{},additionalProperties:false},
      output:{schema:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false},
        render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async()=>({name})});}\n`);
  await registerProfile(profiles, { id, kind: 'plugin', description: 'Isolated ' + id, credentialRefs: [] });
  const installed = await withManager(profiles, id, manager => manager.installBundle(bundle, { enabled: false }));
  assert.notEqual(installed.application, 'failed');
  await withManager(profiles, id, manager => manager.setBundleEnabled(installed.bundle, true));
  await approveProfile(profiles, id);
  const entry = await readEntry(profiles, id); entry.enabled = true; await saveEntry(profiles, entry);
}
const sourcePaths = ['capabilities/read-policy.mjs', 'capabilities/bus.mjs', 'digital-life/plugin.mjs', 'persona-plugin.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
  [path, createHash('sha256').update(await readFile(resolve(here, path))).digest('hex')])));
const before = await hashes();
process.env.DEEPSEEK_API_KEY = 'offline-placeholder-not-a-secret';
const primary = randomUUID();
const ctx = await bootNative({ sessionId: primary, testRoot: root });
const checks = [];
const handles = [];
const check = (name, value) => { assert(value, name); checks.push(name); };
const call = (agent, name, args = {}) => agent.ctx.tools.execute({ agent, name,
  arguments: args, callId: randomUUID(), signal: new AbortController().signal });
const spawn = async (parent, depth) => {
  const handle = await parent.ctx.agents.create({ sessionId: randomUUID(), parentAgent: parent,
    meta: childSessionMeta(parent, depth, false), agentOptions: resolveChildAgentOptions(parent, {}, depth),
    setup: childCtx => applyChildComposition(childCtx, parent, {}) });
  handles.push(handle); return handle.agent;
};
try {
  await ctx.sessionController.create({ sessionId: primary, cwd: workspace });
  const { agent: seat } = await ctx.sessionController.resolveAgent(primary);
  const child = await spawn(seat, 1);
  const sibling = await spawn(seat, 1);
  const grandchild = await spawn(child, 2);
  check('official spawn metadata grants read delegation only', ctx.personaLife.isReadDelegate(child)
    && ctx.personaLife.isReadDelegate(grandchild) && !ctx.personaLife.isReadDelegate(seat));
  const activityId = (await ctx.personaTasks.create({ title: 'ordinary activity' })).sessionId;
  const { agent: activity } = await ctx.sessionController.resolveAgent(activityId);
  check('ordinary activity remains outside delegated external reads', !ctx.personaLife.isReadDelegate(activity)
    && !activity.ctx.tools.schemas(activity).some(row => row.name === 'capability_search'));
  const listed = await call(child, 'capability_list');
  assert(!listed.isError, JSON.stringify(listed));
  check('child list hides other capabilities, credential references and protected paths',
    listed.value.entries.length === 1 && listed.value.entries[0].id === 'bluesky'
    && !JSON.stringify(listed.value).includes('credentials') && !JSON.stringify(listed.value).includes('profile'));
  const found = await call(child, 'capability_search', { limit: 30 });
  assert(!found.isError, JSON.stringify(found));
  check('only exact reviewed read schemas are discovered', found.value.tools.length === 3
    && found.value.tools.every(row => ['bluesky_status', 'bluesky_batch_preview', 'bluesky_open_preview'].includes(row.nativeName)));
  const status = found.value.tools.find(row => row.nativeName === 'bluesky_status');
  check('discovery is scoped to child and not sibling or parent',
    !sibling.ctx.tools.schemas(sibling).some(row => row.name === status.name)
    && !seat.ctx.tools.schemas(seat).some(row => row.name === status.name));
  const result = await call(child, status.name);
  check('child executes native scoped read through actual bus worker', !result.isError && result.value.value.name === 'bluesky_status');
  const grandFound = await call(grandchild, 'capability_search', { capability: 'bluesky' });
  check('nested native delegate independently discovers read tools', !grandFound.isError && grandFound.value.total === 3);
  for (const forbidden of ['capability_manage', 'terminal', 'private_read', 'life_mental_write',
    'cap__bluesky__bluesky_post', 'cap__bluesky__bluesky_bookmarks', 'cap__bluesky__credential_resolve']) {
    const denied = await call(child, forbidden, forbidden === 'capability_manage' ? { capability: 'bluesky', action: 'enable' } : {});
    assert(denied.isError, forbidden);
  }
  checks.push('child writes, mixed actions, credential tools, terminal, Vault and seat state all rejected');
  await assert.rejects(ctx.personaCapabilities.call('bluesky', 'bluesky_post', {}, randomUUID(), undefined, 'delegate-read'), /READ_ONLY/);
  await assert.rejects(ctx.personaCapabilities.call('other', 'bluesky_status', {}, randomUUID(), undefined, 'delegate-read'), /READ_ONLY/);
  checks.push('bus dispatch independently rejects writes and other capability reads');
  const seatFound = await call(seat, 'capability_search', { capability: 'bluesky', limit: 30 });
  assert(!seatFound.isError);
  check('original seat retains full Bluesky tools', seatFound.value.tools.some(row => row.nativeName === 'bluesky_post'));
  const deniedSibling = await call(sibling, status.name);
  check('undiscovered sibling cannot borrow read tool name', deniedSibling.isError);
  await ctx.personaCapabilities.manage({ capability: 'bluesky', action: 'disable' });
  check('disabling withdraws scoped tools from children', !child.ctx.tools.schemas(child).some(row => row.name === status.name));
  assert.deepEqual(await hashes(), before);
  const report = { passed: true, observedAt: new Date().toISOString(), paidModelCalls: 0, externalRequests: 0,
    productionRestarted: false, sourceSha256: before, testRoot: root, checks };
  await writeFile(join(root, 'validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const handle of handles.reverse()) await handle.dispose();
  await ctx.fiber.dispose();
}
