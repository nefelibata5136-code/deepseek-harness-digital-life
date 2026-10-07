// Host-only per-life binding. This module never exposes a secret to model tools.
import {fail} from '../contracts.mjs';
export function credentialRefForLife(lifeId) {
  if(!/^life-[a-z0-9-]{1,128}$/i.test(lifeId))fail('INVALID_CREDENTIAL_LIFE_ID');
  return 'DL_LIFE_DEEPSEEK_'+lifeId.slice(5).replaceAll('-','_').toUpperCase();
}
export function createLifeCredentialResolver({bindings,resolve,legacyResolver}) {
  if(!(bindings instanceof Map)||typeof resolve!=='function')fail('EXPLICIT_LIFE_CREDENTIAL_BINDINGS_REQUIRED');
  const byLife=new Map(),byAccount=new Map();
  for(const [lifeId,binding] of bindings) {
    credentialRefForLife(lifeId);
    if(!binding||!['windows-credential-manager','legacy-existing-source'].includes(binding.source)||typeof binding.accountRef!=='string'||!binding.accountRef)
      fail('INVALID_LIFE_CREDENTIAL_BINDING');
    if(binding.source==='windows-credential-manager'&&binding.hostRef!==credentialRefForLife(lifeId))fail('LIFE_CREDENTIAL_REFERENCE_MISMATCH');
    if(binding.source==='legacy-existing-source'&&(binding.hostRef||typeof legacyResolver!=='function'))fail('LEGACY_PROVIDER_SOURCE_REQUIRED');
    const old=byAccount.get(binding.accountRef);
    if(old&&(old.source!==binding.source||old.hostRef!==binding.hostRef))fail('ACCOUNT_CREDENTIAL_CONFLICT');
    const row=Object.freeze({...binding,lifeId});byLife.set(lifeId,row);byAccount.set(binding.accountRef,row);
  }
  return Object.freeze({
    accountForLife(lifeId){const row=byLife.get(lifeId);if(!row)fail('LIFE_CREDENTIAL_BINDING_REQUIRED');return row.accountRef;},
    metadata(){return [...byLife.values()].map(row=>({...row,independentCredential:row.source==='windows-credential-manager'}));},
    async credentialForAccount(accountRef){
      const row=byAccount.get(accountRef);if(!row)fail('PROVIDER_ACCOUNT_BINDING_REQUIRED');
      const result=row.source==='legacy-existing-source'?await legacyResolver():await resolve(row.hostRef);
      const value=typeof result==='string'?result:result?.value;
      if(typeof value!=='string'||value.length<16)fail('PROVIDER_CREDENTIAL_UNAVAILABLE');return value;
    }
  });
}
