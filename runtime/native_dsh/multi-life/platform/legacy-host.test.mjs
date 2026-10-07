import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
test('T12: original composition preserves primary/Core/tasks/native fork across real Host process reopen',async()=>{
  const f=await createFixture(['LEGACY COMPATIBILITY']),m=f.manifests[0];let registry;
  try {
    Object.assign(m.deployment,{presetId:'persona',provider:'deepseek-official',model:'deepseek-flash',workspace:resolve(f.root,'workspace'),core:resolve(f.root,'workspace/persona-core.md'),
      state:resolve(f.root,'digital-life'),vault:resolve(f.root,'private-vault'),recovery:resolve(f.root,'recovery-state'),capabilities:resolve(f.root,'capability-profiles'),attachments:resolve(f.root,'attachments'),versions:resolve(f.root,'versions'),skillsRoots:[resolve(f.root,'workspace/.dsh/skills')]});
    await mkdir(m.deployment.workspace,{recursive:true});await writeFile(m.deployment.core,'TEST ONLY legacy compatibility Core unchanged\n');await writeFile(resolve(m.deployment.workspace,'AGENTS.md'),'TEST ONLY compatibility workspace\n');
    const original=await readFile(m.deployment.core);registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});registry.register(m);registry.close();registry=null;
    await writeFile(resolve(f.root,'TEST-ONLY-manifest.json'),JSON.stringify(m)+'\n');const worker=fileURLToPath(new URL('./legacy-fixture-worker.mjs',import.meta.url));
    for(const phase of ['first','reopen']) {const {stdout}=await promisify(execFile)(process.execPath,[worker,f.root,phase],{windowsHide:true,timeout:60000,maxBuffer:1024*1024});assert(stdout.includes('"passed":true'));}
    assert.deepEqual(await readFile(m.deployment.core),original);await f.cleanup();
    await writeFile(new URL('../../../../reports/multi-life-implementation-20261006/legacy-validation.json',import.meta.url),JSON.stringify({passed:true,observedAt:new Date().toISOString(),originalProfileComposition:true,
      simulatedLegacyOwner:true,unknownOwnersDenied:true,nativeForkLineagePreserved:true,primaryAndCoreUnchanged:true,realProcessReopen:true,uncleanHostCrashTested:false,
      fixtureCleaned:true,paidCalls:0,realPersonaAwakened:false,productionNWayActivated:false},null,2)+'\n');
  }finally{registry?.close();await f.cleanup();}
});
