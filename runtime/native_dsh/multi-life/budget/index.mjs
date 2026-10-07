import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,contains,PRIVATE_ROOTS,freeze,fail} from '../contracts.mjs';
import {createBudgetGate} from '../../../budget_guard/provider_gate.mjs';

const script=fileURLToPath(new URL('./authority.py',import.meta.url));
const pricingPath=fileURLToPath(new URL('../../../budget_guard/config.json',import.meta.url));
const allowed={reserve:['attempt_id','request_id','session_id','purpose','provider','model','owner_pid','max_tokens','payload_hash','attribution','prompt_metadata'],
  bind:['attempt_id','max_tokens','output_headroom_tokens','wire_hash'],settle:['attempt_id','usage','provider_request_id'],
  unknown:['attempt_id','reason'],release:['attempt_id'],status:[],audit:['offset','limit']};
const identity=context=>({life_id:context.lifeId,session_id:context.sessionId,run_id:context.runId,
  request_id:context.requestId??context.runId,category:context.costCategory});
const hostOwner=Object.freeze({life_id:'HOST-CONTROL',session_id:'HOST-CONTROL',run_id:'HOST-CONTROL',request_id:'HOST-CONTROL',category:'HOST-CONTROL'});

function rpc(python,request) {
  const env={PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
  for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  return new Promise((accept,reject)=>{
    const child=spawn(python,['-B','-X','utf8',script],{env,windowsHide:true,stdio:['pipe','pipe','ignore']});
    let output='',finished=false;
    const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):accept(result);};
    const stop=code=>{const error=new Error(code);error.code=code;error.retryable=false;finish(error);};
    const timer=setTimeout(()=>{child.kill();stop('BUDGET_AUTHORITY_TIMEOUT_UNKNOWN; inspect ledger before retrying');},35000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{output+=s;if(Buffer.byteLength(output)>1000000){child.kill();stop('BUDGET_OUTPUT_LIMIT');}});
    child.on('error',()=>stop('BUDGET_AUTHORITY_UNAVAILABLE'));
    child.on('close',code=>{try{const result=JSON.parse(output);if(code||result.error)stop('BUDGET_STOP: '+(result.error??'authority_failed'));else finish(null,result.result);}catch{stop('BUDGET_AUTHORITY_REPLY_UNKNOWN; inspect ledger before retrying');}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
  });
}

export class BudgetAuthority {
  #accounts=new Map();#lives=new Map();
  constructor({contexts,root,accounts,lifeAccounts,budgetLimitsEnabled=true,python=(process.env.DL_PYTHON || 'python'),fixtureNow}) {
    if(!contexts?.require||!root||!(accounts instanceof Map)||!(lifeAccounts instanceof Map))fail('EXPLICIT_BUDGET_CONTROL_BINDINGS_REQUIRED');
    if(typeof budgetLimitsEnabled!=='boolean')fail('EXPLICIT_BUDGET_LIMIT_POLICY_REQUIRED');
    this.contexts=contexts;this.root=canonical(root);this.python=python;
    if(!contains(canonical(contexts.registry.controlRoot),this.root))fail('BUDGET_ROOT_OUTSIDE_CONTROL');
    for(const life of contexts.registry.list())for(const key of PRIVATE_ROOTS) {
      const path=canonical(life.deployment[key]);if(contains(path,this.root)||contains(this.root,path))fail('BUDGET_CONTROL_PRIVATE_ROOT_COLLISION');
    }
    if(fixtureNow&&contexts.registry.mode!=='fixture')fail('BUDGET_CLOCK_FIXTURE_ONLY');this.fixtureNow=fixtureNow;
    const prices=JSON.parse(readFileSync(pricingPath,'utf8'));
    for(const [accountRef,policy] of accounts) {
      if(typeof accountRef!=='string'||!accountRef||!Number.isSafeInteger(policy.dailyLimitNanoCny)||policy.dailyLimitNanoCny<1)fail('BUDGET_ACCOUNT_POLICY_INVALID');
      if(Object.keys(policy).some(key=>!['dailyLimitNanoCny','stopOnUnknownUsage'].includes(key)))fail('BUDGET_ACCOUNT_POLICY_INVALID');
      const limit=policy.dailyLimitNanoCny;
      const config={...prices,budget_limits_enabled:budgetLimitsEnabled,daily_limit_nano_cny:limit,
        warning_nano_cny:Math.min(prices.warning_nano_cny,Math.floor(limit*.8)),
        conservative_nano_cny:Math.min(prices.conservative_nano_cny,Math.floor(limit*.9)),
        stop_on_unknown_usage:budgetLimitsEnabled&&policy.stopOnUnknownUsage!==false};
      delete config.daily_limit_suspended_on;
      this.#accounts.set(accountRef,{config:freeze(config),lifeLimits:{},db:resolve(this.root,createHash('sha256').update(accountRef).digest('hex')+'.sqlite3')});
    }
    for(const [lifeId,binding] of lifeAccounts) {
      contexts.registry.life(lifeId);
      if(Object.keys(binding).some(key=>!['accountRef','limitNanoCny'].includes(key)))fail('BUDGET_LIFE_POLICY_INVALID');
      const account=this.#accounts.get(binding.accountRef);if(!account)fail('BUDGET_ACCOUNT_BINDING_REQUIRED');
      if(binding.limitNanoCny!==undefined&&(!Number.isSafeInteger(binding.limitNanoCny)||binding.limitNanoCny<0))fail('BUDGET_LIFE_POLICY_INVALID');
      if(binding.limitNanoCny!==undefined)account.lifeLimits[lifeId]=binding.limitNanoCny;
      this.#lives.set(lifeId,freeze(structuredClone(binding)));
    }
    for(const account of this.#accounts.values())freeze(account.lifeLimits);
  }
  #binding(context) {
    const c=this.contexts.require(context),binding=this.#lives.get(c.lifeId);if(!binding)fail('BUDGET_LIFE_BINDING_REQUIRED');
    if(Object.values(identity(c)).some(value=>typeof value!=='string'||!value||value.length>256))fail('BUDGET_CONTEXT_IDENTITY_INVALID');
    return {c,accountRef:binding.accountRef,...this.#accounts.get(binding.accountRef)};
  }
  async #request(binding,operation,args,owner=identity(binding.c)) {
    return rpc(this.python,{db:binding.db,config:binding.config,accountRef:binding.accountRef,
      lifeLimits:binding.lifeLimits,fixtureNow:this.fixtureNow,owner,operation,arguments:args});
  }
  async execute(context,operation,args={}) {
    const binding=this.#binding(context),c=binding.c;
    if(!Object.hasOwn(allowed,operation)||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!allowed[operation].includes(key)))fail('BUDGET_ARGUMENT_SCOPE_INVALID');
    let payload=structuredClone(args);
    if(operation==='reserve') {
      for(const [key,value] of Object.entries({session_id:c.sessionId,request_id:c.requestId??c.runId,purpose:c.costCategory,owner_pid:process.pid}))
        if(payload[key]!==undefined&&payload[key]!==value)fail('BUDGET_IDENTITY_ARGUMENT_MISMATCH');
      for(const key of ['provider','model'])if(payload[key]!==undefined&&payload[key]!==binding.config[key])fail('BUDGET_UNPRICED_ROUTE');
      const attribution={life_id:c.lifeId,run_id:c.runId,reason:c.costCategory,source_kind:c.sourceKind??null,
        provenance:c.costProvenance??'trusted_owner_source_unknown',origin_room_id:c.origin_room_id??null};
      if(payload.attribution&&Object.keys(payload.attribution).some(key=>payload.attribution[key]!==attribution[key]))fail('BUDGET_IDENTITY_ARGUMENT_MISMATCH');
      payload={...payload,attribution,session_id:c.sessionId,request_id:c.requestId??c.runId,purpose:c.costCategory,owner_pid:process.pid,
        provider:binding.config.provider,model:binding.config.model};
    }
    const result=await this.#request(binding,operation,payload);
    if(operation==='status'){delete result.by_life;delete result.by_category;}
    return result;
  }
  // Host-only credential selection; not a model tool or caller-supplied account.
  accountRefFor(context){return this.#binding(context).accountRef;}
  // Host-only inspection, never registered as a model tool or identity selector.
  async inspectAccount(accountRef) {
    const account=this.#accounts.get(accountRef);if(!account)fail('BUDGET_ACCOUNT_BINDING_REQUIRED');
    return this.#request({accountRef,...account},'status',{},hostOwner);
  }
  // Existing ledger policy changes require explicit Host review, never execute().
  async inspectPolicy(accountRef) {
    const account=this.#accounts.get(accountRef);if(!account)fail('BUDGET_ACCOUNT_BINDING_REQUIRED');
    return this.#request({accountRef,...account},'policy_status',{},hostOwner);
  }
  async reviewPolicy(accountRef,args) {
    const account=this.#accounts.get(accountRef);if(!account)fail('BUDGET_ACCOUNT_BINDING_REQUIRED');
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['expectedFingerprint','reason'].includes(k))||
      !/^[a-f0-9]{64}$/.test(args.expectedFingerprint??'')||typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>1024)fail('EXPLICIT_BUDGET_POLICY_REVIEW_REQUIRED');
    return this.#request({accountRef,...account},'review_policy',structuredClone(args),hostOwner);
  }
  gateFor(context,{transport,diagnostic=async()=>null,screenRequest}={}) {
    const binding=this.#binding(context),c=binding.c;
    if(typeof transport!=='function')fail('BUDGET_TRANSPORT_REQUIRED');
    const gate=createBudgetGate({rpc:(operation,args)=>this.execute(c,operation,args),transport,diagnostic,screenRequest,
      stopOnUnknownUsage:binding.config.stop_on_unknown_usage});
    const wireContext={provider:binding.config.provider,model:binding.config.model,sessionId:c.sessionId,
      requestId:c.requestId??c.runId,purpose:c.costCategory,attribution:{life_id:c.lifeId,run_id:c.runId,reason:c.costCategory,
        source_kind:c.sourceKind??null,provenance:c.costProvenance??'trusted_owner_source_unknown',origin_room_id:c.origin_room_id??null}};
    return {fetch:gate.fetch,within:fn=>gate.within(wireContext,fn),drain:gate.drain,get contextRejection(){return wireContext.contextRejection;}};
  }
}

