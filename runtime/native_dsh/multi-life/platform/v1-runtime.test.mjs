import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt';
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools';
import {createScope} from '@deepseek-ai/dsh-scope';
import {LlmRuntime,createMessage} from '@deepseek-ai/dsh-llm';
import {DeepSeekAdapter,resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {mountV1Runtime,reconcileLegacyDots} from './v1-runtime.mjs';
import {DOTS_SPECS} from './dots-capability.mjs';

const rawNames=DOTS_SPECS.map(([name])=>name);
const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture({bus=true,raw=true}={}){
  const ctx=new Context(),agents=[],scopes=[],owners=new WeakMap(),bodies=new Map();
  new SystemPrompt(ctx,{includeHarnessIdentity:false});new ToolRuntime(ctx,{mode:'native'});
  ctx.provide('agents',{list:()=>agents});
  ctx.provide('multiLifeContexts',{forAgent:agent=>{
    const owner=owners.get(agent);if(!owner)throw Error('TEST_UNBOUND_AGENT');return owner;
  }});
  if(bus)ctx.provide('personaCapabilities',{source:'TEST ONLY existing legacy capability bus'});
  const register=(scope,name,description)=>scope.tools.register(defineTool({name,description,parameters:{},output,
    execute:()=>{bodies.set(name,(bodies.get(name)??0)+1);return {name,test_only:true};}}));
  register(ctx,'unrelated_before','TEST ONLY existing unrelated tool before Dot');
  if(raw)for(const [name,description] of DOTS_SPECS)register(ctx,name,description);
  register(ctx,'cap__dots__read_dots_result','TEST ONLY existing lazy Dot bus wrapper');
  register(ctx,'capability_search','TEST ONLY existing bus discovery');
  register(ctx,'unrelated_after','TEST ONLY existing unrelated tool after Dot');
  const create=(kind,{bound=true}={})=>{
    const agent={test_only:true,session:{id:randomUUID()}};
    const scope=createScope(ctx,agent);agent.ctx=scope.ctx;scopes.push(scope);agents.push(agent);
    if(bound)owners.set(agent,{manifest:{kind}});return agent;
  };
  const execute=(agent,name)=>ctx.tools.execute({agent,name,arguments:{},callId:randomUUID(),signal:new AbortController().signal});
  const names=agent=>ctx.tools.schemas(agent).map(schema=>schema.name);
  return {ctx,agents,bodies,register,create,execute,names,async close(){for(const scope of scopes)await scope.dispose();await ctx.fiber.dispose();}};
}

test('legacy inherited raw Dot globals disappear and cannot dispatch; existing bus and modern peers keep their order',async()=>{
  const f=fixture();try{
    const legacy=f.create('legacy'),modern=f.create('native');
    const before=f.ctx.tools.schemas(legacy),survivors=before.filter(schema=>!rawNames.includes(schema.name));
    assert.throws(()=>f.ctx.tools.restrict({deny:rawNames}),/requires a scoped context/);
    reconcileLegacyDots(f.ctx);
    assert.deepEqual(f.ctx.tools.schemas(legacy),survivors);
    assert.deepEqual(f.ctx.tools.schemas(modern),before);
    assert.deepEqual(f.ctx.tools.schemas(),before);
    for(const name of rawNames){
      assert.equal(f.ctx.tools.get(name,legacy),undefined);
      const denied=await f.execute(legacy,name);
      assert.equal(denied.isError,true);assert.equal(denied.error.info.code,'UNKNOWN_TOOL');
      assert.equal(f.bodies.get(name)??0,0,'masked body must never run');
      assert.equal((await f.execute(modern,name)).isError,false,'modern route stays callable');
      assert.equal(f.bodies.get(name),1);
    }
    for(const name of ['cap__dots__read_dots_result','capability_search','unrelated_before','unrelated_after']){
      assert.equal((await f.execute(legacy,name)).isError,false,name+' must keep dispatching');
    }
  }finally{await f.close();}
});

test('legacy reconciliation is idempotent and masks future trusted legacy agents only',async()=>{
  const f=fixture();try{
    const first=f.create('legacy');let changes=0;f.ctx.on('tools/change',()=>changes++);
    const service=reconcileLegacyDots(f.ctx),after=changes;
    assert(after>0);assert.equal(reconcileLegacyDots(f.ctx),service);assert.equal(changes,after);
    const later=f.create('legacy'),modern=f.create('native'),unknown=f.create('legacy',{bound:false});
    for(const agent of [later,modern,unknown])f.ctx.emit('agent/created',{agent});
    assert.deepEqual(f.names(later),f.names(first));
    assert(rawNames.every(name=>f.names(modern).includes(name)));
    assert(rawNames.every(name=>f.names(unknown).includes(name)));
    const finalChanges=changes;f.ctx.emit('agent/created',{agent:later});assert.equal(changes,finalChanges);
  }finally{await f.close();}
});

test('without a legacy bus there is no mask, even when a trusted owner is marked legacy',async()=>{
  const f=fixture({bus:false});try{
    const legacy=f.create('legacy'),modern=f.create('native'),before=f.ctx.tools.schemas(legacy);
    assert.equal(reconcileLegacyDots(f.ctx),null);
    assert.deepEqual(f.ctx.tools.schemas(legacy),before);assert.deepEqual(f.ctx.tools.schemas(modern),before);
    assert.equal((await f.execute(legacy,'dots_status')).isError,false);
    assert.equal((await f.execute(modern,'dots_status')).isError,false);
  }finally{await f.close();}
});

test('a real pending Cordis provider retains the legacy bus route and never constructs modern Dot bindings',async()=>{
  const f=fixture({bus:false,raw:false});let release,provider;
  const barrier=new Promise(resolve=>{release=resolve;});
  let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});
  try{
    const legacy=f.create('legacy'),modern=f.create('native');
    const before=f.ctx.tools.schemas(legacy),modernBefore=f.ctx.tools.schemas(modern);
    const contexts=f.ctx.get('multiLifeContexts');
    contexts.registry={mode:'production',list:()=>{throw Error('TEST_MODERN_DOT_BINDINGS_MUST_NOT_BE_CONSTRUCTED');}};
    // Existing composed services keep this test local. The guard and scoped
    // registry are real; no Slack bridge, secret resolution or provider is run.
    f.ctx.provide('digitalLifeLocalNetwork',{test_only:'already composed local service'});
    f.ctx.provide('v1CapabilitySnapshot',{test_only:'already composed snapshot service'});
    provider=f.ctx.plugin(async child=>{
      child.provide('personaCapabilities',{test_only:'already provided legacy bus'});
      enteredResolve(child);await barrier;
    });
    const child=await entered;
    assert.equal(provider.state,1,'providing fiber remains pending, before active state 2');
    assert.equal(child.get('personaCapabilities'),undefined,'strict lookup intentionally hides pending provider');
    assert.equal(child.get('personaCapabilities',false).test_only,'already provided legacy bus');
    const service=await mountV1Runtime(child);
    assert.equal(service.dots,undefined,'composition must keep the existing legacy bus');
    assert.equal(child.get('lifeDots',false),undefined,'modern Dot service was never constructed');
    assert.equal(child.get('v1LegacyDotsView',false).route,'existing capability bus');
    assert.deepEqual(f.ctx.tools.schemas(legacy),before);
    assert.deepEqual(f.ctx.tools.schemas(modern),modernBefore);
    assert.equal((await f.execute(legacy,'cap__dots__read_dots_result')).isError,false);
  }finally{
    release();if(provider)while(provider.inertia)await provider.inertia;
    await f.close();
  }
});

