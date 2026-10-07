import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {BudgetAuthority} from '../budget/index.mjs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import {LlmRuntime,createMessage} from '@deepseek-ai/dsh-llm';
import {DeepSeekAdapter,resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {createBudgetGate,pythonAuthority} from '../../../budget_guard/provider_gate.mjs';
import {mountLocalNetwork} from './local-network.mjs';
import {createOfficialSearchProvider,dispatchOfficialSearch,hasOfficialSearchContext} from './official-search.mjs';

test('actual official tool/provider, concurrent owners, real ledgers, native results, cancellation and no local fallback',async()=>{
  const f=await createFixture(['OFFICIAL-SEARCH-A','OFFICIAL-SEARCH-B']);
  const registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'}),original=globalThis.fetch;
  const keys=new Map(f.manifests.map((m,i)=>[m.lifeId,'TEST-ONLY-SEARCH-KEY-'+i]));
  let host,mode='good';const wires=[];
  try {
    for(const m of f.manifests)registry.register(m);
    host=await bootScoped({registry,root:f.nativeRoot,fixtureRoot:f.root,
      extensions:[async h=>mountLocalNetwork(h.ctx,{searchProvider:createOfficialSearchProvider(h.ctx,{resolveKey:async c=>keys.get(c.lifeId)}),terminal:false})]});
    host.budget=new BudgetAuthority({contexts:host.contexts,root:resolve(f.registryRoot,'budget'),budgetLimitsEnabled:false,
        accounts:new Map(f.manifests.map(m=>[m.lifeId,{dailyLimitNanoCny:50000000000,stopOnUnknownUsage:false}])),
        lifeAccounts:new Map(f.manifests.map(m=>[m.lifeId,{accountRef:m.lifeId}]))});
    globalThis.fetch=async(input,init)=>{
      assert(hasOfficialSearchContext());
      return dispatchOfficialSearch(input,init,{rpc:(c,op,args)=>host.budget.execute(c,op,args),transport:async(url,options)=>{
        const body=JSON.parse(options.body);assert.equal(url,'https://api.deepseek.com/anthropic/v1/messages');
        assert.equal(body.tools[0].type,'web_search_20250305');assert.equal(body.model,'deepseek-flash');
        assert.equal(body.max_tokens,4095);assert(!('system' in body));assert.equal(body.messages.length,1);
        assert.equal(options.headers.authorization,'Bearer '+options.headers['x-api-key']);
        wires.push({key:options.headers['x-api-key'],body});
        if(mode==='transport')throw Error('TEST ONLY transport failure');
        await new Promise(done=>setTimeout(done,10));
        return Response.json({id:'TEST-SEARCH-'+randomUUID(),usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0},
          content:mode==='missing-block'?[]:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.com/official',title:'TEST ONLY Official result'}]},
            {type:'text',text:'TEST ONLY untrusted generated answer',citations:[{url:'https://example.com/official',cited_text:'TEST ONLY native citation'}]}]});
      }});
    };
    const agents=await Promise.all(f.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    const call=(agent,signal=new AbortController().signal)=>host.ctx.tools.execute({agent,name:'web_search',arguments:{queries:['TEST ONLY official search']},callId:randomUUID(),signal});
    const results=await Promise.all(agents.map(agent=>call(agent)));
    for(const result of results){assert.equal(result.isError,false,JSON.stringify(result));assert.match(JSON.stringify(result),/example.com\/official/);assert(!JSON.stringify(result).includes('untrusted generated answer'));}
    assert.deepEqual(new Set(wires.map(w=>w.key)),new Set(keys.values()));
    for(const m of f.manifests){const account=await host.budget.inspectAccount(m.lifeId);assert.equal(account.account.open_attempts,0);assert.equal(account.account.budget_limits_enabled,false);}
    const stable=JSON.stringify(host.ctx.tools.schemas(agents[0]));await call(agents[0]);assert.equal(JSON.stringify(host.ctx.tools.schemas(agents[0])),stable);
    mode='missing-block';const missing=await call(agents[0]);assert.equal(missing.isError,true);assert.match(JSON.stringify(missing),/no web_search_tool_result/);
    mode='transport';assert.equal((await call(agents[1])).isError,true);const unknown=await host.budget.inspectAccount(f.manifests[1].lifeId);assert.equal(unknown.account.unknown_attempts,1);
    const before=wires.length,controller=new AbortController();controller.abort();assert.equal((await call(agents[0],controller.signal)).isError,true);assert.equal(wires.length,before);
    assert.equal(host.ctx.get('digitalLifeLocalNetwork').status(agents[0]).search.provider_id,'deepseek-official');
    assert.equal(host.ctx.get('digitalLifeLocalNetwork').status(agents[0]).search.local_script_enabled,false);
    assert.equal(host.ctx.web.searchProviders.size,1);
    await assert.rejects(dispatchOfficialSearch('https://api.deepseek.com/anthropic/v1/messages',{}),/SEARCH_TRUSTED_CONTEXT_REQUIRED/);
  }finally{globalThis.fetch=original;await host?.ctx.fiber.dispose();registry.close();await f.cleanup();}
});

