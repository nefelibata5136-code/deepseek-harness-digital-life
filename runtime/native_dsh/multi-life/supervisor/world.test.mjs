import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {listenLifeHost} from '../platform/http.mjs';
import {createNeutralWorld} from './world.mjs';
import {readConversationSnapshot} from '../platform/conversation-storage.mjs';

const workerProgram=`
let config;
async function rpc(operation,input) {
  const r=await fetch(config.url+'/internal/worker/'+operation,{method:'POST',headers:{'content-type':'application/json','x-life-id':config.manifest.lifeId,authorization:'Bearer '+config.token},body:JSON.stringify(input)});
  const value=await r.json();if(!r.ok)throw Error(value.error);return value.value;
}
process.on('message',async input=>{
  try {
    if(input.kind==='start') {
      config=input;
      const m=config.manifest;
      await rpc('registerSession',{header:{version:4,id:m.authoritySessionId,cwd:m.deployment.workspace,agentPreset:m.deployment.presetId,createdAt:Date.now()},presetId:m.deployment.presetId,role:'authority'});
      await rpc('heartbeat',{pid:process.pid,busy:false,session_ids:[m.authoritySessionId],version:'TEST ONLY independent fixture worker',model_calls:0,model_wakes:0,reasoning_override:'high'});
      const message=await rpc('post',{sessionId:m.authoritySessionId,args:{room_id:config.roomId,body:'TEST ONLY worker started '+m.displayName}});
      process.send({kind:'ready',pid:process.pid,message_id:message.message_id});
    }else if(input.kind==='post') {
      const message=await rpc('post',{sessionId:config.manifest.authoritySessionId,args:{room_id:config.roomId,body:input.body}});
      process.send({kind:'posted',message_id:message.message_id});
    }
  }catch(e){process.send({kind:'error',error:e.message});}
});
`;
const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('fixture worker timeout')),10000);timer.unref();})]);
const reply=(worker,kind)=>bounded(new Promise((accept,reject)=>{
  const message=value=>{if(value.kind===kind||value.kind==='error'){worker.off('message',message);value.kind==='error'?reject(Error(value.error)):accept(value);}};
  worker.on('message',message);worker.once('error',reject);
}));
function childWorker() {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'].includes(key.toUpperCase())));
  return spawn(process.execPath,['--eval',workerProgram],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env});
}
async function stopWorker(worker) {
  if(worker.exitCode!==null||worker.signalCode!==null)return;
  const ended=once(worker,'exit');worker.kill('SIGKILL');await bounded(ended);
}
const json=async(url,{token,lifeId,method='GET',body}={})=>{
  const response=await fetch(url,{method,headers:{...token?{authorization:'Bearer '+token}:{},...lifeId?{'x-life-id':lifeId}:{},...body!==undefined?{'content-type':'application/json'}:{}},...body!==undefined?{body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(10000)});
  return {status:response.status,value:await response.json()};
};
async function setup() {
  const f=await createFixture(['NEUTRAL-A','NEUTRAL-B','NEUTRAL-C']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});
  for(const m of f.manifests)registry.register(m);
  const workerBindings=new Map(f.manifests.map(m=>[m.lifeId,{token:randomBytes(32).toString('hex'),allowedPresetId:m.deployment.presetId}]));
  let clock=Date.now();
  const options={registry,platformRoot:resolve(f.root,'neutral-world'),workerBindings,now:()=>clock,heartbeatTimeoutMs:1000};
  const host=createNeutralWorld(options),token=randomBytes(32).toString('hex');
  const endpoint=await listenLifeHost(host,{token,principalId:'human:fixture',displayName:'TEST ONLY developer',operator:true});
  const room=host.rooms.defineRoom({participants:['human:fixture',...f.manifests.map(m=>m.lifeId)],visibility:'shared'});
  return {f,registry,workerBindings,host,endpoint,token,room,url:'http://127.0.0.1:'+endpoint.port,options,
    advance:ms=>{clock+=ms;},async cleanup(){await host.dispose();await f.cleanup();}};
}

