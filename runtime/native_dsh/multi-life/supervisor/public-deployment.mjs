// Public deployment uses explicit local metadata and Host-process secrets.
// Model arguments cannot choose life ownership, credentials or control tokens.
import {readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {LifeRegistry} from '../registry.mjs';
import {fail} from '../contracts.mjs';
export const migrationRoot=resolve(import.meta.dirname,'../../../..');
export const worldRoot=resolve(process.env.DL_WORLD_ROOT||resolve(migrationRoot,'.local/world'));
export const python=process.env.DL_PYTHON||'python';
export const publicSettings=()=>JSON.parse(readFileSync(resolve(worldRoot,'settings.json'),'utf8'));
export function worldSnapshot(){const s=JSON.parse(readFileSync(resolve(worldRoot,'registry/registry.json'),'utf8'));if(s.mode!=='production')fail('EXISTING_WORLD_REGISTRY_REQUIRED');return s;}
export function workerLayout(lifeId){const row=JSON.parse(readFileSync(resolve(worldRoot,'supervisor/deployments.json'),'utf8')).workers?.[lifeId];if(!row)fail('EXPLICIT_WORKER_DEPLOYMENT_REQUIRED');return row;}
export function assertLifeExecutionEnabled(lifeId){if(workerLayout(lifeId).execution_disabled===true)fail('LIFE_EXECUTION_DISABLED_BY_USER');}
export function privateControlRoots(){return [worldRoot,resolve(process.env.DL_DATA||resolve(migrationRoot,'.local'),'advisors')];}
export function privacyManifests(){return Object.values(worldSnapshot().lives).map(m=>({...m,deployment:{...m.deployment,privateRoots:[...m.deployment.privateRoots??[],workerLayout(m.lifeId).session_root,resolve(worldRoot,'workers',m.lifeId)]}}));}
export async function publicCredentialOperation(_python,action,ref){
  if(action!=='resolve')fail('PUBLIC_CREDENTIAL_WRITES_REQUIRE_EXTERNAL_SECRET_MANAGER');
  const s=publicSettings();
  if(ref==='DL_WORLD_HUMAN')return {value:s.tokens.human};
  if(ref==='DL_WORLD_OPERATOR'||ref==='DL_MULTI_LIFE_DEVELOPER_CHANNEL')return {value:s.tokens.operator};
  for(const l of s.lives)if(ref==='DL_LIFE_COMM_'+l.lifeId.replaceAll('-','_').toUpperCase())return {value:s.tokens.workers[l.lifeId]};
  return {value:process.env[ref]??(ref==='DL_QWEN_API_KEY'?process.env.DASHSCOPE_API_KEY:undefined)};
}
export function credentialResolver(lives){
  const settings=publicSettings(),rows=lives.map(m=>{
    const row=settings.lives.find(l=>l.lifeId===m.lifeId);if(!row)fail('EXPLICIT_LIFE_CREDENTIAL_BINDINGS_REQUIRED');
    return {lifeId:m.lifeId,accountRef:'deepseek-life:'+m.lifeId,hostRef:row.keyEnv,source:'host-process-environment',independentCredential:true};
  });
  return Object.freeze({metadata:()=>rows.map(r=>({...r})),accountForLife:id=>{const r=rows.find(r=>r.lifeId===id);if(!r)fail('LIFE_CREDENTIAL_BINDING_REQUIRED');return r.accountRef;},
    credentialForAccount:async account=>{const r=rows.find(r=>r.accountRef===account);if(!r)fail('PROVIDER_ACCOUNT_BINDING_REQUIRED');const key=process.env[r.hostRef];if(typeof key!=='string'||key.length<16||key.includes('REPLACE_'))fail('PROVIDER_CREDENTIAL_UNAVAILABLE');return key;}});
}
export async function workerRegistry(lifeId){
  const state=worldSnapshot();if(!state.lives[lifeId])fail('UNKNOWN_LIFE');
  const root=resolve(worldRoot,'workers',lifeId,'registry');await mkdir(root,{recursive:true});
  try{await readFile(resolve(root,'registry.json'));}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(resolve(root,'registry.json'),JSON.stringify(state,null,2)+'\n',{flag:'wx'});}
  const registry=new LifeRegistry({root,mode:'production'});
  for(const m of Object.values(state.lives)){const local=registry.list().find(r=>r.lifeId===m.lifeId);if(!local)registry.register(m);else if(local.revision!==m.revision||local.authoritySessionId!==m.authoritySessionId)fail('WORKER_MANIFEST_MIRROR_STALE');}
  return registry;
}