test('absent global definitions are a no-op and another author scoped definition remains callable',async()=>{
  const f=fixture({raw:false});try{
    const legacy=f.create('legacy');
    // Same name and description are insufficient proof of global ownership.
    f.register(legacy.ctx,DOTS_SPECS[0][0],DOTS_SPECS[0][1]);
    const before=f.ctx.tools.schemas(legacy);let changes=0;f.ctx.on('tools/change',()=>changes++);
    assert.doesNotThrow(()=>reconcileLegacyDots(f.ctx));
    assert.deepEqual(f.ctx.tools.schemas(legacy),before);assert.equal(changes,0);
    assert.equal((await f.execute(legacy,'dots_status')).isError,false);
  }finally{await f.close();}
});

test('exact description matching preserves unrelated global names and agent-owned shadow tools',async()=>{
  const f=fixture({raw:false});try{
    const legacy=f.create('legacy'),modern=f.create('native');
    f.register(f.ctx,'dots_status','TEST ONLY another author global definition');
    for(const [name,description] of DOTS_SPECS.slice(1))f.register(f.ctx,name,description);
    f.register(legacy.ctx,'read_dots_result',DOTS_SPECS.find(([name])=>name==='read_dots_result')[1]);
    reconcileLegacyDots(f.ctx);
    assert(f.names(legacy).includes('dots_status'));assert(f.names(legacy).includes('read_dots_result'));
    assert.equal((await f.execute(legacy,'dots_status')).isError,false);
    assert.equal((await f.execute(legacy,'read_dots_result')).isError,false);
    const denied=await f.execute(legacy,'delegate_to_dots');assert.equal(denied.error.info.code,'UNKNOWN_TOOL');
    assert.equal((await f.execute(modern,'delegate_to_dots')).isError,false);
  }finally{await f.close();}
});