test('neutral Room/Registry persist while independent workers die; surviving worker and human keep sending',async()=>{
  const t=await setup(),children=[];
  try {
    const roomId=t.room.room_id??t.room.conversationId;
    const workers=t.f.manifests.slice(0,2).map(m=>{
      const worker=childWorker();children.push(worker);const ready=reply(worker,'ready');
      worker.send({kind:'start',url:t.url,manifest:m,roomId,token:t.workerBindings.get(m.lifeId).token});return {worker,ready};
    });
    await Promise.all(workers.map(r=>r.ready));
    const before=(await json(t.url+'/v1/supervisor',{token:t.token})).value;
    assert.equal(before.world_pid,process.pid);assert.equal(before.model_calls,0);assert.equal(before.workers.filter(r=>r.healthy).length,2);
    const [A,B,C]=t.f.manifests;assert.equal(before.workers.find(r=>r.life_id===C.lifeId).state,'offline');
    await stopWorker(workers[0].worker);
    const after=(await json(t.url+'/v1/supervisor',{token:t.token})).value;
    assert.equal(after.workers.find(r=>r.life_id===A.lifeId).healthy,false);
    assert.equal(after.workers.find(r=>r.life_id===B.lifeId).healthy,true);
    assert.equal(after.world_pid,process.pid);
    const saved=await json(t.url+'/v1/rooms/'+roomId+'/messages',{token:t.token,method:'POST',body:{body:'TEST ONLY human while A worker is dead',message_id:randomUUID()}});
    assert.equal(saved.status,200);assert.equal(saved.value.state,'saved');
    const posted=reply(workers[1].worker,'posted');workers[1].worker.send({kind:'post',body:'TEST ONLY B continues independently'});await posted;
    const page=await json(t.url+'/v1/rooms/'+roomId+'/messages',{token:t.token});assert.equal(page.status,200);
    assert.equal(page.value.messages.length,4);assert.deepEqual(page.value.messages.map(m=>m.seq),[1,2,3,4]);
    assert(page.value.messages.some(m=>m.body==='TEST ONLY B continues independently'&&m.life_id===B.lifeId));
    const inboxA=await json(t.url+'/v1/inbox?life_id='+A.lifeId,{token:t.token});assert.equal(inboxA.status,200);
    assert(inboxA.value.items.some(i=>i.message_id===saved.value.message.message_id));
    assert.equal((await json(t.url+'/v1/lives',{token:t.token})).value.lives.length,3);
    assert.equal(t.registry.list().length,3);
    await stopWorker(workers[1].worker);
    const frozenIds=page.value.messages.map(m=>m.message_id);
    await t.host.dispose();
    const reopenedRegistry=new LifeRegistry({root:t.f.registryRoot,mode:'fixture'}),reopened=createNeutralWorld({...t.options,registry:reopenedRegistry});
    try {
      const api=await listenLifeHost(reopened,{token:t.token,principalId:'human:fixture',displayName:'TEST ONLY developer',operator:true});
      const reread=await json('http://127.0.0.1:'+api.port+'/v1/rooms/'+roomId+'/messages',{token:t.token});
      assert.equal(reread.status,200);assert.deepEqual(reread.value.messages.map(m=>m.message_id),frozenIds);assert.equal(reopenedRegistry.list().length,3);
      assert(reopened.supervisor.snapshot().workers.every(w=>w.state==='offline'));
    }finally{await reopened.dispose();}
  }finally{await Promise.all(children.map(stopWorker));await t.cleanup();}
});

test('heartbeat expiry, worker authentication and delegate registration preserve existing life identities',async()=>{
  const t=await setup();
  try {
    const [A,B]=t.f.manifests,binding=t.workerBindings.get(A.lifeId),roomId=t.room.room_id??t.room.conversationId;
    const worker=(operation,body,lifeId=A.lifeId,token=binding.token)=>json(t.url+'/internal/worker/'+operation,{method:'POST',token,lifeId,body});
    const header={version:4,id:A.authoritySessionId,cwd:A.deployment.workspace,agentPreset:A.deployment.presetId,createdAt:Date.now()};
    assert.equal((await worker('registerSession',{header,presetId:A.deployment.presetId,role:'authority'})).status,200);
    const hb={pid:process.pid,busy:false,session_ids:[A.authoritySessionId],version:'TEST ONLY fixture health'};
    assert.equal((await worker('heartbeat',hb)).status,200);assert.equal(t.host.supervisor.snapshot().workers.find(w=>w.life_id===A.lifeId).healthy,true);
    t.advance(1001);assert.equal(t.host.supervisor.snapshot().workers.find(w=>w.life_id===A.lifeId).healthy,false);
    assert.equal((await worker('heartbeat',hb)).status,200);assert.equal(t.host.supervisor.snapshot().workers.find(w=>w.life_id===A.lifeId).healthy,true);
    const digest=async()=>createHash('sha256').update(JSON.stringify(readConversationSnapshot(resolve(t.options.platformRoot,'conversations')))).digest('hex');
    const before=await digest();
    assert.equal((await json(t.url+'/v1/rooms/'+roomId+'/messages',{method:'POST',body:{body:'TEST ONLY unauthorized'}})).status,403);
    assert.equal((await worker('post',{sessionId:A.authoritySessionId,args:{room_id:roomId,body:'TEST ONLY forged B'}},B.lifeId)).status,403);
    assert.equal(await digest(),before);
    assert.equal((await worker('heartbeat',{...hb,session_ids:[B.authoritySessionId]})).status,403);
    const unknown='life-'+randomUUID();assert.equal((await worker('heartbeat',hb,unknown)).status,403);assert.equal(t.registry.list().length,3);
    const delegateId=randomUUID(),delegate={...header,id:delegateId,parentSession:A.authoritySessionId,origin:'subagent',delegationDepth:1,createdAt:header.createdAt+1};
    const registered=await worker('registerSession',{header:delegate,presetId:A.deployment.presetId,role:'delegate',parentSessionId:A.authoritySessionId});
    assert.equal(registered.status,200);assert.equal(t.registry.owner(delegateId).lifeId,A.lifeId);assert.equal(t.registry.list().length,3);
    const social=await worker('post',{sessionId:delegateId,args:{room_id:roomId,body:'TEST ONLY delegated impersonation'}});
    assert.equal(social.status,403);assert.equal(social.value.error,'DELEGATE_SOCIAL_SEND_DENIED');assert.equal(await digest(),before);
    assert.equal(t.host.ctx.agents,undefined);assert.equal(t.host.supervisor.snapshot().model_calls,0);
  }finally{await t.cleanup();}
});
