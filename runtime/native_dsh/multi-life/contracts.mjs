import {isAbsolute, resolve, dirname, basename, relative, sep} from 'node:path';
import {realpathSync,existsSync} from 'node:fs';

export const CONTRACT_VERSION = 1;
export const PRIVATE_ROOTS = ['workspace','state','memory','vault','recovery','capabilities','attachments','versions'];
export class LifeError extends Error {
  constructor(code) { super(code); this.name='LifeError'; this.code=code; }
}
export const fail = code => {throw new LifeError(code);};
export const freeze = value => {
  if (value && typeof value==='object') {Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
};
export const copy = value => structuredClone(value);
export function canonical(path) {
  if (typeof path!=='string'||!isAbsolute(path)) fail('ABSOLUTE_DEPLOYMENT_PATH_REQUIRED');
  let at=resolve(path),tail=[];
  for (;;) {
    try {at=realpathSync.native(at);break;}
    catch(e) {if(e.code!=='ENOENT')throw e;const parent=dirname(at);if(parent===at)throw e;tail.unshift(basename(at));at=parent;}
  }
  const result=resolve(at,...tail);
  return process.platform==='win32'?result.toLowerCase():result;
}
export function contains(root,path) {
  const rel=relative(root,path);
  return !rel||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));
}
// Official AttachmentLocal takes dshHome, then appends attachments/v1 and a
// private request-image cache. Manifest attachments is the unversioned root.
export function attachmentLayout(manifest) {
  const root=manifest.deployment.attachments;
  if(basename(root).toLowerCase()!=='attachments')fail('NATIVE_ATTACHMENT_ROOT_MUST_END_IN_ATTACHMENTS');
  const home=dirname(root);
  return {home,root,cache:resolve(home,'cache','attachments')};
}
// Extra private roots are Host-owned deployment metadata. They cover legacy
// history, native journals/query indexes, compaction, advisors and profiles that
// cannot be inferred from the primary eight roots. No tool can add these roots.
export const privatePaths=manifest=>[...PRIVATE_ROOTS.map(key=>manifest.deployment[key]),attachmentLayout(manifest).cache,...(manifest.deployment.privateRoots??[])];
export function validateManifest(input, mode) {
  const m=copy(input);
  if(m.schemaVersion!==CONTRACT_VERSION||!/^life-[a-f0-9-]{36}$/.test(m.lifeId))fail('INVALID_LIFE_MANIFEST');
  if(!['fixture','legacy','independent'].includes(m.kind))fail('INVALID_LIFE_KIND');
  if(mode==='fixture'&&m.kind!=='fixture'||mode==='production'&&m.kind==='fixture')fail('REGISTRY_ENVIRONMENT_MISMATCH');
  if(m.kind==='fixture'&&!/^TEST ONLY /u.test(m.displayName??''))fail('OBVIOUS_TEST_IDENTITY_REQUIRED');
  if(!Number.isSafeInteger(m.revision)||m.revision<1||typeof m.authoritySessionId!=='string'||!m.authoritySessionId)fail('INVALID_LIFE_BINDING');
  if(!m.deployment?.presetId||!m.deployment?.provider||!m.deployment?.model)fail('RUNTIME_BINDING_REQUIRED');
  const d=m.deployment;
  if(d.privateRoots!==undefined&&!Array.isArray(d.privateRoots))fail('PRIVATE_RESOURCE_ROOTS_INVALID');
  if(mode==='production')for(const path of privatePaths(m)) {
    let at=canonical(path);
    for(;;){if(existsSync(resolve(at,'TEST-ONLY.json'))||basename(at).toLowerCase().startsWith('digital-life-test-only-'))fail('FIXTURE_RESOURCES_CANNOT_BECOME_PRODUCTION');const parent=dirname(at);if(parent===at)break;at=parent;}
  }
  for(const key of PRIVATE_ROOTS)canonical(d[key]);
  for(const path of privatePaths(m))canonical(path);
  canonical(d.core);
  if(!contains(canonical(d.workspace),canonical(d.core)))fail('CORE_OUTSIDE_OWNER_WORKSPACE');
  if(!Array.isArray(d.skillsRoots)||!d.skillsRoots.length)fail('SKILLS_ROOTS_REQUIRED');
  for(const root of d.skillsRoots)if(!contains(canonical(d.workspace),canonical(root)))fail('PRIVATE_SKILLS_OUTSIDE_OWNER_WORKSPACE');
  // References only. A manifest is never a credential transport.
  if(d.credentials!==undefined||d.secret!==undefined||d.cookie!==undefined||d.apiKey!==undefined)fail('SECRET_VALUE_IN_MANIFEST');
  return freeze(m);
}
