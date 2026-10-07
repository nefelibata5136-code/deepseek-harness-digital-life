import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {canonical} from '../contracts.mjs';
import {listenLifeHost} from '../platform/http.mjs';
import {createSharedResourceClient} from '../platform/shared-resource-client.mjs';
import {createNeutralWorld} from './world.mjs';
import {SharedFileResources} from './resources.mjs';

const key=path=>canonical(path).replaceAll('\\','/');
const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('TEST ONLY resource fixture timeout')),10000);timer.unref();})]);
const until=predicate=>new Promise((accept,reject)=>{const timer=setInterval(()=>{try{if(predicate()){clearInterval(timer);clearTimeout(timeout);accept();}}catch(error){clearInterval(timer);clearTimeout(timeout);reject(error);}},10);
  const timeout=setTimeout(()=>{clearInterval(timer);reject(Error('TEST ONLY cancelled queue timeout'));},5000);});
const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'].includes(k.toUpperCase())));
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.kill('SIGKILL');await bounded(exit);}
async function registered(names) {
  const f=await createFixture(names),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});
  for(const m of f.manifests) {
    registry.register(m);registry.reserve({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'});
    registry.complete(m.authoritySessionId,{version:4,id:m.authoritySessionId,cwd:m.deployment.workspace,agentPreset:m.deployment.presetId,createdAt:Date.now()});
  }
  return {f,registry,root:resolve(f.root,'neutral-resources'),args:(m,path,pid=process.pid)=>({lifeId:m.lifeId,sessionId:m.authoritySessionId,key:key(path),pid})};
}

test('durable broker returns conflicts with exact holders immediately; independent files and owner checks remain',async()=>{
  const t=await registered(['FILE-A','FILE-B','FILE-C']);let broker;
  try {
    broker=new SharedFileResources({registry:t.registry,root:t.root});const [A,B,C]=t.f.manifests,shared=resolve(t.f.root,'public.txt'),other=resolve(t.f.root,'other.txt');
    const first=await broker.acquire(t.args(A,shared));
    const busy=await bounded(broker.acquire(t.args(B,shared)));
    assert.equal(busy.conflict.error,'FILE_BUSY');assert.equal(busy.lease_id,undefined);
    assert.equal(busy.conflict.holders[0].life_id,A.lifeId);assert.equal(busy.conflict.holders[0].session_id,A.authoritySessionId);
    const unrelated=await bounded(broker.acquire(t.args(C,other)));assert.equal(broker.snapshot().pending_count,0);
    assert.throws(()=>broker.release({lifeId:B.lifeId,sessionId:B.authoritySessionId,lease_id:first.lease_id}),/RESOURCE_LEASE_OWNER_MISMATCH/);
    assert.equal(broker.release({...t.args(A,shared),lease_id:first.lease_id}).released,true);
    const second=await bounded(broker.acquire(t.args(B,shared)));
    const abort=new AbortController();abort.abort(Error('TEST ONLY request cancelled'));
    await assert.rejects(broker.acquire({...t.args(C,shared),signal:abort.signal}),/TEST ONLY request cancelled/);assert.equal(broker.snapshot().pending_count,0);
    broker.release({...t.args(B,shared),lease_id:second.lease_id});broker.release({...t.args(C,other),lease_id:unrelated.lease_id});
    assert.equal(broker.snapshot().active_count,0);assert.equal(broker.release({...t.args(A,shared),lease_id:first.lease_id}).already_released,true);
    await assert.rejects(broker.acquire({...t.args(A,shared),key:'relative.txt'}),/RESOURCE_CANONICAL_PATH_REQUIRED/);
    await assert.rejects(broker.acquire({...t.args(A,shared),key:t.f.root.replaceAll('\\','/')+'/./public.txt'}),/RESOURCE_CANONICAL_PATH_REQUIRED/);
    await assert.rejects(broker.acquire({...t.args(A,shared),pid:0}),/WORKER_HEALTH_REQUIRED/);
    await assert.rejects(broker.acquire({...t.args(A,shared),sessionId:B.authoritySessionId}),/SESSION_OWNER_MISMATCH/);
    assert.throws(()=>new SharedFileResources({registry:t.registry,root:t.root}),/RESOURCE_WRITER_ALREADY_ACTIVE/);
    const journal=JSON.parse(await readFile(resolve(t.root,'leases.json'),'utf8'));assert.equal(journal.leases.length,0);
  }finally{broker?.dispose();t.registry.close();await t.f.cleanup();}
});

test('central process death retains fsynced grants to alive workers; disposal and confirmed worker death safely reclaim',async()=>{
  const t=await registered(['CRASH-A','CRASH-B']);let central,worker,registry,broker;
  const [A,B]=t.f.manifests,shared=resolve(t.f.root,'surviving-worker-public.txt');t.registry.close();
  try {
    const program=`import {LifeRegistry} from ${JSON.stringify(new URL('../registry.mjs',import.meta.url).href)};
      import {SharedFileResources} from ${JSON.stringify(new URL('./resources.mjs',import.meta.url).href)};
      process.on('message',async c=>{try{const registry=new LifeRegistry({root:c.registryRoot,mode:'fixture'});
        const broker=new SharedFileResources({registry,root:c.root});const grant=await broker.acquire(c.args);process.send({grant});
      }catch(error){process.send({error:error.message});}});`;
    central=spawn(process.execPath,['--input-type=module','--eval',program],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:cleanEnv()});
    const message=bounded(once(central,'message'));central.send({registryRoot:t.f.registryRoot,root:t.root,args:t.args(A,shared)});
    const [received]=await message;assert.equal(received.error,undefined);await stop(central);
    registry=new LifeRegistry({root:t.f.registryRoot,mode:'fixture'});broker=new SharedFileResources({registry,root:t.root});
    assert.equal(broker.snapshot().active_count,1);assert.equal(broker.snapshot().leases[0].pid,process.pid);
    const conflict=await broker.acquire(t.args(B,shared));assert.equal(conflict.conflict.error,'FILE_BUSY');assert.equal(broker.reap().reclaimed,0);
    const before=await readFile(resolve(t.root,'leases.json'),'utf8');broker.dispose();
    assert.equal(await readFile(resolve(t.root,'leases.json'),'utf8'),before);broker=new SharedFileResources({registry,root:t.root});
    assert.equal(broker.snapshot().active_count,1);broker.release({...t.args(A,shared),lease_id:received.grant.lease_id});
    worker=spawn(process.execPath,['--eval','setInterval(()=>{},60000)'],{windowsHide:true,stdio:'ignore',env:cleanEnv()});await once(worker,'spawn');
    await broker.acquire(t.args(A,shared,worker.pid));assert.equal(broker.snapshot().active_count,1);
    await stop(worker);assert.equal(broker.reap().reclaimed,1);assert.equal(broker.snapshot().active_count,0);
    const replacement=await bounded(broker.acquire(t.args(B,shared)));broker.release({...t.args(B,shared),lease_id:replacement.lease_id});
  }finally{await stop(central);await stop(worker);broker?.dispose();registry?.close();await t.f.cleanup();}
});

