import './windows-dpi.mjs';
import { writeFile, readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, loadProfileDirectory, createRuntimeResolution, PluginPackages } from '@deepseek-ai/dsh-app-boot';
import { createKeyOutputGuard } from '../key_output_guard/guard.mjs';
import {mountMainRecovery} from './recovery/main.mjs';
import {existsSync} from 'node:fs';
export const here = dirname(fileURLToPath(import.meta.url));
export async function bootNative({ sessionId, testRoot, budgetDb, overlays = [], multiLife } = {}) {
  if (!sessionId) throw new Error('Explicit Session ID required');
  let productionOwner;
  if(!testRoot&&!multiLife&&existsSync(resolve(here,'../multi_life_supervisor/supervisor/control.json'))) {
    const {prepareProductionLegacyOwner}=await import('./multi-life/supervisor/legacy-bootstrap.mjs');
    productionOwner=await prepareProductionLegacyOwner();multiLife=productionOwner;
  }
  process.env.DSH_HOME = resolve(here, 'home');
  process.env.DSH_TELEMETRY_DISABLED = '1';
  process.env.DL_SESSION_ID = sessionId;
  process.env.TZ = 'Asia/Shanghai';
  const keyOutputGuard = createKeyOutputGuard({knownSecrets: [process.env.DEEPSEEK_API_KEY]});
  globalThis.fetch = keyOutputGuard.wrapTransport(globalThis.fetch);
  const installAnchor = resolve(here, 'node_modules/@deepseek-ai/dsh/package.json');
  const profile = loadProfileDirectory('persona-host', resolve(here, 'home/profiles/persona'), installAnchor);
  const resolution = await createRuntimeResolution({ installAnchor, profile });
  const patches = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches];
  const rows = parse(await readFile(profile.patchPath, 'utf8')).flatMap(row => row.insert ?? []);
  if (testRoot) {
    // Offline fixtures must never capture or operate the user's real desktop.
    patches.push({ id: 'persona-computer', disabled: true });
    const workspace = resolve(testRoot, 'workspace');
    const db = resolve(testRoot, 'budget.sqlite3');
    patches.push(...[
      ['sessions', { root: resolve(testRoot, 'sessions'), compression: 'none' }],
      ['persona-private-vault', { root: resolve(testRoot, 'private-vault') }],
      ['workspace-foundation', { workspace, store: resolve(testRoot, 'versions'), readRoots: [testRoot] }],
      ['persona-bridge', { workspace, core: resolve(workspace, 'persona-core.md') }],
      ['persona-tasks', {workspace}],
      ['persona-digital-life', {workspace, root: resolve(testRoot, 'digital-life')}],
      ['persona-codex-advisor', {protectedRoot: resolve(testRoot, 'advisors')}],
      ['budget-guard', { db }], ['host-components', { db }],
      ['storage-json', { root: resolve(testRoot, 'storages') }],
      ['attachment-local', { root: resolve(testRoot, 'attachments') }],
      ['session-query-sqlite', { path: resolve(testRoot, 'query.sqlite') }],
      ['credentials-local', { path: resolve(testRoot, '.credentials.yaml'), watch: false }],
      ['persona-compaction', { cacheRoot: resolve(testRoot, 'compaction-cache') }],
      ['persona-capabilities', { root: resolve(testRoot, 'capability-profiles') }],
    ].map(([id, config]) => ({ id, config: { ...(rows.find(row => row.id === id)?.config ?? {}), ...config } })));
    // Offline fixtures must never attach to the real persistent browser.
    patches.push({ id: 'persona-browser-mcp', disabled: true });
  }
  if (budgetDb) for (const id of ['budget-guard', 'host-components']) patches.push({ id,
    config: { ...(rows.find(row => row.id === id)?.config ?? {}), db: budgetDb } });
  patches.push(...overlays);
  const rootConfig = resolve(here, 'host-cordis.yml');
  await writeFile(rootConfig, '[]\n');
  const ctx = await boot('persona-host', rootConfig, patches, async ctx => {
    await ctx.plugin(PluginPackages, { resolution });
    if(multiLife) {
      const {prepareLegacyOwnership}=await import('./multi-life/platform/legacy-host.mjs');
      prepareLegacyOwnership(ctx,{...multiLife,nativeRoot:testRoot?resolve(testRoot,'sessions'):resolve(here,'home/sessions')});
    }
  });
  if (!ctx.get('personaHost') || !ctx.get('workspaceFoundation') || !ctx.get('credentials'))
    throw new Error('Host composition did not activate');
  if (!ctx.get('personaLife') || !ctx.subagents.getProvider('codex'))
    throw new Error('Digital life authority or isolated advisor did not activate; refusing partial mode');
  if(multiLife&&!ctx.get('multiLifeOwnership'))throw new Error('Explicit legacy owner boundary did not activate');
  if(productionOwner) {
    const {mountProductionLegacyBoundaries}=await import('./multi-life/supervisor/legacy-bootstrap.mjs');
    await mountProductionLegacyBoundaries(ctx,productionOwner);
  }
  keyOutputGuard.mount(ctx);
  await mountMainRecovery(ctx,{primary:sessionId,workspace:testRoot?resolve(testRoot,'workspace'):resolve(process.env.DL_WORKSPACE || '.local/workspace'),
    ...(testRoot?{root:resolve(testRoot,'recovery-state')}:{})});
  if(!testRoot) {
    const {mountProductionLegacy}=await import('./multi-life/platform/production-legacy.mjs');
    await mountProductionLegacy(ctx,{authoritySessionId:sessionId,migrationRoot:resolve(here,'../..')});
  }
  return ctx;
}