test('legacy protected gate accounts official nonstream search and still rejects ordinary server-tool calls',async()=>{
  const f=await createFixture(['OFFICIAL-SEARCH-LEGACY']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'}),original=globalThis.fetch;
  let host;try{
    const m=f.manifests[0];registry.register(m);
    host=await bootScoped({registry,root:f.nativeRoot,fixtureRoot:f.root,extensions:[async h=>mountLocalNetwork(h.ctx,{
      searchProvider:createOfficialSearchProvider(h.ctx,{resolveKey:async()=> 'TEST-ONLY-LEGACY-SEARCH-KEY'}),terminal:false})]});
    const rpc=pythonAuthority({python:'python',db:resolve(f.root,'search-budget.sqlite3')});
    const initialized=spawnSync('python',
      ['-c','from authority import Authority; import sys; Authority(sys.argv[1]).initialize()',resolve(f.root,'search-budget.sqlite3')],
      {cwd:fileURLToPath(new URL('../../../budget_guard',import.meta.url)),windowsHide:true,encoding:'utf8'});
    assert.equal(initialized.status,0,initialized.stderr);
    let sent=0;
    globalThis.fetch=createBudgetGate({rpc,transport:async()=>{sent++;return Response.json({id:'TEST-LEGACY-'+randomUUID(),
      usage:{input_tokens:9,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0},
      content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.com/legacy-official'}]}]});}}).fetch;
    const agent=await host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'});
    const result=await host.ctx.tools.execute({agent,name:'web_search',arguments:{queries:['TEST ONLY legacy native search']},callId:randomUUID(),signal:new AbortController().signal});
    assert.equal(result.isError,false,JSON.stringify(result));assert.equal(sent,1);
    const status=await rpc('status');assert.equal(status.open_attempts,0);assert.equal(status.unknown_attempts,0);
    const attribution=spawnSync('python',
      ['-c','import sqlite3,sys,json; from pathlib import Path; c=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True); print(json.dumps(c.execute("SELECT life_id FROM request_attribution").fetchall()))',resolve(f.root,'search-budget.sqlite3')],
      {windowsHide:true,encoding:'utf8'});
    assert.equal(attribution.status,0);assert.deepEqual(JSON.parse(attribution.stdout),[[m.lifeId]]);
    await host.ctx.sessions.flush(agent.session);
    assert([...agent.session.ownEvents()].filter(e=>e.type.startsWith('web/')).every(e=>e.type==='web/deepseek-search-llm-request'));
    await assert.rejects(fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash',tools:[{type:'web_search_20250305',name:'web_search'}]})}),/unprotected_call_context/);
    assert.equal(sent,1);
  }finally{globalThis.fetch=original;await host?.ctx.fiber.dispose();registry.close();await f.cleanup();}
});

test('actual official Adapter wire retains static Core, tools and earlier history across dynamic state updates',async()=>{
  const ctx=new Context(),runtime=new LlmRuntime(ctx),original=globalThis.fetch,wires=[];
  try{
    const connection=resolveAdapterOptions({baseURL:'https://api.deepseek.com/anthropic',thinking:'disabled',maxTokens:256,
      models:[{id:'deepseek-flash',name:'TEST',contextWindow:1000000,maxTokens:256,systemPromptUpdate:'in-history',toolUpdate:'addition-only'}],retryPolicy:{mode:'normal',maxRetries:0}});
    const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'TEST-ONLY',prepareExtensions:async()=>({fields:{},accept:async()=>{}})});
    runtime.registerAdapter(['deepseek-official'],adapter);
    globalThis.fetch=async(_url,init)=>{
      wires.push(JSON.parse(init.body));
      return new Response([{type:'message_start',message:{id:'TEST-'+randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'TEST'}},
        {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}]
        .map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
    };
    const msg=(role,text)=>createMessage({role,content:[{type:'text',text}]});
    const history=[msg('user','TEST first query'),msg('system','TEST clock A')];
    const tools=[{name:'web_search',description:'TEST official search',parameters:{type:'object',properties:{queries:{type:'array',items:{type:'string'}}},required:['queries']}}];
    const options={provider:'deepseek-official',model:'deepseek-flash',sessionId:'TEST-ONLY-PREFIX',maxTokens:256,system:'TEST STATIC CORE',tools};
    const chunks=[];
    for await(const chunk of runtime.stream({...options,messages:history}))chunks.push(chunk);
    const answer=createMessage({role:'assistant',content:[{type:'text',text:'TEST'}],
      source:{kind:'model',provider:'deepseek-official',model:'deepseek-flash',replayState:chunks.find(c=>c.type==='finish')?.replayState}});
    for await(const chunk of runtime.stream({...options,messages:[...history,answer,msg('user','TEST next query'),msg('system','TEST clock B')]}))chunks.push(chunk);
    assert(!chunks.some(c=>c.type==='finish'&&c.reason?.kind==='error'),JSON.stringify(chunks.filter(c=>c.type==='finish')));
    assert.equal(wires.length,2);assert.equal(wires[0].system,'TEST STATIC CORE');assert.equal(wires[0].system,wires[1].system);
    assert.deepEqual(wires[0].tools,wires[1].tools);assert.deepEqual(wires[0].messages,wires[1].messages.slice(0,wires[0].messages.length));
    assert(!wires[1].system.includes('clock'));assert.match(JSON.stringify(wires[1].messages.at(-1)),/clock B/);
  }finally{globalThis.fetch=original;await ctx.fiber.dispose();}
});
