import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootLifeHost} from '../host.mjs';
import {createOfficialProviderFactory} from './official-provider.mjs';

test('different logical provider accounts cannot silently resolve to one secret',async()=>{
  const factory=createOfficialProviderFactory({credentialForAccount:async()=>'TEST-ONLY-SAME-KEY-1234567890'});
  const host={budget:{},modelExecution:()=>{},contexts:{registry:{list:()=>[{lifeId:'life-TEST-A'},{lifeId:'life-TEST-B'}]}},
    providerAccountBindings:new Map([['life-TEST-A','TEST-account-A'],['life-TEST-B','TEST-account-B']])};
  await assert.rejects(factory({host,transport:async()=>{throw Error('must not dispatch');}}),/DISTINCT_PROVIDER_ACCOUNTS_REQUIRE_DISTINCT_CREDENTIALS/);
});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('TEST ONLY official provider deadline')),30000);timer.unref();})]);
const response=()=>new Response([
  {type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:12,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'TEST ONLY OFFICIAL ADAPTER LOCAL WIRE'}},
  {type:'content_block_stop',index:0},
  {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
  {type:'message_stop'},
].map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});

test('actual official DeepSeek adapter uses owner-budget global broker; four transports run together and secret rejection precedes reserve',async()=>{
  const fixture=await createFixture(['A','B','C','D']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});let host;
  const arrived=deferred(),release=deferred(),requests=[],key='sk-TEST-ONLY-PROVIDER-KEY-'+randomUUID(),otherKey='sk-TEST-ONLY-OTHER-PROVIDER-KEY-'+randomUUID();let holding=true,expectHigh=false;
  const providerKeys=new Map([['TEST-provider-account-A',key],['TEST-provider-account-B',otherKey]]),accountFor=new Map(fixture.manifests.map((m,i)=>[m.lifeId,i%2?'TEST-provider-account-B':'TEST-provider-account-A']));
  try {
    for(const m of fixture.manifests){m.deployment.provider='deepseek-official';m.deployment.model='deepseek-flash';m.deployment.maxTokens=256;registry.register(m);}
    const options={registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,providerRoutes:['deepseek-official'],
      memoryBindings:new Map(),ownerBindings:new Map(),admit:async()=>({allowed:true}),
      budgetConfig:{accounts:new Map([...providerKeys.keys()].map(ref=>[ref,{dailyLimitNanoCny:210000000000,stopOnUnknownUsage:false}])),
        lifeAccounts:new Map(fixture.manifests.map(m=>[m.lifeId,{accountRef:accountFor.get(m.lifeId)}])),fixtureNow:'2026-10-06T15:00:00+08:00'},
      providerFactory:createOfficialProviderFactory({credentialForAccount:async ref=>{assert(providerKeys.has(ref));return providerKeys.get(ref);}}),
      rawModelTransport:async(url,init)=>{
        assert.equal(url,'https://api.deepseek.com/anthropic/v1/messages');assert.equal(init.headers.authorization,'Bearer '+providerKeys.get(accountFor.get(init.headers['x-deepseek-harness-user-id'])));
        const body=JSON.parse(init.body);assert.equal(body.model,'deepseek-flash');assert(!init.body.includes(key)&&!init.body.includes(otherKey));
        if(expectHigh){assert.equal(body.output_config?.effort,'high');assert.equal(body.thinking?.type,'enabled');}
        requests.push({lifeId:init.headers['x-deepseek-harness-user-id'],sessionId:init.headers['x-deepseek-harness-session-id']});
        if(holding){if(requests.length===4)arrived.resolve();await new Promise((accept,reject)=>{
          const abort=()=>reject(init.signal.reason);init.signal.addEventListener('abort',abort,{once:true});
          release.promise.then(()=>{init.signal.removeEventListener('abort',abort);init.signal.aborted?reject(init.signal.reason):accept();});
        });}return response();
      }};
    host=await bootLifeHost(options);const agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    await Promise.all(fixture.manifests.map(m=>host.runtime.prompt({lifeId:m.lifeId,sessionId:m.authoritySessionId,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY ACTUAL OFFICIAL FOUR-WAY'}]})));
    await bounded(arrived.promise);assert.equal(new Set(requests.map(r=>r.lifeId)).size,4);
    for(const request of requests)assert.equal(registry.owner(request.sessionId).lifeId,request.lifeId);
    host.runtime.cancel({lifeId:fixture.manifests[0].lifeId,sessionId:agents[0].session.id});release.resolve();holding=false;
    await Promise.all(agents.map(agent=>bounded(agent.whenIdle())));await host.drainCheckpoints();
    for(const agent of agents.slice(1))assert([...agent.session.ownEvents()].some(e=>e.type==='turn/end'&&e.data.reason.kind==='completed'));
    const count=requests.length;
    await assert.rejects(fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:'{}'}),/TRUSTED_MODEL_BUDGET_CONTEXT_REQUIRED/);
    await assert.rejects(fetch('https://api.deepseek.com/anthropic/v1/files',{method:'POST',body:'{}'}),/UNPRICED_PROVIDER_ENDPOINT/);assert.equal(requests.length,count);
    await assert.rejects(fetch('https://api.deepseek.com./anthropic/v1/messages',{method:'POST',body:'{}'}),/UNPRICED_PROVIDER_ENDPOINT/);assert.equal(requests.length,count);
    const before=await host.budget.inspectAccount('TEST-provider-account-B');
    const stopInjection=host.ctx.on('llm/stream',async function*(options,next){options.messages.push({role:'user',content:[{type:'text',text:key}]});yield* next();},{prepend:true});
    await host.runtime.prompt({lifeId:fixture.manifests[1].lifeId,sessionId:agents[1].session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY HOST-INJECTED SECRET REJECTION'}]});await bounded(agents[1].whenIdle());stopInjection();
    const after=await host.budget.inspectAccount('TEST-provider-account-B');assert.equal(requests.length,count);assert.deepEqual(after.account,before.account);
    assert(!JSON.stringify([...agents[1].session.ownEvents()]).includes(key));
    await host.ctx.fiber.dispose();host=null;
    await assert.rejects(fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:'{}'}),/PROVIDER_BROKER_NO_ACTIVE_HOST/);
    // A recognized frozen broker can bind a cold Host, without a second global
    // replacement or the legacy gate's ambient context.
    host=await bootLifeHost(options);const reopened=await host.runtime.resolve({lifeId:fixture.manifests[2].lifeId,sessionId:agents[2].session.id});
    expectHigh=true;host.ctx.on('agent/request',async(_request,next)=>({...await next(),reasoningEffort:'high'}),{prepend:true});
    await host.runtime.prompt({lifeId:fixture.manifests[2].lifeId,sessionId:reopened.session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY OFFICIAL COLD REBIND'}]});await bounded(reopened.whenIdle());
    const coldOutcome=[...reopened.session.ownEvents()].findLast(e=>e.type==='turn/end').data.reason;
    assert.equal(coldOutcome.kind,'completed',JSON.stringify(coldOutcome));assert.equal(requests.length,count+1);
    await host.drainCheckpoints();
    await writeFile(new URL('../../../../reports/multi-life-implementation-20261006/official-provider-validation.json',import.meta.url),JSON.stringify({passed:true,observedAt:new Date().toISOString(),
      actualOfficialAdapter:true,fourOwnerTransportBarrier:true,providerAccounts:2,ownerCredentialAccountSelected:true,cancelAIndependent:true,unscopedProviderDenied:true,unpricedFilesDenied:true,providerDomainTailDotDenied:true,
      secretRejectedBeforeReserve:true,noSecretInJournal:true,brokerColdRebind:true,hostHighOverrideReachedActualWire:true,syntheticTransportAttempts:requests.length,paidModelCalls:0,realCredentialStoreAccessed:false},null,2)+'\n');
  }finally{release.resolve();if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}
});
