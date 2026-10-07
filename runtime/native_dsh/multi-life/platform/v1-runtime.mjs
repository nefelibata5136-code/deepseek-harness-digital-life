import {resolve} from 'node:path';
import {mountLocalNetwork} from './local-network.mjs';
import {mountLifeDots,DOTS_SPECS} from './dots-capability.mjs';
import {mountV1Capabilities} from './v1-capabilities.mjs';
import {publicCredentialOperation as credentialOperation} from '../supervisor/public-deployment.mjs';

// Shared production composition. All state and execution identity are bound
// by the existing Host; model tools cannot select a life or credential.
export async function mountV1Runtime(ctx) {
  reconcileLegacyDots(ctx);
  if(ctx.get('v1Runtime'))return ctx.get('v1Runtime');
  const contexts=ctx.get('multiLifeContexts')??ctx.get('multiLifeOwnership')?.contexts;
  if(!contexts||contexts.registry.mode!=='production')throw Error('V1_PRODUCTION_OWNER_REQUIRED');
  const local=ctx.get('digitalLifeLocalNetwork')??await mountLocalNetwork(ctx,{ownerFor:agent=>contexts.forAgent(agent)});
  let dots;
  // Persona retains her already loaded native capability worker. Modern owner
  // workers reuse its reviewed implementation with independent task storage.
  if(!ctx.get('personaCapabilities',false)&&ctx.get('multiLifeContexts')) {
    const migrationRoot=resolve(import.meta.dirname,'../../../..');
    const bindings=new Map(contexts.registry.list().filter(m=>m.kind!=='legacy').map(m=>[m.lifeId,{
      stateRoot:resolve(process.env.DL_WORLD_ROOT || resolve(migrationRoot,'.local/world'), 'workers',m.lifeId,'dots'),
      connectionRoot:resolve(migrationRoot,'runtime/dots_bridge/protected'),
    }]));
    dots=ctx.get('lifeDots')??await mountLifeDots({ctx,contexts},{bindings,
      sourceRoot:resolve(migrationRoot,'plugins/dots'),
      credentialBackend:(_c,_binding,ref,action)=>credentialOperation('python',action,ref)});
    if(!ctx.get('lifeDots'))ctx.provide('lifeDots',dots);
  }
  const capabilities=await mountV1Capabilities(ctx);
  const service={version:1,local,dots,capabilities};ctx.provide('v1Runtime',service);return service;
}

// The legacy Host can expose a modern-context service without being a modern
// worker. Keep its existing capability bus as the only Dot route. A running
// pre-fix Host may contain our unbound globals; the official scoped mask removes
// only this module's exact definitions and does not touch bus wrappers or peers.
export function reconcileLegacyDots(ctx) {
  if(!ctx.get('personaCapabilities',false))return null;
  if(ctx.get('v1LegacyDotsView'))return ctx.get('v1LegacyDotsView');
  const contexts=ctx.get('multiLifeContexts')??ctx.get('multiLifeOwnership')?.contexts;
  if(!contexts)return null;
  const installed=new WeakSet(),definitions=new Map(DOTS_SPECS.map(([n,d])=>[n,d]));
  const install=agent=>{
    if(installed.has(agent))return;
    let owner;try{owner=contexts.forAgent(agent);}catch{return;}
    if(owner.manifest?.kind!=='legacy')return;
    const tools=ctx.get('tools'),globals=new Map(tools.schemas().filter(t=>definitions.get(t.name)===t.description).map(t=>[t.name,tools.get(t.name)]));
    const names=tools.schemas(agent).filter(t=>globals.has(t.name)&&tools.get(t.name,agent)===globals.get(t.name)).map(t=>t.name);
    if(names.length)agent.ctx.tools.restrict({deny:names});
    installed.add(agent);
  };
  ctx.on('agent/created',({agent})=>install(agent));
  for(const agent of ctx.get('agents').list())install(agent);
  const service={source:'official_scoped_tools_mask',route:'existing capability bus',masked_definitions:[...definitions.keys()]};
  ctx.provide('v1LegacyDotsView',service);return service;
}
