import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {LifeRegistry} from '../registry.mjs';
import {createFixture} from '../fixture.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {FairAdmission} from './fair-admission.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function bounded(promise) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST ONLY fair admission deadline')),15000);})]);}
  finally{clearTimeout(timer);}
}
class Stub extends LlmAdapter {
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}
  async *stream(options) {
    await this.onStream?.(options);
    const block={type:'text',text:'TEST ONLY FAIR ADMISSION'};
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:block.text};
    yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:'stop'}};
  }
}
async function setup(labels=['A','B','C','D']) {
  const fixture=await createFixture(labels),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});let host;
  try {
    for(const manifest of fixture.manifests.slice(0,4))registry.register(manifest);
    const adapter=new Stub();host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter,providerRoutes:['TEST-shared-provider']});
    const agents=await Promise.all(fixture.manifests.slice(0,4).map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    const contexts=agents.map(agent=>host.contexts.execution(agent));
    return {fixture,registry,host,adapter,agents,contexts,async child(){
      return host.runtime.create({lifeId:contexts[0].lifeId,role:'delegate',parentSessionId:agents[0].session.id});
    },async cleanup(){await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}};
  }catch(error){if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();throw error;}
}
const prompt=(t,agent)=>t.host.runtime.prompt({lifeId:t.registry.owner(agent.session.id).lifeId,sessionId:agent.session.id,
  requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY FAIR NATIVE MODEL BARRIER'}]});
const row=(fair,c)=>fair.snapshot(c).owners[0];
const createFair=(t,policy={})=>new FairAdmission({registry:t.registry,contexts:t.host.contexts,...policy});

test('native model iterator leases keep four life reserves parallel despite A delegate flood; queued cancellation never enters transport',async()=>{
  const t=await setup();let fair;const release=deferred(),children=[];let unmount;
  const entered=new Set(),allChildren=deferred(),allOwners=deferred();
  try {
    fair=createFair(t);
    children.push(await t.child(),await t.child(),await t.child());
    t.adapter.onStream=async options=>{
      entered.add(options.sessionId);
      if(children.slice(0,2).every(a=>entered.has(a.session.id)))allChildren.resolve();
      if(t.agents.every(a=>entered.has(a.session.id)))allOwners.resolve();
      await new Promise((accept,reject)=>{
        const abort=()=>reject(options.signal.reason);options.signal.addEventListener('abort',abort,{once:true});
        release.promise.then(()=>{options.signal.removeEventListener('abort',abort);options.signal.aborted?reject(options.signal.reason):accept();});
      });
    };
    unmount=t.host.ctx.on('llm/stream',(options,next)=>(async function*(){
      const context=t.host.contexts.execution(t.host.ctx.agents.get(options.sessionId));
      const lease=await fair.acquire(context,{signal:options.signal});
      try{yield* next();}finally{lease.release();}
    })(),{prepend:true});
    await Promise.all(children.slice(0,2).map(agent=>prompt(t,agent)));await bounded(allChildren.promise);
    assert.equal(row(fair,t.contexts[0]).delegate_active,2);
    await prompt(t,children[2]);
    await Promise.all(t.agents.map(agent=>prompt(t,agent)));await bounded(allOwners.promise);
    assert.equal(entered.size,6);assert(!entered.has(children[2].session.id));
    const full=fair.snapshot();assert(full.owners.every(owner=>owner.reserved_active===1));assert.equal(full.shared_active,2);
    t.host.runtime.cancel({lifeId:t.contexts[0].lifeId,sessionId:children[2].session.id});await bounded(children[2].whenIdle());
    assert(!entered.has(children[2].session.id));assert.equal(row(fair,t.contexts[0]).delegate_queued,0);
    t.host.runtime.cancel({lifeId:t.contexts[0].lifeId,sessionId:children[0].session.id});await bounded(children[0].whenIdle());
    assert.equal(fair.snapshot().shared_active,1);assert.equal(t.agents[1].status,'running');
    release.resolve();await Promise.all([...t.agents,...children].map(agent=>bounded(agent.whenIdle())));
    assert(fair.snapshot().owners.every(owner=>owner.reserved_active===0&&owner.shared_active===0&&owner.delegate_queued===0));
  }finally{release.resolve();fair?.dispose();if(unmount)unmount();await t.cleanup();}
});

test('shared queue rotates by life, prefers non-delegates and keeps FIFO within each life',async()=>{
  const t=await setup();let fair;const leases=[];
  try {
    fair=createFair(t,{sharedSlots:1});
    leases.push(...await Promise.all(t.contexts.map(c=>fair.acquire(c))));
    let current=await fair.acquire(t.contexts[0]);leases.push(current);
    const order=[],jobs=[];
    for(const [label,context] of [['A1',t.contexts[0]],['A2',t.contexts[0]],['B',t.contexts[1]],['C',t.contexts[2]],['D',t.contexts[3]]])
      jobs.push(fair.acquire(context).then(lease=>{order.push(label);leases.push(lease);return lease;}));
    const expectedJobs=[2,3,4,0,1];
    for(const index of expectedJobs){current.release();current=await bounded(jobs[index]);}
    assert.deepEqual(order,['B','C','D','A1','A2']);current.release();
    const child=await t.child(),delegate=t.host.contexts.execution(child),hold=await fair.acquire(t.contexts[0]);leases.push(hold);
    const delegateJob=fair.acquire(delegate).then(lease=>{order.push('delegate');leases.push(lease);return lease;});
    const coreJob=fair.acquire(t.contexts[1]).then(lease=>{order.push('core');leases.push(lease);return lease;});
    hold.release();const core=await bounded(coreJob);assert.equal(order.at(-1),'core');core.release();(await bounded(delegateJob)).release();
    assert.equal(order.at(-1),'delegate');
  }finally{for(const lease of leases)lease.release();fair?.dispose();await t.cleanup();}
});

test('waiting cancellation and forged contexts never execute; operation finally owns active release',async()=>{
  const t=await setup();let fair,held,executed=false;
  try {
    fair=createFair(t,{sharedSlots:0});
    held=await fair.acquire(t.contexts[0]);const abort=new AbortController();
    const queued=fair.withLease(t.contexts[0],abort.signal,async()=>{executed=true;});abort.abort(Error('TEST ONLY cancelled before admission'));
    await assert.rejects(queued,/cancelled before admission/);assert.equal(executed,false);assert.equal(row(fair,t.contexts[0]).non_delegate_queued,0);
    await assert.rejects(fair.acquire({...t.contexts[0]}),/TRUSTED_EXECUTION_CONTEXT_REQUIRED/);
    const activeAbort=new AbortController(),inside=deferred(),finish=deferred();held.release();
    const running=fair.withLease(t.contexts[0],activeAbort.signal,async()=>{inside.resolve();await finish.promise;throw Error('TEST ONLY operation failure');});
    await bounded(inside.promise);activeAbort.abort(Error('TEST ONLY active cancellation'));
    assert.equal(row(fair,t.contexts[0]).reserved_active,1);finish.resolve();await assert.rejects(running,/operation failure/);
    assert.equal(row(fair,t.contexts[0]).reserved_active,0);
    const signal=new AbortController();const first=await fair.acquire(t.contexts[0]);
    const cancelledOnGrant=fair.withLease(t.contexts[0],signal.signal,async()=>{executed=true;});first.release();signal.abort(Error('TEST ONLY cancellation after grant'));
    await assert.rejects(cancelledOnGrant,/cancellation after grant/);assert.equal(executed,false);assert.equal(row(fair,t.contexts[0]).reserved_active,0);
    const snapshot=fair.snapshot(t.contexts[1]);assert.equal(snapshot.owners.length,1);assert.equal(snapshot.owners[0].life_id,t.contexts[1].lifeId);
    assert(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.policy));
    assert.throws(()=>{fair.policy={reserved_per_life:0};},TypeError);
  }finally{held?.release();fair?.dispose();await t.cleanup();}
});

test('a life delegate limit does not reserve or monopolize otherwise free shared capacity',async()=>{
  const t=await setup();let fair;const leases=[];
  try {
    fair=createFair(t,{sharedSlots:3,maxDelegatePerLife:1});
    const a1=await t.child(),a2=await t.child(),b=await t.host.runtime.create({lifeId:t.contexts[1].lifeId,role:'delegate',parentSessionId:t.agents[1].session.id});
    const first=await fair.acquire(t.host.contexts.execution(a1));leases.push(first);
    let secondEntered=false;
    const secondJob=fair.acquire(t.host.contexts.execution(a2)).then(lease=>{secondEntered=true;leases.push(lease);return lease;});
    const other=await fair.acquire(t.host.contexts.execution(b));leases.push(other);
    const core=await fair.acquire(t.contexts[0]);leases.push(core);
    assert.equal(secondEntered,false);assert.equal(fair.snapshot().shared_active,2);assert.equal(row(fair,t.contexts[0]).delegate_queued,1);
    assert.equal(row(fair,t.contexts[0]).reserved_active,1);assert.equal(row(fair,t.contexts[1]).delegate_active,1);
    first.release();const second=await bounded(secondJob);assert(secondEntered);assert.equal(row(fair,t.contexts[0]).delegate_active,1);second.release();
  }finally{for(const lease of leases)lease.release();fair?.dispose();await t.cleanup();}
});

test('registry additions gain their own reserve and disposal rejects waiters without stealing held leases',async()=>{
  const t=await setup(['A','B','C','D','E']);let fair,lease;
  try {
    fair=createFair(t,{sharedSlots:0});
    const manifest=t.fixture.manifests[4];t.registry.register(manifest);
    await t.host.ctx.agentPresets.register({id:manifest.deployment.presetId,name:'TEST ONLY ADDED E',plugins:[]});
    const agent=await t.host.runtime.create({lifeId:manifest.lifeId,sessionId:manifest.authoritySessionId,role:'authority'}),context=t.host.contexts.execution(agent);
    lease=await fair.acquire(context);assert.equal(row(fair,context).reserved_active,1);assert.equal(fair.snapshot().owners.length,5);
    const waiting=fair.acquire(context);fair.dispose();await assert.rejects(waiting,/FAIR_ADMISSION_DISPOSED/);
    assert.equal(row(fair,context).reserved_active,1);lease.release();lease.release();assert.equal(row(fair,context).reserved_active,0);
    await assert.rejects(fair.acquire(context),/FAIR_ADMISSION_DISPOSED/);
  }finally{lease?.release();fair?.dispose();await t.cleanup();}
});
