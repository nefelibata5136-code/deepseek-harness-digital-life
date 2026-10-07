import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {LifeRegistry} from '../registry.mjs';
import {credentialRefForLife,createLifeCredentialResolver} from '../budget/credentials.mjs';
import {credentialOperation} from '../../capabilities/isolation.mjs';
import {fail} from '../contracts.mjs';

export const migrationRoot=resolve(import.meta.dirname,'../../../..');
export const worldRoot=resolve(process.env.DL_WORLD_ROOT || resolve(migrationRoot,'.local/world'), '.');
export const python=(process.env.DL_PYTHON || 'python');
export function worldSnapshot() {
  const value=JSON.parse(readFileSync(resolve(worldRoot,'registry/registry.json'),'utf8'));
  if(value.mode!=='production'||!value.lives||!value.sessions)fail('EXISTING_WORLD_REGISTRY_REQUIRED');
  return value;
}
export function privacyManifests() {
  const browser=JSON.parse(readFileSync(resolve(migrationRoot,'runtime/browser/config.json'),'utf8'));
  return Object.values(worldSnapshot().lives).map(m=>({...m,deployment:{...m.deployment,
    ...m.kind==='legacy'?{fileAreas:{history:resolve(migrationRoot,'history'),legacy:'.local/legacy',controls:migrationRoot}}:{},
    privateRoots:[...m.deployment.privateRoots??[],...m.kind==='legacy'?[
      resolve(migrationRoot,'history'),'.local/legacy',
      resolve(migrationRoot,'runtime/native_dsh/home/sessions'),resolve(migrationRoot,'runtime/native_dsh/home/storages'),
      resolve(migrationRoot,'runtime/native_dsh/home/session-query.sqlite'),resolve(migrationRoot,'runtime/native_dsh/home/compaction-cache'),
      '.local/advisors',browser.private_root,
      resolve(migrationRoot,'sessions'),resolve(migrationRoot,'runtime/bluesky/protected'),
      resolve(migrationRoot,'runtime/dots_bridge/protected'),resolve(migrationRoot,'reports/dots_bridge/cli'),
    ]:[workerLayout(m.lifeId).session_root,resolve(worldRoot,'workers',m.lifeId)]]}}));
}
export function workerLayout(lifeId) {
  const config=JSON.parse(readFileSync(resolve(worldRoot,'supervisor/deployments.json'),'utf8'));
  const row=config.workers?.[lifeId];if(config.schema_version!==1||!row?.session_root||!row?.kernel_root)fail('EXPLICIT_WORKER_DEPLOYMENT_REQUIRED');
  return row;
}
export function assertLifeExecutionEnabled(lifeId) {
  if(workerLayout(lifeId).execution_disabled===true)fail('LIFE_EXECUTION_DISABLED_BY_USER');
}
export function privateControlRoots() {
  return [resolve(worldRoot,'registry'),resolve(worldRoot,'kernel/platform'),resolve(worldRoot,'supervisor'),
    resolve(migrationRoot,'runtime/native_dsh/host-state/.host-control.json'),
    resolve(migrationRoot,'runtime/native_dsh/home/.credentials.yaml'),
    resolve(process.env.LOCALAPPDATA??'.local/unconfigured/Local','PersonaHost/secret-input')];
}
export function credentialResolver(lives) {
  return createLifeCredentialResolver({bindings:new Map(lives.map(m=>[m.lifeId,{accountRef:'deepseek-life:'+m.lifeId,
    hostRef:credentialRefForLife(m.lifeId),source:'windows-credential-manager'}])),resolve:ref=>credentialOperation(python,'resolve',ref)});
}
export async function workerRegistry(lifeId,{legacyOnly=false}={}) {
  const state=worldSnapshot(),m=state.lives[lifeId];if(!m)fail('UNKNOWN_LIFE');
  const root=resolve(worldRoot,'workers',lifeId,'registry');await mkdir(root,{recursive:true});
  const path=resolve(root,'registry.json');
  try{await readFile(path);}catch(error){
    if(error.code!=='ENOENT')throw error;
    // A private mirror carries existing owner fingerprints into the same native
    // store. It never opens the central Registry writer or invents identities.
    const snapshot=legacyOnly?{...state,lives:{[lifeId]:m},sessions:Object.fromEntries(Object.entries(state.sessions).filter(([,s])=>s.lifeId===lifeId))}:state;
    await writeFile(path,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
  }
  const registry=new LifeRegistry({root,mode:'production'});
  for(const life of legacyOnly?[m]:Object.values(state.lives)) {
    const local=registry.list().find(row=>row.lifeId===life.lifeId);
    if(!local)registry.register(life);
    else if(local.revision!==life.revision||local.authoritySessionId!==life.authoritySessionId)fail('WORKER_MANIFEST_MIRROR_STALE');
  }
  return registry;
}
