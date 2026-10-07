import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLifeCredentialResolver,credentialRefForLife} from './credentials.mjs';
test('Host resolves N life credentials by explicit reference; fallback remains visibly shared',async()=>{
  const lives=['life-TEST-A','life-TEST-B','life-TEST-C'],seen=[];
  const resolver=createLifeCredentialResolver({bindings:new Map(lives.map(id=>[id,{accountRef:'account:'+id,hostRef:credentialRefForLife(id),source:'windows-credential-manager'}])),resolve:async ref=>{seen.push(ref);return {value:'TEST-ONLY-'+ref};}});
  await Promise.all(lives.map(id=>resolver.credentialForAccount(resolver.accountForLife(id))));
  assert.deepEqual(new Set(seen),new Set(lives.map(credentialRefForLife)));assert(resolver.metadata().every(row=>row.independentCredential));
  assert.throws(()=>resolver.accountForLife('life-UNKNOWN'),/BINDING_REQUIRED/);
  await assert.rejects(resolver.credentialForAccount('ambient-default'),/BINDING_REQUIRED/);
  const fallback=createLifeCredentialResolver({bindings:new Map(lives.map(id=>[id,{accountRef:'shared-existing',source:'legacy-existing-source'}])),resolve:async()=>{throw Error('must not read broker');},legacyResolver:async()=>'TEST-ONLY-LEGACY-EXISTING'});
  assert(fallback.metadata().every(row=>!row.independentCredential));assert.equal(await fallback.credentialForAccount('shared-existing'),'TEST-ONLY-LEGACY-EXISTING');
  assert.throws(()=>createLifeCredentialResolver({bindings:new Map([['life-TEST-A',{accountRef:'a',hostRef:credentialRefForLife('life-TEST-B'),source:'windows-credential-manager'}]]),resolve:async()=>null}),/REFERENCE_MISMATCH/);
});
