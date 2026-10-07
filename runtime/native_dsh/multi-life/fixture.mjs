import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CONTRACT_VERSION,PRIVATE_ROOTS,canonical,contains,fail} from './contracts.mjs';
export async function createFixture(labels=['A','B']) {
  const root=await mkdtemp(resolve(tmpdir(),'digital-life-TEST-ONLY-'));
  const token=randomUUID();let cleaned=false;await writeFile(resolve(root,'TEST-ONLY.json'),JSON.stringify({token,fixture:true}));
  const manifests=[];
  for(const label of labels) {
    const base=resolve(root,'TEST-'+label),workspace=resolve(base,'workspace');
    const deployment=Object.fromEntries(PRIVATE_ROOTS.map(key=>[key,resolve(base,key)]));
    deployment.workspace=workspace;deployment.core=resolve(workspace,'test-core.md');
    deployment.skillsRoots=[resolve(workspace,'.dsh/skills')];
    deployment.presetId='TEST-preset-'+label+'-'+randomUUID();deployment.provider='TEST-shared-provider';deployment.model='TEST-model';
    for(const path of Object.values(deployment).filter(v=>typeof v==='string'&&v.startsWith(root)&&v!==deployment.core))await mkdir(path,{recursive:true});
    await writeFile(deployment.core,'TEST ONLY CORE '+label+'\n');
    const skillRoot=resolve(deployment.skillsRoots[0],'fixture-skill');await mkdir(skillRoot,{recursive:true});
    await writeFile(resolve(skillRoot,'SKILL.md'),'---\nname: fixture-skill\ndescription: Test only fixture skill '+label+'\n---\nTEST ONLY SKILL '+label+'\n');
    await writeFile(resolve(workspace,'same-name.txt'),'TEST ONLY FILE '+label+'\n');
    manifests.push({schemaVersion:CONTRACT_VERSION,lifeId:'life-'+randomUUID(),kind:'fixture',displayName:'TEST ONLY '+label,revision:1,authoritySessionId:randomUUID(),deployment});
  }
  return {root,token,manifests,registryRoot:resolve(root,'registry'),nativeRoot:resolve(root,'native'),async cleanup(){
    if(cleaned)return;
    const marker=JSON.parse(await readFile(resolve(root,'TEST-ONLY.json'),'utf8'));
    if(marker.token!==token||!contains(canonical(tmpdir()),canonical(root))||!root.includes('digital-life-TEST-ONLY-'))fail('FIXTURE_CLEANUP_OWNER_MISMATCH');
    await rm(root,{recursive:true,force:false,maxRetries:5,retryDelay:100});
    cleaned=true;
  }};
}
