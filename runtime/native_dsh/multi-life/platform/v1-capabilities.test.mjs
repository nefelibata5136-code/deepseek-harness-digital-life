import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootLifeHost} from '../host.mjs';
import {createOfficialProviderFactory} from './official-provider.mjs';
import {mountV1Capabilities,projectCapabilities} from './v1-capabilities.mjs';

test('loaded registry and failure facts determine routes; old documentation cannot grant them',()=>{
  const input={names:['read','write','edit','web_fetch','life_delegate'],local:{search_provider_loaded:true},lifeId:'TEST-life',sessionId:'TEST-session'};
  const before=projectCapabilities(input);
  assert.equal(before.capabilities.web_search.status,'unavailable');
  assert.equal(before.capabilities.shell.status,'unavailable');
  const ready=projectCapabilities({...input,names:[...input.names,'terminal','web_search'],failures:{web_search:'HTTP_403'},external:[{id:'dots',enabled:true,state:'error'}]});
  assert.equal(ready.capabilities.web_search.status,'degraded');
  assert.equal(ready.capabilities.web_search.last_failure,'HTTP_403');
  assert.equal(ready.capabilities.slack_dot.status,'unavailable');
  for(const registration of [{id:'dots',enabled:true,state:'error'},{id:'dots',enabled:false,state:'ready'}]){
    const staleWrapper=projectCapabilities({...input,names:[...input.names,'cap__dots__read_dots_result'],external:[registration]});
    assert.equal(staleWrapper.capabilities.slack_dot.status,'unavailable');
    assert.equal(staleWrapper.capabilities.slack_dot.enabled,registration.enabled);
  }
  const lazy=projectCapabilities({...input,names:[...input.names,'delegate_to_dots'],dots:{registered:true,loaded:false,health:'unknown'}});
  assert.equal(lazy.capabilities.slack_dot.status,'available');assert.equal(lazy.capabilities.slack_dot.check_tool,'dots_status');
  const blocked=projectCapabilities({...input,names:[...input.names,'delegate_to_dots'],dots:{registered:true,loaded:true,health:'available',available:false}});
  assert.equal(blocked.capabilities.slack_dot.status,'degraded');
});

test('actual official Adapter preserves Core and history while two owners see live registry changes at the tail',async()=>{
  const fixture=await createFixture(['A','B']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  let host;const wire=[];
  try {
    for(const m of fixture.manifests){m.deployment.provider='deepseek-official';m.deployment.model='deepseek-flash';m.deployment.maxTokens=256;registry.register(m);}
    const accounts=fixture.manifests.map((m,i)=>[m.lifeId,'TEST-account-'+i]);
    host=await bootLifeHost({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,providerRoutes:['deepseek-official'],
      memoryBindings:new Map(),ownerBindings:new Map(),admit:async()=>({allowed:true}),extensions:[async h=>{
        h.ctx.provide('v1LocalNetwork',{status:()=>({search_provider_loaded:true})});
        h.ctx.provide('lifeDots',{peek:c=>{h.contexts.require(c);return {registered:false};}});
        await mountV1Capabilities(h.ctx);
      }],budgetConfig:{accounts:new Map(accounts.map(([,a])=>[a,{dailyLimitNanoCny:50000000000,stopOnUnknownUsage:true}])),
        lifeAccounts:new Map(accounts.map(([l,a])=>[l,{accountRef:a}]))},
      providerFactory:createOfficialProviderFactory({credentialForAccount:async a=>'TEST-ONLY-KEY-'+a+'-1234567890'}),rawModelTransport:async(_url,init)=>{
        wire.push({lifeId:init.headers['x-deepseek-harness-user-id'],body:JSON.parse(init.body)});
        return new Response([
          {type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:100,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
          {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
          {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'TEST ONLY CAPABILITY SNAPSHOT'}},
          {type:'content_block_stop',index:0},
          {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
          {type:'message_stop'}].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
      }});
    const agents=[];
    for(const m of fixture.manifests)agents.push(await host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'}));
    const output={schema:{type:'json'},render:(_args,v)=>[{type:'text',text:JSON.stringify(v)}]};
    let terminalResult={returncode:1};
    const withdraw=agents[0].ctx.tools.register(defineTool({name:'terminal',description:'TEST ONLY synthetic registered command tool, no shell',parameters:{},output,execute:()=>terminalResult}));
    for(const a of agents){const s=host.ctx.get('v1CapabilitySnapshot').forAgent(a);assert.equal(s.life_id,registry.owner(a.session.id).lifeId);}
    assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.shell.status,'direct');
    assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[1]).capabilities.shell.status,'unavailable');
    const exec=()=>host.ctx.tools.execute({name:'terminal',arguments:{},agent:agents[0],callId:randomUUID(),signal:new AbortController().signal});
    await exec();assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.shell.status,'direct');
    terminalResult={available:false};await exec();assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.shell.status,'degraded');
    terminalResult={returncode:0};await exec();assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.shell.status,'direct');
    const unguard=host.ctx.tools.guard(exec=>exec.name==='terminal'?'TEST_GUARD_REFUSAL':undefined);
    const refused=await exec();assert.equal(refused.isError,true);assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.shell.status,'degraded');
    unguard();await exec();assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.shell.status,'direct');
    let searchResult={ok:true},fetchResult={status:403};
    agents[0].ctx.tools.register(defineTool({name:'web_search',description:'TEST ONLY search provider result',parameters:{},output,execute:()=>searchResult}));
    agents[0].ctx.tools.register(defineTool({name:'web_fetch',description:'TEST ONLY independent target response',parameters:{},output,execute:()=>fetchResult}));
    const webExec=name=>host.ctx.tools.execute({name,arguments:{},agent:agents[0],callId:randomUUID(),signal:new AbortController().signal});
    await webExec('web_fetch');assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.web_search.status,'available');
    searchResult={ok:false,code:'TEST_SEARCH_FAILED'};await webExec('web_search');
    fetchResult={status:200};await webExec('web_fetch');assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.web_search.status,'degraded');
    searchResult={ok:true};await webExec('web_search');assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.web_search.status,'available');
    for(let round=0;round<2;round++)for(const a of agents){
      await host.runtime.prompt({lifeId:registry.owner(a.session.id).lifeId,sessionId:a.session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY snapshot prefix'}]});
      await a.whenIdle();assert.equal([...a.session.ownEvents()].findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
    }
    for(const m of fixture.manifests){const bodies=wire.filter(r=>r.lifeId===m.lifeId).map(r=>r.body);assert.equal(bodies.length,2);
      assert.equal(bodies[0].system,bodies[1].system);assert.match(bodies[0].system,/TEST ONLY CORE/);
      assert(!bodies[0].system.includes('[CAPABILITIES]'));assert(bodies[0].messages.some(x=>JSON.stringify(x).includes('[CAPABILITIES]')));
      assert.deepEqual(bodies[0].messages,bodies[1].messages.slice(0,bodies[0].messages.length));
      assert.deepEqual(bodies[0].tools,bodies[1].tools);
    }
    withdraw();assert.equal(host.ctx.get('v1CapabilitySnapshot').forAgent(agents[0]).capabilities.shell.status,'unavailable');
    await host.drainCheckpoints();
  }finally{if(host){await host.ctx.fiber.dispose();host.rooms?.recentEvents?.store?.close();}registry.close();await fixture.cleanup();}
});
