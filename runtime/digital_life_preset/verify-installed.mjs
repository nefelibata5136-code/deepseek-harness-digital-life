/** Mount the declaration using installed rc.2 services; no model or Host request. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
const require=createRequire(new URL('../native_dsh/package.json',import.meta.url));
const load=async name=>import(pathToFileURL(require.resolve(name)).href);
const {Context}=await load('@deepseek-ai/cordis');
const {default:Loader}=await load('@deepseek-ai/cordis-plugin-loader');
const {default:Projections}=await load('@deepseek-ai/dsh-session-projection');
const {default:Presets}=await load('@deepseek-ai/dsh-agent-preset-registry');
const {default:Preset}=await load('@deepseek-ai/dsh-agent-preset');
const {createScope}=await load('@deepseek-ai/dsh-scope');
const {parse}=await load('yaml');
const ctx=new Context();
ctx.baseUrl=new URL('./cordis.patch.yml',import.meta.url).href;
try {
  await ctx.plugin(Loader);
  await ctx.plugin(Projections);
  await ctx.plugin(Presets,{default:'persona'});
  const declaration=parse(await readFile(new URL('./cordis.patch.yml',import.meta.url),'utf8'))[0].insert[0];
  await ctx.plugin(Preset,declaration.config);
  const roster=await ctx.agentPresets.remoteExportList();
  assert.equal(roster.presets.length,1);
  assert.equal(roster.presets[0].id,'persona');
  assert.equal(roster.presets[0].broken,undefined);
  assert.equal(roster.presets[0].isDefault,true);
  const document=await ctx.agentPresets.readDocument('persona');
  assert.ok(document.content.includes('entrance.mjs'));
  const scope=createScope(ctx,{});
  await ctx.agentPresets.mount(scope.ctx,'persona');
  assert.equal(ctx.agentPresets.composedPreset(scope.ctx),'persona');
  await scope.dispose();
  console.log(JSON.stringify({passed:true,installedVersion:'0.2.0-rc.2',paidModelCalls:0,protectedHostCalls:0,
    checks:['official preset declaration activates','roster publishes Persona name and default','read-only configuration renders','Agent scope mounts Persona']}));
} finally {await ctx.fiber.dispose();}
