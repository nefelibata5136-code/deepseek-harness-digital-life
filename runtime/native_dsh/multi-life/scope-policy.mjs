import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {canonical,contains,fail} from './contracts.mjs';
import {assertOwnershipPath} from './platform/normal-interface-ownership.mjs';
export const inject=['fs','systemPrompt','multiLifeContexts'];
export function apply(ctx,config) {
  const contexts=ctx.multiLifeContexts,registry=contexts.registry;
  const manifest=registry.life(config.lifeId),fs=ctx.fs,original=fs.resolve.bind(fs);
  fs.resolve=async(...args)=>{
    const target=await original(...args),path=canonical(fs.processPath(target));
    if(config.fixtureRoot&&!contains(canonical(config.fixtureRoot),path))fail('TEST_FIXTURE_OUTSIDE_BOUNDARY');
    for(const root of [...registry.controlRoots,...(config.controlRoots??[]),resolve(manifest.deployment.memory,'.native-source-snapshots')])if(contains(canonical(root),path))fail('TRUSTED_CONTROL_RESOURCE');
    // A worker-local Registry can contain only its own life. The Host's normal
    // interface policy supplies the whole neutral Registry's private roots.
    const common=ctx.get('normalInterfaceOwnership');
    if(common)common.pathFor(manifest.lifeId,path);
    else assertOwnershipPath({lifeId:manifest.lifeId,manifests:()=>registry.list()},path);
    return target;
  };
  ctx.effect(()=>()=>{fs.resolve=original;},'multi-life private path route');
  ctx.systemPrompt.section({name:'life:core',order:0,interpolate:false,text:({agent})=>{
    const bound=contexts.forAgent(agent);
    if(bound.lifeId!==manifest.lifeId)fail('PRESET_CONTEXT_OWNER_MISMATCH');
    if(bound.role==='delegate')return 'Temporary engineering collaborator. You have your parent life\'s delegated read access, not a separate digital-life identity, Core, Memory or Vault. Read the assigned evidence and return a suggestion. Do not claim to be your parent or accept memories on their behalf.';
    return readFileSync(bound.manifest.deployment.core,'utf8');
  }});
}
