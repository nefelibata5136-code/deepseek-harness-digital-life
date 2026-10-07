import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,symlink,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {createFileLocks} from '../../../workspace_foundation/file-operation-locks.mjs';
import {createSharedResourceClient} from './shared-resource-client.mjs';
import {mountNormalInterfaceOwnership} from './normal-interface-ownership.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
const bounded=p=>Promise.race([p,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('file lease fixture timeout')),5000);timer.unref();})]);
function broker() {
  const locks=createFileLocks(),leases=new Map(),released=new Set(),counts={acquire:0,release:0};
  return {counts,locks,rpcFor(lifeId) {return async(operation,args,signal)=>{
    if(operation==='resourceAcquire') {
      counts.acquire++;const lease=await locks.acquire(args.key,lifeId+':'+args.sessionId,signal),id=randomUUID();
      leases.set(id,{lifeId,sessionId:args.sessionId,lease});return {lease_id:id};
    }
    assert.equal(operation,'resourceRelease');assert.equal(signal.aborted,false);counts.release++;
    if(released.has(args.lease_id))return {already_released:true};
    const row=leases.get(args.lease_id);assert.equal(row.lifeId,lifeId);assert.equal(row.sessionId,args.sessionId);
    row.lease.release();leases.delete(args.lease_id);released.add(args.lease_id);return {released:true};
  };},dispose(){locks.dispose();}};
}

test('two life-bound RPC clients reject busy aliases immediately, keep other files parallel and release once after cancellation',async()=>{
  const f=await createFixture(['LEASE-A','LEASE-B']),central=broker();
  try {
    const [A,B]=f.manifests,a={lifeId:A.lifeId,sessionId:A.authoritySessionId},b={lifeId:B.lifeId,sessionId:B.authoritySessionId};
    const first=createSharedResourceClient({lifeId:A.lifeId,rpc:central.rpcFor(A.lifeId)}),second=createSharedResourceClient({lifeId:B.lifeId,rpc:central.rpcFor(B.lifeId)});
    const sharedDir=resolve(f.root,'shared-directory'),aliasDir=resolve(f.root,'shared-alias');
    await mkdir(sharedDir);const shared=resolve(sharedDir,'shared.txt'),other=resolve(f.root,'other.txt');await writeFile(shared,'TEST ONLY shared');
    await symlink(sharedDir,aliasDir,process.platform==='win32'?'junction':'dir');const alias=resolve(aliasDir,'shared.txt');
    const held=await first.acquire(a,{path:shared,write:true});
    await assert.rejects(bounded(second.acquire(b,{path:alias,write:true})),e=>e.code==='FILE_BUSY'&&e.details.operation_started===false);
    const unrelated=await bounded(second.acquire(b,{path:other,write:true}));await unrelated.release();
    const readsBefore=central.counts.acquire;await (await second.acquire(b,{path:shared})).release();assert.equal(central.counts.acquire,readsBefore);
    await Promise.all([held.release(),held.release()]);const next=await bounded(second.acquire(b,{path:shared,write:true}));await next.release();
    assert.equal(central.counts.release,3);assert.equal(central.locks.owners.length,0);
    await assert.rejects(first.acquire(b,{path:shared}),/SHARED_RESOURCE_OWNER_MISMATCH/);
    const holding=await first.acquire(a,{path:shared,write:true}),abort=new AbortController();
    abort.abort(Error('TEST ONLY cancel before acquire'));
    await assert.rejects(second.acquire(b,{path:shared,write:true,signal:abort.signal}),/TEST ONLY cancel before acquire/);await holding.release();assert.equal(central.locks.owners.length,0);
    const afterGrant=new AbortController();let releaseSignal;
    const late=createSharedResourceClient({lifeId:A.lifeId,rpc:async(operation,_args,signal)=>{
      if(operation==='resourceAcquire'){afterGrant.abort(Error('TEST ONLY cancel after grant'));return {lease_id:'TEST-only-granted'};}
      releaseSignal=signal;return {released:true};
    }});
    await assert.rejects(late.acquire(a,{path:shared,write:true,signal:afterGrant.signal}),/TEST ONLY cancel after grant/);
    assert.equal(releaseSignal.aborted,false);assert.equal(late.status().active,0);
  }finally{central.dispose();await f.cleanup();}
});

