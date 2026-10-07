import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootLifeHost} from '../host.mjs';
import {createOfficialProviderFactory} from '../platform/official-provider.mjs';
import {mountHighTestOverride} from '../supervisor/reasoning.mjs';
import {mountBudgetGuard} from '../../../budget_guard/provider_gate.mjs';
import {provenanceForAgent,wirePromptMetadata} from './provenance.mjs';

const python=(process.env.DL_PYTHON || 'python');
const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('TEST ONLY High helper deadline')),30000);timer.unref();})]);
function response() {
  return new Response([
    {type:'message_start',message:{id:'TEST-provider-'+randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:40,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:60}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'TEST ONLY COMPLETE'}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:4,reasoning_tokens:2}},
    {type:'message_stop'}
  ].map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}

test('current root High helper wins normal hooks, survives default-off resolution, reaches two-life actual wire and blocks later downgrades',async()=>{
  const helperPath=new URL('../supervisor/reasoning.mjs',import.meta.url),helperHash=createHash('sha256').update(await readFile(helperPath)).digest('hex');
  const fixture=await createFixture(['LEGACY-SHAPE','MODERN-SHAPE']);
  const registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),wire=[];let host;
  const highFile=resolve(fixture.root,'TEST-ONLY-high.json'),account='TEST-High-shared-account';
  await writeFile(highFile,JSON.stringify({enabled:true,life_ids:fixture.manifests.map(manifest=>manifest.lifeId)}));
  try {
    for(const manifest of fixture.manifests){manifest.deployment.provider='deepseek-official';manifest.deployment.model='deepseek-flash';manifest.deployment.maxTokens=256;registry.register(manifest);}
    host=await bootLifeHost({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,providerRoutes:['deepseek-official'],
      memoryBindings:new Map(),ownerBindings:new Map(),admit:async()=>({allowed:true}),
      budgetConfig:{budgetLimitsEnabled:false,accounts:new Map([[account,{dailyLimitNanoCny:1,stopOnUnknownUsage:false}]]),
        lifeAccounts:new Map(fixture.manifests.map(manifest=>[manifest.lifeId,{accountRef:account}])),fixtureNow:'2026-10-06T20:00:00+08:00'},
      providerFactory:createOfficialProviderFactory({credentialForAccount:async()=>'TEST-ONLY-HIGH-KEY-'+randomUUID()}),
      rawModelTransport:async(_url,init)=>{
        const body=JSON.parse(init.body),lifeId=init.headers['x-deepseek-harness-user-id'];
        wire.push({life_id:lifeId,session_id:init.headers['x-deepseek-harness-session-id'],...wirePromptMetadata(body)});
        assert.equal(body.output_config?.effort,'high');assert.equal(body.thinking?.type,'enabled');return response();
      }});
    // Match real worker ordering: other request hooks already exist before the
    // High override is mounted. They may propose off; the Host override must win.
    const ordinaryHook=host.ctx.on('agent/request',async(_request,next)=>({...await next(),reasoningEffort:'off'}));
    const metrics=fixture.manifests.map(manifest=>mountHighTestOverride(host.ctx,{lifeId:manifest.lifeId,path:highFile}));
    const agents=await Promise.all(fixture.manifests.map(manifest=>host.runtime.create({lifeId:manifest.lifeId,sessionId:randomUUID(),role:'activity'})));
    const rpcIds=[];
    for(let round=0;round<2;round++) {
      await Promise.all(fixture.manifests.map(async(manifest,index)=>{
        const requestId='TEST-High-'+index+'-'+round;rpcIds.push(requestId);
        await host.runtime.prompt({lifeId:manifest.lifeId,sessionId:agents[index].session.id,requestId,sourceKind:'developer-test',content:[{type:'text',text:'TEST ONLY fixed High stable task. Return the same short completion.'}]});
        await bounded(agents[index].whenIdle());
        const outcome=[...agents[index].session.ownEvents()].findLast(event=>event.type==='turn/end').data.reason;
        assert.equal(outcome.kind,'completed',JSON.stringify(outcome));
      }));
    }
    assert.equal(wire.length,4);assert.equal(new Set(wire.map(row=>row.life_id)).size,2);
    const db=resolve(fixture.registryRoot,'budget',createHash('sha256').update(account).digest('hex')+'.sqlite3');
    const query=spawnSync(python,['-B','-X','utf8',resolve(import.meta.dirname,'usage.py'),'--ledger',db,'--day','2026-10-06'],{encoding:'utf8',windowsHide:true});
    assert.equal(query.status,0,query.stderr);const usage=JSON.parse(query.stdout);
    assert.equal(usage.requests.length,4);assert.equal(usage.total.cache_hit_rate,0.6);
    for(const row of usage.requests){assert.equal(row.reason,'developer_test');assert(rpcIds.includes(row.request_id));assert.equal(row.prompt_metadata.reasoning_effort,'high');assert.equal(row.prompt_metadata.thinking_mode,'enabled');}
    for(const manifest of fixture.manifests) {
      const requests=usage.requests.filter(row=>row.life_id===manifest.lifeId);
      assert.equal(requests.length,2);assert.equal(requests[0].prompt_metadata.system_hash,requests[1].prompt_metadata.system_hash);
      assert.equal(requests[0].prompt_metadata.tools_hash,requests[1].prompt_metadata.tools_hash);
      assert.equal(requests[0].prompt_metadata.first_message_hash,requests[1].prompt_metadata.first_message_hash);
    }
    assert.equal(usage.cache_by_sequence.filter(group=>group.position==='first_in_session_window').length,2);
    assert.equal(usage.cache_by_sequence.filter(group=>group.position==='repeated_in_session_window').length,2);
    // A new outer hook could win after High. The stream guard must reject it
    // before reserve/transport, rather than silently allowing a Low/Off call.
    const downgrade=host.ctx.on('agent/request',async(_request,next)=>({...await next(),reasoningEffort:'off'}),{prepend:true});
    await host.runtime.prompt({lifeId:fixture.manifests[0].lifeId,sessionId:agents[0].session.id,requestId:'TEST-late-downgrade',sourceKind:'developer-test',content:[{type:'text',text:'TEST ONLY must stop before provider'}]});
    await bounded(agents[0].whenIdle());assert.equal(wire.length,4);
    const rejected=[...agents[0].session.ownEvents()].findLast(event=>event.type==='turn/end').data.reason;
    assert.equal(rejected.kind,'error');assert.match(JSON.stringify(rejected),/TEST_HIGH_OVERRIDE_NOT_APPLIED/);downgrade();ordinaryHook();
    assert(metrics.every(item=>item.status().reasoning_override==='high'));
    await host.drainCheckpoints();
    assert.equal(createHash('sha256').update(await readFile(helperPath)).digest('hex'),helperHash,'root helper changed during this fixture; rerun before deployment');
    await writeFile(new URL('../../../../reports/multi-life-p0-20261006/cost/high-runtime-validation.json',import.meta.url),JSON.stringify({passed:true,observed_at:new Date().toISOString(),
      helper:'supervisor/reasoning.mjs:mountHighTestOverride',helper_sha256:helperHash,actualOfficialAdapter:true,actualNativeAgentLoop:true,defaultOffDidNotOverrideHigh:true,
      twoFixtureOwners:true,exactNativeRPCs:rpcIds,sameSessionRepeatedWireFingerprints:true,ledgerReasoningEffortHigh:true,
      laterHookDowngradeRejectedBeforeReserveAndTransport:true,syntheticModelAttempts:wire.length,paidModelCalls:0,
      cacheCountersSynthetic:true,notRealCacheABEvidence:true,workerProductionStarted:false,realCredentialReads:0},null,2)+'\n');
  } finally {if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}
});

