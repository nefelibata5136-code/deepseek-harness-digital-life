import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,symlink,readFile,unlink} from 'node:fs/promises';
import {LifeRegistry} from './registry.mjs';
import {LegacyAdapter,inspectLegacy} from './legacy.mjs';
import {createFixture} from './fixture.mjs';
import {canonical} from './contracts.mjs';

test('unclean writer exit releases control-plane lock and preserves durable reservation',async()=>{
  const f=await createFixture(['A']);let child,reopened;
  try {
    const inputPath=resolve(f.root,'input.json');await writeFile(inputPath,JSON.stringify({root:f.registryRoot,m:f.manifests[0]}));
    const script="import {LifeRegistry} from "+JSON.stringify(new URL('./registry.mjs',import.meta.url).href)+";import {readFileSync} from 'node:fs';const input=JSON.parse(readFileSync(process.argv[1],'utf8'));const r=new LifeRegistry({root:input.root,mode:'fixture'});r.register(input.m);r.reserve({lifeId:input.m.lifeId,sessionId:input.m.authoritySessionId,role:'authority'});process.stdout.write('READY\\n');setInterval(()=>{r.list();},1000);";
    child=spawn(process.execPath,['--input-type=module','-e',script,inputPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let error='';child.stderr.on('data',x=>{error+=x;});
    await new Promise((accept,reject)=>{child.stdout.once('data',accept);child.once('error',reject);child.once('exit',code=>reject(Error(error+' '+code)));});
    assert.throws(()=>new LifeRegistry({root:f.registryRoot,mode:'fixture'}),/REGISTRY_WRITER_ALREADY_ACTIVE/);
    const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;
    reopened=new LifeRegistry({root:f.registryRoot,mode:'fixture'});
    assert.equal(reopened.owner(f.manifests[0].authoritySessionId).status,'reserved');reopened.close();
  } finally {reopened?.close();if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}await f.cleanup();}
});
test('manifest alias collision, immutable identity, corruption and fixture promotion fail closed',async()=>{
  const f=await createFixture(['A','B']);let r;
  try {
    const [A,B]=f.manifests;r=new LifeRegistry({root:f.registryRoot,mode:'fixture'});r.register(A);
    const alias=resolve(f.root,'alias');await symlink(A.deployment.workspace,alias,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>r.register({...B,deployment:{...B.deployment,workspace:alias,core:resolve(alias,'test-core.md'),skillsRoots:[resolve(alias,'.dsh/skills')]}}),/PRIVATE_RESOURCE_OWNER_COLLISION/);
    const header={id:A.authoritySessionId,cwd:A.deployment.workspace,createdAt:1,agentPreset:A.deployment.presetId};
    r.reserve({lifeId:A.lifeId,sessionId:A.authoritySessionId,role:'authority'});r.complete(A.authoritySessionId,header);
    assert.throws(()=>r.assertNative(A.authoritySessionId,{...header,createdAt:2}),/NATIVE_SESSION_IDENTITY_CHANGED/);
    r.close();r=null;
    await writeFile(resolve(f.registryRoot,'registry.json'),'{broken');assert.throws(()=>new LifeRegistry({root:f.registryRoot,mode:'fixture'}));
    const production=new LifeRegistry({root:resolve(f.root,'production-rejection'),mode:'production'});
    try {
      assert.throws(()=>production.register({...A,kind:'independent',displayName:null}),/FIXTURE_RESOURCES_CANNOT_BECOME_PRODUCTION/);
      const marker=resolve(f.root,'TEST-ONLY.json'),original=await readFile(marker);await unlink(marker);
      try{assert.throws(()=>production.register({...A,kind:'independent',displayName:null}),/FIXTURE_RESOURCES_CANNOT_BECOME_PRODUCTION/);}
      finally{await writeFile(marker,original);}
    }
    finally {production.close();}
  } finally {r?.close();await f.cleanup();}
});
test('canonical paths preserve missing components directly under a drive root',()=>{
  const root=process.platform==='win32'?'C:\\':'/';const path=resolve(root,'TEST-MISSING-'+randomUUID(),'child');
  assert.equal(canonical(path),process.platform==='win32'?path.toLowerCase():path);
});
test('authority seat identities are reserved before native Session creation in either order',async()=>{
  const f=await createFixture(['A','B','C']);const r=new LifeRegistry({root:f.registryRoot,mode:'fixture'});
  try {
    const [A,B,C]=f.manifests;r.register(A);r.register(B);
    assert.throws(()=>r.reserve({lifeId:B.lifeId,sessionId:A.authoritySessionId}),/AUTHORITY_SESSION_RESERVED_BY_OTHER_LIFE/);
    const id=randomUUID();r.reserve({lifeId:A.lifeId,sessionId:id});
    assert.throws(()=>r.register({...C,authoritySessionId:id}),/AUTHORITY_SESSION_ALREADY_OWNED/);
  }finally{r.close();await f.cleanup();}
});
test('legacy facade forwards exclusively to unchanged legacy identity without writing data',async()=>{
  const manifest={lifeId:'life-'+randomUUID(),kind:'legacy',authoritySessionId:randomUUID()};const seen=[];
  const runtime={registry:{life:id=>{assert.equal(id,manifest.lifeId);return manifest;}},prompt:q=>{seen.push(q);return q;},resolve:q=>{seen.push(q);return q;}};
  const adapter=new LegacyAdapter({runtime,lifeId:manifest.lifeId});const request={sessionId:manifest.authoritySessionId,requestId:randomUUID(),content:[{type:'text',text:'fixture only'}]};
  assert.equal(adapter.prompt(request).lifeId,manifest.lifeId);
  assert.throws(()=>adapter.prompt({...request,lifeId:'other'}),/LEGACY_API_OWNER_MISMATCH/);
  assert.throws(()=>adapter.resolve({...request,lifeId:'other'}),/LEGACY_API_OWNER_MISMATCH/);
  assert.equal(adapter.resolve({sessionId:manifest.authoritySessionId}).lifeId,manifest.lifeId);assert.equal(seen.length,2);
});
