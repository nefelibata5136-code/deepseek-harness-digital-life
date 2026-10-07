import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createBudgetGate as actualBudgetGate, pythonAuthority, mountBudgetGuard, inject as budgetInject } from './provider_gate.mjs';
import { DeepSeekAdapter, resolveAdapterOptions } from '../native_dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js';
import { Context } from '../native_dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { LlmRuntime, createUserMessage } from '../native_dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';

const HERE = fileURLToPath(new URL('.',import.meta.url));
// Offline provider fixtures must not publish incidents to the live recovery queue.
const createBudgetGate = options => actualBudgetGate({...options,diagnostic:async record=>({...record,id:'offline-fixture'})});
const PYTHON = process.env.BUDGET_TEST_PYTHON || 'python';
const API_URL = 'https://api.deepseek.com/anthropic/v1/messages';
const context = purpose => ({ provider:'deepseek-official',model:'deepseek-flash',sessionId:'fake-session',requestId:'fake-request',purpose });
const wire = (max_tokens=16384) => ({ method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens,messages:[{role:'user',content:'offline'}]}) });
const usage = { input_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:10 };
function sse(u=usage,{missing=false,duplicate=false}={}) {
  const events = [
    {type:'message_start',message:{id:'fake-provider-id',type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{...u,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'offline fake answer'}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:u.output_tokens}},
    ...duplicate ? [{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:u.output_tokens}}] : [],
    ...missing ? [] : [{type:'message_stop'}],
  ];
  return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),
    {headers:{'content-type':'text/event-stream','request-id':'fake-provider-id'}});
}
async function fixture(t, {limit, conservative, stopUnknown=true}={}) {
  const temp=await mkdtemp(join(tmpdir(),'persona-budget-D-'));
  const db=join(temp,'budget.db');
  t.after(async()=>{
    assert.ok(resolve(temp).startsWith(resolve(tmpdir())+'\\') || resolve(temp).startsWith(resolve(tmpdir())+'/'));
    await rm(temp,{recursive:true,force:true});
  });
  const config=JSON.parse(await readFile(join(HERE,'config.json'),'utf8'));
  // A fixed fixture budget, independent of the user's live daily allowance.
  delete config.daily_limit_suspended_on;
  config.budget_limits_enabled=true;
  config.daily_limit_nano_cny=10000000000;
  config.stop_on_unknown_usage=stopUnknown;
  if(limit) config.daily_limit_nano_cny=limit;
  config.warning_nano_cny=Math.min(config.warning_nano_cny,config.daily_limit_nano_cny);
  config.conservative_nano_cny=Math.min(config.conservative_nano_cny,config.daily_limit_nano_cny);
  if(conservative) {config.warning_nano_cny=1;config.conservative_nano_cny=2;}
  // Tests with custom config use a tiny offline Python worker, no shell.
  const source="import json,sys; from authority import Authority; a=Authority(sys.argv[1],json.loads(sys.argv[2])); op=sys.argv[3]; args=json.load(sys.stdin); print(json.dumps(a.initialize() if op=='init' else a.status() if op=='status' else a.unknown(args['attempt_id']) if op=='unknown' else getattr(a,op)(args)))";
  const calls=[];
  const rpc=async(op,args={})=>{
    calls.push({operation:op,...op==='reserve'?{attempt_id:args.attempt_id,purpose:args.purpose}: {}});
    const result=spawnSync(PYTHON,['-c',source,db,JSON.stringify(config),op],
      {cwd:HERE,input:JSON.stringify(args),encoding:'utf8',windowsHide:true});
    if(result.status!==0) throw new Error('offline-authority-denied');
    return JSON.parse(result.stdout);
  };
  await rpc('init');
  const asyncRpc=(op,args={})=>new Promise((accept,reject)=>{
    const child=spawn(PYTHON,['-c',source,db,JSON.stringify(config),op],{cwd:HERE,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',data=>output+=data);child.stderr.resume();
    child.on('error',reject);child.on('close',code=>{try{if(code!==0)throw new Error('offline-authority-denied');accept(JSON.parse(output));}catch(e){reject(e);}});
    child.stdin.end(JSON.stringify(args));
  });
  return {rpc,asyncRpc,db,calls};
}

test('budget denial reaches no fake provider; output cap is actual wire bytes',async t=>{
  const f=await fixture(t,{limit:2120000000});
  const received=[];
  const gate=createBudgetGate({rpc:f.rpc,transport:async(_url,init)=>{received.push(JSON.parse(init.body));return sse(usage,{missing:true});}});
  const response=await gate.within(context('dialogue'),()=>gate.fetch(API_URL,wire()));
  assert.equal(received[0].max_tokens,2855);
  await assert.rejects(response.text());
  await assert.rejects(gate.within(context('retry'),()=>gate.fetch(API_URL,wire())));
  assert.equal(received.length,1);
  const status=await f.rpc('status');
  assert.equal(status.unknown_attempts,1);
  assert.equal(status.unsettled_reservations,2120000000);
});

test('eight concurrent fetches share durable admission, four rejected before send',async t=>{
  const f=await fixture(t);
  let received=0;
  const rpc=f.asyncRpc;
  const gate=createBudgetGate({rpc,transport:async()=>{received++;return sse();}});
  const tasks=Array.from({length:8},()=>gate.within(context('subagent'),async()=>{
    try { return await gate.fetch(API_URL,wire()); } catch {return null;}
  }));
  // Real asynchronous Python processes contend for BEGIN IMMEDIATE. Bodies
  // remain unread until every contender finishes admission, so none settles early.
  const results=await Promise.all(tasks);
  assert.equal(received,4);
  assert.equal(results.filter(Boolean).length,4);
  assert.ok((await rpc('status')).unsettled_reservations<=10000000000);
  await Promise.all(results.filter(Boolean).map(response=>response.text()));
  assert.equal((await rpc('status')).settled,1120000);
});

test('initial insufficient budget sends exactly zero provider requests',async t=>{
  const f=await fixture(t,{limit:1500000000});let received=0;
  const gate=createBudgetGate({rpc:f.rpc,transport:async()=>{received++;return sse();}});
  await assert.rejects(gate.within(context('dialogue'),()=>gate.fetch(API_URL,wire())));
  assert.equal(received,0);
  assert.equal((await f.rpc('status')).open_attempts,0);
});

test('cache usage and duplicate cumulative frames settle once',async t=>{
  const f=await fixture(t);
  const gate=createBudgetGate({rpc:f.rpc,transport:async()=>sse({...usage,input_tokens:0,cache_read_input_tokens:100},{duplicate:true})});
  await (await gate.within(context('dialogue'),()=>gate.fetch(API_URL,wire()))).text();
  assert.equal((await f.rpc('status')).settled,84000);
  assert.equal(f.calls.filter(c=>c.operation==='settle').length,1);
});

test('timeout and HTTP errors retain and halt automatic retry',async t=>{
  for(const transport of [async()=>{throw new Error('timeout');},async()=>new Response('fake error',{status:429})]) {
    const f=await fixture(t);let received=0;
    const gate=createBudgetGate({rpc:f.rpc,transport:async(...a)=>{received++;return transport(...a);}});
    await assert.rejects(gate.within(context('first'),()=>gate.fetch(API_URL,wire())));
    await assert.rejects(gate.within(context('retry'),()=>gate.fetch(API_URL,wire())));
    assert.equal(received,1);
    assert.equal((await f.rpc('status')).unknown_attempts,1);
  }
});

test('abort/cancel retains usage reservation',async t=>{
  const f=await fixture(t);
  const gate=createBudgetGate({rpc:f.rpc,transport:async()=>sse()});
  const response=await gate.within(context('dialogue'),()=>gate.fetch(API_URL,wire()));
  await response.body.cancel();
  assert.equal((await f.rpc('status')).unknown_attempts,1);
});

test('accounting outage after send blocks further wire attempts in same process',async t=>{
  const f=await fixture(t);let received=0;
  const rpc=async(op,args)=>{if(op==='unknown')throw new Error('fake accounting outage');return f.rpc(op,args);};
  const gate=createBudgetGate({rpc,transport:async()=>{received++;throw new Error('timeout');}});
  await assert.rejects(gate.within(context('dialogue'),()=>gate.fetch(API_URL,wire())));
  await assert.rejects(gate.within(context('retry'),()=>gate.fetch(API_URL,wire())));
  assert.equal(received,1);
  assert.ok((await f.rpc('status')).unsettled_reservations>0);
});

test('incomplete cache counters never become zero usage',async t=>{
  const f=await fixture(t);const incomplete={input_tokens:100,output_tokens:10};
  const gate=createBudgetGate({rpc:f.rpc,transport:async()=>sse(incomplete)});
  const response=await gate.within(context('dialogue'),()=>gate.fetch(API_URL,wire()));
  await assert.rejects(response.text());
  assert.equal((await f.rpc('status')).settled,0);
  assert.ok((await f.rpc('status')).unsettled_reservations>0);
});

test('unknown endpoint, direct calls, other model fail before provider',async t=>{
  const f=await fixture(t);let received=0;
  const gate=createBudgetGate({rpc:f.rpc,transport:async()=>{received++;return sse();}});
  await assert.rejects(gate.fetch(API_URL,wire()));
  await assert.rejects(gate.within(context('direct'),()=>gate.fetch('https://api.deepseek.com/chat/completions',wire())));
  const other=wire();other.body=other.body.replace('deepseek-flash','deepseek-v4-pro');
  await assert.rejects(gate.within(context('direct'),()=>gate.fetch(API_URL,other)));
  const extension=wire();extension.body=JSON.stringify({...JSON.parse(extension.body),n:2});
  await assert.rejects(gate.within(context('direct'),()=>gate.fetch(API_URL,extension)));
  assert.equal(received,0);
});

test('Cordis plugin child declares agents for trusted exact Session attribution',async t=>{
  const ctx=new Context(),sessionId='TEST-exact-session',agent={session:{id:sessionId}},scopes=[];
  // Production agents is owned by a separate plugin, not the unrestricted
  // root Context. A root-provided service would hide the missing injection.
  await ctx.plugin({name:'TEST-native-agents-provider',apply:child=>child.provide('agents',{get:id=>{assert.equal(id,sessionId);return agent;}})});
  ctx.provide('personaCostIdentity',{resolve:(options,actualAgent)=>{
    assert.equal(options.sessionId,sessionId);assert.equal(actualAgent,agent);
    return {life_id:'life-TEST-trusted',run_id:'TEST-native-turn',request_id:'TEST-native-rpc',reason:'developer_test',source_kind:'developer-test',provenance:'trusted_native_source'};
  }});
  const gate={within:async(scope,fn)=>{scopes.push(scope);return fn();},drain:async()=>{}};
  const options={provider:'deepseek-official',model:'deepseek-flash',sessionId,requestId:'TEST-options-rpc'};
  const consume=async()=>{const chunks=[];for await(const chunk of ctx.waterfall('llm/stream',options,()=> (async function*(){yield {type:'TEST-local-only'};})()))chunks.push(chunk);return chunks;};
  const missing=await ctx.plugin({name:'TEST-undeclared-budget-child',inject:[],apply:child=>mountBudgetGuard(child,gate)});
  await assert.rejects(consume,/cannot get property "agents" without inject/);
  assert.equal(scopes.length,0);await missing.dispose();
  assert.deepEqual(budgetInject,['agents']);
  await ctx.plugin({name:'TEST-declared-budget-child',inject:budgetInject,apply:child=>mountBudgetGuard(child,gate)});
  assert.deepEqual(await consume(),[{type:'TEST-local-only'}]);
  assert(scopes.every(scope=>scope.sessionId===sessionId&&scope.requestId==='TEST-native-rpc'&&scope.attribution.life_id==='life-TEST-trusted'));
  assert(scopes.every(scope=>!Object.hasOwn(scope.attribution,'request_id')));
  await ctx.fiber.dispose();
});

test('production budget plugin apply with Cordis injection uses only local stub wire',async t=>{
  const f=await fixture(t),body=await sse().text();
  // apply makes global fetch immutable. Exercise it in a fresh process while
  // replacing its captured transport with an explicit local Response fixture.
  const source=`
    import assert from 'node:assert/strict';
    import * as budget from ${JSON.stringify(new URL('./provider_gate.mjs',import.meta.url).href)};
    import {Context} from ${JSON.stringify(new URL('../native_dsh/node_modules/@deepseek-ai/cordis/lib/index.js',import.meta.url).href)};
    let transportCalls=0;globalThis.fetch=async()=>{transportCalls++;return new Response(${JSON.stringify(body)},{headers:{'content-type':'text/event-stream'}});};
    const ctx=new Context(),agent={session:{id:'TEST-production-apply-session'}};
    await ctx.plugin({name:'TEST-native-agents-provider',apply:child=>child.provide('agents',{get:id=>{assert.equal(id,agent.session.id);return agent;}})});
    ctx.provide('personaCostIdentity',{resolve:(options,found)=>{assert.equal(found,agent);return {life_id:'life-TEST-injection',run_id:'TEST-native-run',request_id:'TEST-native-rpc',source_kind:'developer-test',reason:'developer_test',provenance:'trusted_native_source'};}});
    await ctx.plugin(budget,{python:${JSON.stringify(PYTHON)},db:${JSON.stringify(f.db)}});
    assert.equal(Object.getOwnPropertyDescriptor(globalThis,'fetch').writable,false);
    const options={provider:'deepseek-official',model:'deepseek-flash',sessionId:agent.session.id};
    const stream=ctx.waterfall('llm/stream',options,()=> (async function*(){const response=await fetch(${JSON.stringify(API_URL)},${JSON.stringify(wire())});yield await response.text();})());
    for await(const value of stream)assert(value.includes('message_stop'));
    assert.equal(transportCalls,1);await ctx.fiber.dispose();
    console.log(JSON.stringify({passed:true,local_stub_transport_calls:transportCalls,paid_calls:0,real_credential_reads:0}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{passed:true,local_stub_transport_calls:1,paid_calls:0,real_credential_reads:0});
  assert.equal((await f.rpc('status')).settled,280000);
});

test('real Cordis waterfall routes all call purposes through same wire gate',async t=>{
  const f=await fixture(t);const received=[];
  const gate=createBudgetGate({rpc:f.rpc,transport:async(_url,init)=>{received.push(JSON.parse(init.body));return sse();}});
  const ctx=new Context();mountBudgetGuard(ctx,gate);
  for(const purpose of ['dialogue','tool-step','subagent','retry','schedule-wakeup','compaction','other-model-call']) {
    const options={provider:'deepseek-official',model:'deepseek-flash',sessionId:'offline-session',purpose};
    const stream=ctx.waterfall('llm/stream',options,()=> (async function*(){
      const response=await gate.fetch(API_URL,wire());yield await response.text();
    })());
    for await(const _value of stream) {}
  }
  assert.equal(received.length,7);
  assert.equal(f.calls.filter(c=>c.operation==='reserve').length,7);
  assert.equal(new Set(f.calls.filter(c=>c.operation==='reserve').map(c=>c.attempt_id)).size,7);
  let continued=false;
  const denied=ctx.waterfall('llm/stream',{provider:'new-provider',model:'unknown'},()=>{continued=true;return [];});
  await assert.rejects(async()=>{for await(const _x of denied) {}});
  assert.equal(continued,false);
  await ctx.fiber.dispose();
});

test('real shipped DeepSeek adapter: cap after serializer/extensions, actual usage',async t=>{
  const f=await fixture(t,{limit:2120000000});const received=[];
  const gate=createBudgetGate({rpc:f.rpc,transport:async(url,init)=>{received.push({url,body:JSON.parse(init.body)});return sse();}});
  const original=globalThis.fetch;globalThis.fetch=gate.fetch;
  t.after(()=>{globalThis.fetch=original;});
  const connection=resolveAdapterOptions({baseURL:'https://api.deepseek.com/anthropic',maxTokens:16384,retryPolicy:{mode:'normal',maxRetries:0}});
  const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),
    resolveUserId:()=> 'offline-user',prepareExtensions:async()=>({fields:{dsh_plugin_packages:[]},accept:async()=>{}})});
  const ctx=new Context();mountBudgetGuard(ctx,gate);
  const runtime=new LlmRuntime(ctx);
  runtime.registerAdapter(['deepseek-official'],adapter);
  const options={provider:'deepseek-official',model:'deepseek-flash',sessionId:'offline-real-adapter',purpose:'compaction',
    maxTokens:16384,messages:[createUserMessage({content:[{type:'text',text:'offline test'}]})]};
  const prepared=await runtime.prepareCall({provider:options.provider,model:options.model,maxTokens:16384});
  const chunks=[];
  for await(const chunk of prepared.stream({...options,...prepared.config})) chunks.push(chunk);
  assert.equal(received.length,1);
  assert.equal(received[0].url,API_URL);
  assert.equal(received[0].body.max_tokens,2855);
  assert.equal(chunks.find(c=>c.type==='usage').usage.inputTokens,100);
  assert.equal((await f.rpc('status')).settled,280000);
  // Standalone compaction/title calls use the same runtime stream entry.
  for await(const _chunk of runtime.stream({...options,purpose:'session-title'})) {}
  assert.equal(received.length,2);
  await ctx.fiber.dispose();
});

test('production RPC subprocess protocol uses real authority, without credentials',async t=>{
  const f=await fixture(t);
  const rpc=pythonAuthority({python:PYTHON,db:f.db});
  const gate=createBudgetGate({rpc,transport:async()=>sse()});
  await (await gate.within(context('dialogue'),()=>gate.fetch(API_URL,wire()))).text();
  assert.equal((await rpc('status')).settled,280000);
});


test('terminal usage survives delayed stream cleanup failure and admits next step', async t => {
  const f = await fixture(t);
  const bytes = new TextEncoder().encode(await sse().text());
  let calls = 0;
  const gate = createBudgetGate({ rpc: f.rpc, transport: async () => {
    calls++; let delivered = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!delivered) { delivered = true; controller.enqueue(bytes); }
      else controller.error(new DOMException('Consumer cleanup after message_stop', 'AbortError'));
    } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const first = await gate.within(context('dialogue'), () => gate.fetch(API_URL, wire()));
  await first.text();
  const second = await gate.within(context('tool-step'), () => gate.fetch(API_URL, wire()));
  await second.text();
  assert.equal(calls, 2);
  const status = await f.rpc('status');
  assert.equal(status.open_attempts, 0); assert.equal(status.unknown_attempts, 0);
  assert.equal(status.settled, 560000);
});


test('unknown usage does not latch the next request when configured off; reservations remain',async t=>{
 const f=await fixture(t,{stopUnknown:false});let calls=0;
 const gate=createBudgetGate({rpc:f.rpc,stopOnUnknownUsage:false,transport:async()=>{calls++;return calls===1?sse(usage,{missing:true}):sse();}});
 await assert.rejects((await gate.within(context('first'),()=>gate.fetch(API_URL,wire()))).text());
 await (await gate.within(context('second'),()=>gate.fetch(API_URL,wire()))).text();
 assert.equal(calls,2);const status=await f.rpc('status');
 assert.equal(status.unknown_attempts,1);assert(status.unsettled_reservations>0);assert.equal(status.stop_reason,null);
});