test('legacy budget middleware binds actual option Session to trusted resolver and strips identity extras from attribution',async()=>{
  const sessionId='TEST-legacy-session',agent={session:{id:sessionId,ownEvents:()=>[{type:'user/message',data:{source:{kind:'host-notice',rpcId:'TEST-legacy-rpc'}}},{type:'turn/start',data:{turn:7}}]}};
  const handlers=new Map(),seen=[];
  const service={resolve:(options,actual)=>{assert.equal(options.sessionId,sessionId);assert.equal(actual,agent);return provenanceForAgent(actual,{lifeId:'life-TEST-legacy',role:'activity'});}};
  const ctx={agents:{get:id=>{assert.equal(id,sessionId);return agent;}},get:name=>name==='personaCostIdentity'?service:undefined,
    on:(name,handler)=>handlers.set(name,handler),effect:()=>{}};
  mountBudgetGuard(ctx,{within:async(context,fn)=>{seen.push(context);return fn();},drain:async()=>{}});
  const stream=handlers.get('llm/stream')({sessionId,provider:'deepseek-official',model:'deepseek-flash',requestId:'TEST-untrusted-option-rpc',purpose:'agent-loop'},async function*(){yield {type:'finish',reason:{kind:'stop'}};});
  for await(const _chunk of stream){}
  assert(seen.length>=2);
  for(const context of seen){assert.equal(context.sessionId,sessionId);assert.equal(context.requestId,'TEST-legacy-rpc');
    assert.equal(context.attribution.life_id,'life-TEST-legacy');assert.equal(context.attribution.run_id,sessionId+':turn:7');
    assert.equal(context.attribution.reason,'developer_test');assert(!Object.hasOwn(context.attribution,'request_id'));assert(!Object.hasOwn(context.attribution,'session_id'));}
});
