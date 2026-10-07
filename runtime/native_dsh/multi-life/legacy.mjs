import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {CONTRACT_VERSION,freeze,fail} from './contracts.mjs';

// An explicit compatibility identity; Session id and preset are never life ids.
export const LEGACY_DL_LIFE_ID='life-ca23d767-1b53-5adf-b85b-19bb81c72286';
export async function inspectLegacy({migrationRoot=fileURLToPath(new URL('../../..',import.meta.url)),markerPath,profilePath}={}) {
  // Callers normally pass migrationRoot explicitly on Windows.
  const marker=JSON.parse(await readFile(markerPath??resolve(migrationRoot,'reports/first_native_start.json'),'utf8'));
  const rows=parse(await readFile(profilePath??resolve(migrationRoot,'runtime/native_dsh/home/profiles/persona/cordis.patch.yml'),'utf8')).flatMap(row=>row.insert??[]);
  const config=id=>{const found=rows.find(row=>row.id===id);if(!found?.config)fail('LEGACY_PROFILE_BINDING_MISSING');return found.config;};
  const foundation=config('workspace-foundation'),bridge=config('persona-bridge'),life=config('persona-digital-life');
  const workspace=foundation.workspace;
  return freeze({schemaVersion:CONTRACT_VERSION,lifeId:LEGACY_DL_LIFE_ID,kind:'legacy',displayName:'人格',revision:1,authoritySessionId:marker.native_session_id,
    deployment:{presetId:'persona',provider:'deepseek-official',model:'deepseek-flash',workspace,core:bridge.core,
      state:life.root,memory:resolve(migrationRoot,'runtime/long_term_memory/store'),vault:config('persona-private-vault').root,
      recovery:resolve(migrationRoot,'runtime/native_dsh/recovery/state'),capabilities:config('persona-capabilities').root,
      attachments:resolve(migrationRoot,'runtime/native_dsh/home/attachments'),versions:foundation.store,
      skillsRoots:[resolve(workspace,'.dsh/skills'),resolve(workspace,'development/skills')],
      budgetAccountRef:'legacy-deepseek-account',browserBindingRef:'legacy-persona-browser',externalIdentityPolicyRef:'legacy-persona-identities'}});
}
export class LegacyAdapter {
  constructor({runtime,lifeId=LEGACY_DL_LIFE_ID}) {
    this.runtime=runtime;this.lifeId=lifeId;
    if(runtime.registry.life(lifeId).kind!=='legacy')fail('LEGACY_BINDING_REQUIRED');
  }
  prompt(request) {if(request.lifeId!==undefined&&request.lifeId!==this.lifeId)fail('LEGACY_API_OWNER_MISMATCH');return this.runtime.prompt({...request,lifeId:this.lifeId});}
  resolve(request) {if(request.lifeId!==undefined&&request.lifeId!==this.lifeId)fail('LEGACY_API_OWNER_MISMATCH');return this.runtime.resolve({...request,lifeId:this.lifeId});}
}
