import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBudgetGate,BudgetStop,ContextWindowExceeded,mountBudgetGuard} from './provider_gate.mjs';
import {classify,isContextWindowExceeded,recordIncident,formatIncident} from '../native_dsh/recovery/diagnostics.mjs';
import {DeepSeekAdapter,resolveAdapterOptions} from '../native_dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js';
import {Context} from '../native_dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import {LlmRuntime,createUserMessage} from '../native_dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';

const checks=[];
const check=(name,fn)=>{fn();checks.push(name);};
const incident=JSON.parse(await readFile(new URL('../native_dsh/recovery/state/incidents/cd561214-ee46-5799-85af-89f9411650ea.json',import.meta.url),'utf8'));
check('Real provider maximum context length incident is classified',()=>assert.equal(classify(incident),'context_size'));
check('Explicit context error code survives nested adapter causes',()=>assert.equal(classify({causes:[{code:'CONTEXT_WINDOW_EXCEEDED'}]}),'context_size'));
for(const [status,message,category] of [[400,'invalid tool result','request_rejected'],[401,'Unauthorized','authentication'],[429,'rate limited','rate_limit'],[500,'server error','provider_unavailable']]) {
  check('Non-context HTTP '+status+' category unchanged',()=>assert.equal(classify({httpStatus:status,providerError:{message}}),category));
}
const root=await mkdtemp(resolve(tmpdir(),'persona-context-error-'));
const {id:sourceId,observedAt:sourceObservedAt,...incidentDetail}=incident;
const persisted=await recordIncident(incidentDetail,root);
check('New incident contains semantic errorCode',()=>assert.equal(persisted.errorCode,'CONTEXT_WINDOW_EXCEEDED'));
check('Formatted incident shows semantic errorCode',()=>assert.match(formatIncident(persisted),/CONTEXT_WINDOW_EXCEEDED/));

const context={provider:'deepseek-official',model:'deepseek-flash',sessionId:'isolated-context-error',requestId:'isolated-request'};
const init={method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:100,messages:[{role:'user',content:'fixture'}]})};
async function exercise({status=400,message=incident.providerError.message,stream=false}={}) {
  const calls=[],diagnostics=[];let transports=0;
  const gate=createBudgetGate({rpc:async(op,args)=>{calls.push({op,args});return op==='reserve'?{allowed:true,max_tokens:100}:op==='bind'?{bound:true}:{};},
    diagnostic:async detail=>{diagnostics.push(detail);return {...detail,category:classify(detail)};},
    transport:async()=>{transports++;return stream
      ?new Response('event: error\ndata: '+JSON.stringify({type:'error',error:{type:'invalid_request_error',message}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
      :new Response(JSON.stringify({error:{type:'invalid_request_error',message}}),{status});}});
  let error;
  try{await gate.within(context,async()=>{const response=await gate.fetch('https://api.deepseek.com/anthropic/v1/messages',init);await response.text();});}catch(e){error=e;}
  assert.ok(error);
  assert.deepEqual(calls.map(c=>c.op),['reserve','bind','unknown']);
  assert.equal(calls.filter(c=>c.op==='settle').length,0);
  assert.equal(transports,1);
  let blocked;try{await gate.within(context,()=>gate.fetch('https://api.deepseek.com/anthropic/v1/messages',init));}catch(e){blocked=e;}
  assert.ok(blocked instanceof BudgetStop);assert.equal(transports,1);
  return {error,diagnostics};
}
for(const stream of [false,true]) {
  const {error,diagnostics}=await exercise({stream});
  check((stream?'SSE':'HTTP400')+' keeps context error, conservative unknown reservation, no retry',()=>{
    assert.ok(error instanceof ContextWindowExceeded);assert.equal(error.code,'CONTEXT_WINDOW_EXCEEDED');
    assert.equal(error.retryable,false);assert.equal(error.diagnostic.category,'context_size');
    assert.doesNotMatch(error.message,/BUDGET_STOP/);assert.equal(diagnostics.length,1);
  });
}
const ordinary=await exercise({status:400,message:'invalid tool protocol'});
check('Unrelated rejection retains old accounting error behavior',()=>assert.ok(ordinary.error instanceof BudgetStop));
check('Credential-shaped provider content is redacted',()=>assert.doesNotMatch(new ContextWindowExceeded({message:'Bearer secret-value sk-SYNTHETIC-REJECTION-FIXTURE-2dfbec46'},400).message,/secret-value|sk-123456789/));
check('Empty provider error is not classified as context',()=>assert.equal(isContextWindowExceeded({providerError:{message:'Empty error'}}),false));
let middleware;
mountBudgetGuard({on:(event,fn)=>{middleware=fn;},effect:()=>{}},{within:async(c,fn)=>fn(),drain:async()=>{}});
const semantic=new ContextWindowExceeded(incident.providerError,400);
let adapterError;
try{for await(const chunk of middleware(context,()=> (async function*(){throw Object.assign(new Error('DeepSeek Messages transport failed',{cause:semantic}),{code:'TRANSPORT'});})())){void chunk;}}catch(e){adapterError=e;}
check('Native adapter TRANSPORT wrapper is removed for explicit context rejection',()=>assert.equal(adapterError,semantic));
const originalFetch=globalThis.fetch;
const adapterCalls=[];
const realGate=createBudgetGate({rpc:async(op)=>{adapterCalls.push(op);return op==='reserve'?{allowed:true,max_tokens:100}:op==='bind'?{bound:true}:{};},diagnostic:async d=>({...d,category:classify(d)}),
  transport:async()=>new Response(JSON.stringify({error:incident.providerError}),{status:400})});
const realContext=new Context();
try{
  globalThis.fetch=realGate.fetch;
  mountBudgetGuard(realContext,realGate);
  const runtime=new LlmRuntime(realContext);
  const connection=resolveAdapterOptions({baseURL:'https://api.deepseek.com/anthropic',maxTokens:100,retryPolicy:{mode:'normal',maxRetries:0}});
  const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'offline-user',prepareExtensions:async()=>({fields:{dsh_plugin_packages:[]},accept:async()=>{}})});
  runtime.registerAdapter(['deepseek-official'],adapter);
  const prepared=await runtime.prepareCall({provider:'deepseek-official',model:'deepseek-flash',maxTokens:100});
  let failure;const chunks=[];
  try{for await(const chunk of prepared.stream({...context,purpose:'offline-context-rejection',...prepared.config,messages:[createUserMessage({content:[{type:'text',text:'offline fixture'}]})]})){chunks.push(chunk);}}catch(e){failure=e;}
  check('Real shipped adapter plus Cordis runtime exposes semantic code',()=>{
    assert.equal(failure,undefined);assert.equal(chunks.at(-1).reason.failure.code,'CONTEXT_WINDOW_EXCEEDED');
    assert.match(chunks.at(-1).reason.failure.message,/maximum context length/);assert.deepEqual(adapterCalls,['reserve','bind','unknown']);
  });
}finally{globalThis.fetch=originalFetch;await realContext.fiber.dispose();}
const hashes={};for(const path of ['./provider_gate.mjs','../native_dsh/recovery/diagnostics.mjs'])hashes[path]=createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex');
const result={passed:true,checks:checks.length,checkNames:checks,sourceHashes:hashes,paidCalls:0,liveHostRestarted:false,mainSessionWritten:false};
if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
