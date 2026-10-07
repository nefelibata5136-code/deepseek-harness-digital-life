import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../../native_dsh/multi-life/fixture.mjs';
import {LifeRegistry} from '../../native_dsh/multi-life/registry.mjs';
import {bootLifeHost} from '../../native_dsh/multi-life/host.mjs';
import {createOfficialProviderFactory} from '../../native_dsh/multi-life/platform/official-provider.mjs';
import {createMessage} from '../../native_dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import {mountBillingRuntime} from './runtime.mjs';
import {LIFE_IDS} from './cache.mjs';

for(const lifeId of LIFE_IDS)test('official billing prefix and own tools: '+lifeId,async()=>{
  const fixture=await createFixture(['A']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
  const wire=[];let host;
  try {
    const manifest=fixture.manifests[0];manifest.lifeId=lifeId;manifest.deployment.provider='deepseek-official';manifest.deployment.model='deepseek-flash';manifest.deployment.maxTokens=256;registry.register(manifest);
    host=await bootLifeHost({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,providerRoutes:['deepseek-official'],
      memoryBindings:new Map(),ownerBindings:new Map(),admit:async()=>({allowed:true}),
      extensions:[async host=>{host.ctx.get('systemPrompt').section({name:'billing:official-cost',order:3,interpolate:false,text:'TEST OLD DYNAMIC BILLING'});const service=await mountBillingRuntime(host.ctx);let n=0;service.forAgent=()=>({billing:{source:'deepseek_official',today_cost:String(++n),currency:'CNY',last_1h_cost:null,latest_billing_delta:null,official_updated_at:'TEST',expected_lag_minutes:'5-10',data_status:'fresh'}});}],
      budgetConfig:{accounts:new Map([['TEST-account',{dailyLimitNanoCny:50000000000,stopOnUnknownUsage:true}]]),lifeAccounts:new Map([[manifest.lifeId,{accountRef:'TEST-account'}]])},
      providerFactory:createOfficialProviderFactory({credentialForAccount:async()=>'TEST-ONLY-CACHE-PREFIX-KEY-1234567890'}),
      rawModelTransport:async(_url,init)=>{
        wire.push(JSON.parse(init.body));
        return new Response([
          {type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:100,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
          {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
          {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'TEST ONLY'}},
          {type:'content_block_stop',index:0},
          {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
          {type:'message_stop'}].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
      }});
    const agent=await host.runtime.create({lifeId:manifest.lifeId,sessionId:manifest.authoritySessionId,role:'authority'});
    let tick='TEST ONLY CLOCK A';
    const original=agent.buildRequest;
    agent.buildRequest=function(config,preparedCall,tools,position,...rest){
      this.session.append('system/message',{...position,message:createMessage({role:'system',content:[{type:'text',text:tick}],source:{kind:'system-prompt',producer:'TEST-state-board'}})},{surfaceOp:'append'});
      return original.call(this,config,preparedCall,tools,position,...rest);
    };
    for(const value of ['TEST ONLY CLOCK A','TEST ONLY CLOCK B']){
      tick=value;
      await host.runtime.prompt({lifeId:manifest.lifeId,sessionId:agent.session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY CACHE PREFIX'}]});
      await agent.whenIdle();
      assert.equal([...agent.session.ownEvents()].findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
    }
    await host.drainCheckpoints();assert.equal(wire.length,2);
    assert.equal(wire[0].system,wire[1].system);
    assert.match(wire[0].system,/TEST ONLY CORE A/);
    assert(wire[0].messages.some(m=>m.role==='system'&&JSON.stringify(m).includes('[CACHE_HEALTH]')));
    assert(!wire[0].system.includes('[CACHE_HEALTH]'));
    assert(wire[0].tools.some(t=>t.name==='cache_status'));
    assert(wire[0].tools.some(t=>t.name==='billing_details'));
    assert(!wire[0].system.includes('today_cost'));
    assert(!wire[0].system.includes('TEST OLD DYNAMIC BILLING'));
    assert(wire[0].messages.some(m=>JSON.stringify(m).includes('[BILLING]')));
    assert(!JSON.stringify(wire).includes('local_estimated_cost'));
    const budgetTool=host.ctx.tools.get('budget_status',agent);
    const status=await budgetTool.execute({}, {agent});
    assert.equal(status.billing.source,'deepseek_official');
    assert(!JSON.stringify(status).includes('estimated'));
    assert(!budgetTool.description.includes('shared account totals'));
    const details=await host.ctx.tools.get('billing_details',agent).execute({period:'today'}, {agent});
    assert(!JSON.stringify(details).includes(LIFE_IDS.find(id=>id!==lifeId)));
    assert(!JSON.stringify(details).includes('key_id'));
    const observe=host.ctx.tools.get('observe_life',agent);
    const activity=await observe.execute({life_id:lifeId},{agent});
    assert(!('billing' in activity));
    assert(!wire[0].system.includes('TEST ONLY CLOCK A'));
    assert(!wire[1].system.includes('TEST ONLY CLOCK B'));
    assert(wire[1].messages.some(m=>m.role==='system'&&JSON.stringify(m).includes('TEST ONLY CLOCK B')));
    assert.deepEqual(wire[0].messages,wire[1].messages.slice(0,wire[0].messages.length));
  }finally{if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}
});