test('actual native source readers never acquire write leases; private reads still fail before execution',async()=>{
  const f=await createFixture(['TOOL-LEASE-A','TOOL-LEASE-B']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'}),central=broker();let host;
  const entered=deferred(),unblock=deferred();let sharedEntries=0;
  try {
    for(const m of f.manifests)registry.register(m);
    const clients=new Map(f.manifests.map(m=>[m.lifeId,createSharedResourceClient({lifeId:m.lifeId,rpc:central.rpcFor(m.lifeId)})]));
    const shared=resolve(f.root,'public-shared.txt'),other=resolve(f.root,'public-other.txt'),errorFile=resolve(f.root,'public-error.txt');
    await Promise.all([writeFile(shared,'TEST ONLY shared'),writeFile(other,'TEST ONLY other')]);
    host=await bootScoped({registry,root:f.nativeRoot,fixtureRoot:f.root,extensions:[async h=>{
      mountNormalInterfaceOwnership(h.ctx,{registry,contexts:h.contexts,manifests:()=>registry.list(),acquireResource:(c,args)=>clients.get(c.lifeId).acquire(c,args)});
      h.ctx.tools.register(defineTool({name:'read_source',description:'TEST ONLY source body barrier',parameters:{file_path:{type:'string',required:true}},
        output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async args=>{
          if(args.file_path===errorFile)throw Error('TEST ONLY source body failed');
          if(args.file_path===shared&&++sharedEntries===1){entered.resolve();await unblock.promise;}
          return {read:args.file_path};
        }}));
    }]});
    const agents=await Promise.all(f.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    const call=(agent,path)=>host.ctx.tools.execute({agent,name:'read_source',arguments:{file_path:path},callId:randomUUID(),signal:new AbortController().signal});
    const first=call(agents[0],shared);await bounded(entered.promise);const second=call(agents[1],shared);
    assert.equal((await bounded(call(agents[1],other))).isError,false);assert.equal(sharedEntries,2);assert.equal(central.counts.acquire,0);
    const before=central.counts.acquire,denied=await call(agents[0],resolve(f.manifests[1].deployment.workspace,'same-name.txt'));
    assert(denied.isError);assert.equal(central.counts.acquire,before);
    unblock.resolve();const results=await bounded(Promise.all([first,second]));assert(results.every(r=>r.isError===false));assert.equal(sharedEntries,2);
    const failed=await call(agents[0],errorFile);assert(failed.isError);assert.equal(central.locks.owners.length,0);
    assert.equal(host.ctx.get('normalInterfaceOwnership').status().shared_file_coordination,'neutral-host-lease');
  }finally{unblock.resolve();if(host)await host.ctx.fiber.dispose();registry.close();central.dispose();await f.cleanup();}
});

test('native tool result exposes FILE_BUSY and does not enter the second writer',async()=>{
  const f=await createFixture(['WRITE-A','WRITE-B']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'}),central=broker();let host;
  const entered=deferred(),unblock=deferred();let bodies=0;
  try {
    for(const m of f.manifests)registry.register(m);
    const clients=new Map(f.manifests.map(m=>[m.lifeId,createSharedResourceClient({lifeId:m.lifeId,rpc:central.rpcFor(m.lifeId)})]));
    const shared=resolve(f.root,'native-conflict.txt');await writeFile(shared,'TEST ONLY original');
    host=await bootScoped({registry,root:f.nativeRoot,fixtureRoot:f.root,extensions:[async h=>{
      mountNormalInterfaceOwnership(h.ctx,{registry,contexts:h.contexts,manifests:()=>registry.list(),acquireResource:(c,args)=>clients.get(c.lifeId).acquire(c,args)});
      h.ctx.on('tools/execute',async(exec,next)=>{if(exec.name==='write'&&exec.arguments.file_path===shared){bodies++;entered.resolve();await unblock.promise;}return next();});
    }]});
    const agents=await Promise.all(f.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    const call=a=>host.ctx.tools.execute({agent:a,name:'write',arguments:{file_path:shared,content:'TEST ONLY replacement'},callId:randomUUID(),signal:new AbortController().signal});
    const first=call(agents[0]);await bounded(entered.promise);
    const busy=await bounded(call(agents[1]));assert.equal(busy.isError,true);assert.match(JSON.stringify(busy),/FILE_BUSY/);assert.match(JSON.stringify(busy),/operation_started/);assert.equal(bodies,1);
    unblock.resolve();assert.equal((await bounded(first)).isError,false);assert.equal(central.locks.owners.length,0);
  }finally{unblock.resolve();if(host)await host.ctx.fiber.dispose();registry.close();central.dispose();await f.cleanup();}
});