test('authenticated loopback RPC returns FILE_BUSY to the tool, keeps reads independent, and retains live leases after stale heartbeat',async()=>{
  const f=await createFixture(['HTTP-LEASE-A','HTTP-LEASE-B']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});let host;
  try {
    for(const m of f.manifests)registry.register(m);
    const bindings=new Map(f.manifests.map(m=>[m.lifeId,{token:randomBytes(32).toString('hex'),allowedPresetId:m.deployment.presetId}]));let clock=Date.now();
    host=createNeutralWorld({registry,platformRoot:resolve(f.root,'neutral-http-world'),workerBindings:bindings,now:()=>clock,heartbeatTimeoutMs:1000});
    const operator=randomBytes(32).toString('hex'),api=await listenLifeHost(host,{token:operator,principalId:'human:resources-fixture',displayName:'TEST ONLY file broker operator',operator:true}),url='http://127.0.0.1:'+api.port;
    const rpcFor=(lifeId,token=bindings.get(lifeId).token)=>async(operation,input,signal=AbortSignal.timeout(10000))=>{
      const response=await fetch(url+'/internal/worker/'+operation,{method:'POST',headers:{'content-type':'application/json','x-life-id':lifeId,authorization:'Bearer '+token},body:JSON.stringify(input),signal});
      const value=await response.json();if(!response.ok)throw Error(value.error);return value.value;
    };
    for(const m of f.manifests){const rpc=rpcFor(m.lifeId);await rpc('registerSession',{header:{version:4,id:m.authoritySessionId,cwd:m.deployment.workspace,agentPreset:m.deployment.presetId,createdAt:clock},presetId:m.deployment.presetId,role:'authority'});
      await assert.rejects(rpc('resourceAcquire',{sessionId:m.authoritySessionId,key:key(resolve(f.root,'no-heartbeat-public.txt'))}),/WORKER_HEALTH_REQUIRED/);
      await rpc('heartbeat',{pid:process.pid,busy:false,session_ids:[m.authoritySessionId],version:'TEST ONLY resources loopback',model_calls:0,model_wakes:0});}
    const [A,B]=f.manifests,ca={lifeId:A.lifeId,sessionId:A.authoritySessionId},cb={lifeId:B.lifeId,sessionId:B.authoritySessionId};
    const a=createSharedResourceClient({lifeId:A.lifeId,rpc:rpcFor(A.lifeId)}),b=createSharedResourceClient({lifeId:B.lifeId,rpc:rpcFor(B.lifeId)}),shared=resolve(f.root,'public-shared.txt'),other=resolve(f.root,'public-other.txt');
    const first=await a.acquire(ca,{path:shared,write:true});
    await assert.rejects(bounded(b.acquire(cb,{path:shared,write:true})),e=>e.code==='FILE_BUSY'&&e.details.holders[0].life_id===A.lifeId);
    const readA=await a.acquire(ca,{path:shared}),readB=await b.acquire(cb,{path:shared});await readA.release();await readB.release();
    assert.equal(host.sharedResources.snapshot().active_count,1);assert.equal(host.sharedResources.snapshot().pending_count,0);
    const separate=await bounded(b.acquire(cb,{path:other,write:true}));await separate.release();
    await assert.rejects(rpcFor(A.lifeId)('resourceAcquire',{sessionId:B.authoritySessionId,key:key(other)}),/SESSION_OWNER_MISMATCH/);
    await assert.rejects(rpcFor(B.lifeId,bindings.get(A.lifeId).token)('resourceAcquire',{sessionId:B.authoritySessionId,key:key(other)}),/WORKER_AUTHENTICATION_FAILED/);
    await assert.rejects(rpcFor(A.lifeId,'')('resourceAcquire',{sessionId:A.authoritySessionId,key:key(other)}),/WORKER_AUTHENTICATION_FAILED/);
    await assert.rejects(rpcFor(A.lifeId)('resourceAcquire',{sessionId:A.authoritySessionId,key:key(other),pid:process.pid}),/RESOURCE_INPUT_INVALID/);
    clock+=1001;assert(host.supervisor.snapshot().workers.every(w=>w.healthy===false));assert.equal(host.sharedResources.reap().reclaimed,0);assert.equal(host.sharedResources.snapshot().active_count,1);
    await first.release();assert.equal(host.sharedResources.snapshot().active_count,0);
    const followup=await bounded(b.acquire(cb,{path:shared,write:true}));await followup.release();
    const view=await fetch(url+'/v1/resources',{headers:{authorization:'Bearer '+operator}});assert.equal(view.status,200);const snapshot=await view.json();
    assert.equal(snapshot.active_count,0);assert.equal(snapshot.pending_count,0);assert.equal(host.supervisor.snapshot().model_calls,0);assert.equal(registry.list().length,2);
  }finally{await host?.dispose();if(!host)registry.close();await f.cleanup();}
});