// No global fetch replacement. Give wrapTransport(rawFetch) to a scoped adapter.
// The iterator resumes within the trusted owner scope on every next/return.
export function createNativeBudgetSeam({ctx,contexts,authority,diagnostic,screenRequest}) {
  const scope=new AsyncLocalStorage(),gates=new WeakMap(),pending=new Set();
  const wrapTransport=transport=>async(input,init)=>{
    const c=scope.getStore();if(!c)fail('TRUSTED_MODEL_BUDGET_CONTEXT_REQUIRED');contexts.require(c);
    if(!gates.has(c)){const gate=authority.gateFor(c,{transport,diagnostic,screenRequest});gates.set(c,gate);pending.add(gate);}
    const gate=gates.get(c);return gate.within(()=>gate.fetch(input,init));
  };
  function mount(){
    ctx.on('llm/stream',(options,next)=>(async function*(){
      const agent=ctx.agents.get(options.sessionId);if(!agent)fail('UNATTRIBUTED_MODEL_REQUEST');
      // The Host resolves real turn/RPC/source provenance; native middleware
      // must not replace it with a random run or a generic model category.
      const c=contexts.execution(agent);
      const iterator=await scope.run(c,()=>next()[Symbol.asyncIterator]());
      try{while(true){
        contexts.require(c);const item=await scope.run(c,()=>iterator.next());if(item.done)break;
        const rejection=gates.get(c)?.contextRejection;
        // Preserve the original gate's context-overflow identity even when a
        // native adapter serializes transport errors as a finish chunk.
        if(rejection&&item.value?.type==='finish'&&item.value.reason?.kind==='error') {
          yield {...item.value,reason:{...item.value.reason,failure:{...item.value.reason.failure,
            code:'CONTEXT_WINDOW_EXCEEDED',message:rejection.message}}};
        }else yield item.value;
      }}catch(error){
        const seen=new Set();for(let cause=error;cause&&!seen.has(cause);cause=cause.cause){seen.add(cause);if(cause.code==='CONTEXT_WINDOW_EXCEEDED')throw cause;}
        throw error;
      }
      finally{if(iterator.return)await scope.run(c,()=>iterator.return());const gate=gates.get(c);if(gate){await gate.drain();pending.delete(gate);}}
    })(),{prepend:true});
    ctx.effect(()=>()=>Promise.all([...pending].map(g=>g.drain())),'shared-account-budget-drain');
  }
  return {wrapTransport,mount,currentContext:()=>{
    const c=scope.getStore();if(!c)fail('TRUSTED_MODEL_BUDGET_CONTEXT_REQUIRED');return contexts.require(c);
  }};
}

export function mountBudgetStatus({ctx,contexts,authority}) {
  ctx.tools.register({name:'budget_status',description:'Read this owner’s attributed budget and its shared account totals. Amounts use audited prices, not provider debit evidence.',
    parameters:{type:'object',properties:{},additionalProperties:false},isConcurrencySafe:()=>true,
    output:{schema:{type:'object'},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(_args,exec){
      try{return {ok:true,...await authority.execute(contexts.execution(exec.agent,{callId:exec.callId,costCategory:'budget-status'}),'status')};}
      catch{return {ok:false,error:'BUDGET_STATUS_UNAVAILABLE'};}
    }});
}
