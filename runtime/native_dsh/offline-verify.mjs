// Load the actual installed native profile, with ONLY its task driver disabled.
// No Agent is created and no model call is made; no workspace file is written.
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot, loadProfile, createRuntimeResolution, PluginPackages } from '@deepseek-ai/dsh-app-boot';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions';
import { baselineToolNames } from './persona-plugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
process.env.DSH_HOME = resolve(here, 'home');
process.env.DSH_TELEMETRY_DISABLED = '1';
process.env.DL_SESSION_ID ??= 'eaa4b72d-7382-596c-80ef-2bd299092af8';
const installAnchor = resolve(here, 'node_modules/@deepseek-ai/dsh/package.json');
const profile = loadProfile('persona-offline', 'persona', installAnchor);
const rootConfig = resolve(here, 'offline-cordis.yml');
await writeFile(rootConfig, '[]\n');
const resolution = await createRuntimeResolution({ installAnchor, profile });
const patches = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches,
];
const ctx = await boot('persona-offline', rootConfig, patches, async ctx => {
  ctx.provide('profileContext', { name: 'persona', dir: profile.dir, patchPath: profile.patchPath,
    installAnchor, cwd: process.cwd(), home: process.env.DSH_HOME,
    startedBundles: profile.layers.map(layer => layer.packageName), overlays: [], telemetryDisabledEnv: '1' });
  await ctx.plugin(PluginPackages, { resolution });
});
try {
  const assembly = await ctx.systemPrompt.assemble();
  const prompt = renderPrompt(assembly);
  const corePath = '.local/workspace/persona-core.md';
  const core = await readFile(corePath, 'utf8');
  const coreSection = assembly.sections.find(section => section.name === 'persona:core');
  if (coreSection?.text !== core || !prompt.includes(core)) throw new Error('Core text changed during native assembly');
  const tools = ctx.tools.schemas().map(tool => tool.name).sort();
  for (const name of baselineToolNames.filter(name => !name.startsWith('schedule_'))) if (!tools.includes(name)) throw new Error('Missing baseline tool: ' + name);
  if (!ctx.get('personaHost')?.schedule || !ctx.get('credentials') || !ctx.get('workspaceFoundation')) throw new Error('Integrated services missing');
  const baseline = await loadBaselineInstructions({ cwd: dirname(corePath), dshHome: process.env.DSH_HOME,
    projectRootMarkers: ['AGENTS.md'], instructionFileCandidates: ['AGENTS.md'],
    localInstructionFileCandidates: [], maxBytes: 65536 }, ctx.fs);
  if (!baseline?.text?.includes('AGENTS.md')) throw new Error('Native AGENTS baseline missing');
  const result = { observed_at: new Date().toISOString(), native_version: '0.2.0-rc.2',
    model: ctx.agentDefaultModel.currentSelection(), actual_registered_tools: tools,
    core_source: corePath, core_sha256: createHash('sha256').update(core, 'utf8').digest('hex'),
    core_preserved_exactly: true, system_sections: assembly.sections.map(section => section.name),
    native_agents_baseline_loaded: true, agents_baseline_characters: baseline.text.length,
    model_called: false, agent_created: false, workspace_written: false,
    config: profile.patchPath, warning: 'Headless bundle targets absent hmr row: harmless composition warning; minimal kernel has no HMR.' };
  await writeFile(resolve(here, '../../reports/native_offline_validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await ctx.fiber.dispose(); }