test('actual official Adapter emits a next masked request with static Core and existing history preserved',async t=>{
  const f=fixture(),originalFetch=globalThis.fetch,wires=[];try{
    const legacy=f.create('legacy'),runtime=new LlmRuntime(f.ctx);
    const connection=resolveAdapterOptions({baseURL:'https://api.deepseek.com/anthropic',thinking:'disabled',maxTokens:256,
      models:[{id:'deepseek-flash',name:'TEST',contextWindow:1000000,maxTokens:256,systemPromptUpdate:'in-history',toolUpdate:'addition-only'}],retryPolicy:{mode:'normal',maxRetries:0}});
    runtime.registerAdapter(['deepseek-official'],new DeepSeekAdapter({options:()=>connection,
      resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'TEST-ONLY-LEGACY-DOT-MASK',
      prepareExtensions:async()=>({fields:{},accept:async()=>{}})}));
    globalThis.fetch=async(_url,init)=>{
      wires.push(JSON.parse(init.body));
      return new Response([
        {type:'message_start',message:{id:'TEST-'+randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'TEST ONLY'}},
        {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}]
        .map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
    };
    const msg=(role,text)=>createMessage({role,content:[{type:'text',text}]});
    const history=[msg('user','TEST ONLY first request'),msg('system','TEST ONLY appended clock A')];
    const options={provider:'deepseek-official',model:'deepseek-flash',sessionId:legacy.session.id,maxTokens:256,system:'TEST ONLY STATIC CORE'};
    const before=f.ctx.tools.schemas(legacy),first=[];
    for await(const chunk of runtime.stream({...options,tools:before,messages:history}))first.push(chunk);
    reconcileLegacyDots(f.ctx);const live=f.ctx.tools.schemas(legacy);
    const answer=createMessage({role:'assistant',content:[{type:'text',text:'TEST ONLY'}],
      source:{kind:'model',provider:'deepseek-official',model:'deepseek-flash',replayState:first.find(chunk=>chunk.type==='finish')?.replayState}});
    const next=[];
    for await(const chunk of runtime.stream({...options,tools:live,messages:[...history,answer,msg('user','TEST ONLY next request'),msg('system','TEST ONLY appended clock B')]}))next.push(chunk);
    assert(![...first,...next].some(chunk=>chunk.type==='finish'&&chunk.reason?.kind==='error'));
    assert.equal(wires.length,2);assert.equal(wires[0].system,options.system);assert.equal(wires[1].system,wires[0].system);
    assert.deepEqual(wires[0].messages,wires[1].messages.slice(0,wires[0].messages.length));
    assert.deepEqual(live,before.filter(schema=>!rawNames.includes(schema.name)));
    const wireBefore=wires[0].tools.map(tool=>tool.name),wireAfter=wires[1].tools.map(tool=>tool.name);
    const removed=wireBefore.filter(name=>!wireAfter.includes(name));
    assert.deepEqual(removed.length?removed:[],removed.length?rawNames:[]);
    assert.equal(wireAfter.filter(name=>!wireBefore.includes(name)).length,0);
    if(!removed.length)assert.deepEqual(wires[1].tools,wires[0].tools);
    else assert.deepEqual(wires[1].tools,wires[0].tools.filter(tool=>!rawNames.includes(tool.name)));
    t.diagnostic(JSON.stringify({official_adapter:true,local_sse:true,external_calls:0,
      core_hashes:wires.map(body=>sha(body.system)),existing_message_prefix_preserved:true,
      live_schema_removed:rawNames,wire_tools_removed:removed,wire_retains_historical_declarations:removed.length===0,
      tools_hashes:wires.map(body=>sha(body.tools)),cache_scope:removed.length?'Expected one legacy tools declaration change; static Core and existing messages unchanged':'Wire retains tool history; mask still prevents legacy dispatch. No cache invalidation claim from schema alone.'}));
  }finally{globalThis.fetch=originalFetch;await f.close();}
});
