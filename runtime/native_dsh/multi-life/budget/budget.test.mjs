import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {LifeContexts} from '../context.mjs';
import {BudgetAuthority,createNativeBudgetSeam,mountBudgetStatus} from './index.mjs';

const policy=JSON.parse(await readFile(new URL('../../../budget_guard/config.json',import.meta.url),'utf8'));
const reservation=policy.input_bound_tokens*policy.peak_nano_cny_per_token.miss+policy.min_output_tokens*policy.peak_nano_cny_per_token.output;
const fixtureNow='2026-10-06T15:00:00+08:00';
async function setup({labels=['A','B'],cap=reservation*10,perLife=false,stopOnUnknownUsage=true,separateAccounts=false,budgetLimitsEnabled=true}={}) {
  const f=await createFixture(labels),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'}),contexts=new LifeContexts(registry),executions=new Map(),agents=new Map(),accounts=new Map(),lifeAccounts=new Map();
  for(const m of f.manifests) {
    registry.register(m);const header={id:m.authoritySessionId,cwd:m.deployment.workspace,createdAt:1,agentPreset:m.deployment.presetId};
    registry.reserve({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'});registry.complete(header.id,header);
    const agent={session:{id:header.id,header}};contexts.bind(agent);agents.set(header.id,agent);
    executions.set(m.lifeId,contexts.execution(agent,{runId:randomUUID(),requestId:randomUUID(),costCategory:m.displayName.endsWith('A')?'conversation':'subagent-research'}));
    const accountRef=separateAccounts?'TEST-account-'+m.lifeId:'TEST-shared-account';
    accounts.set(accountRef,{dailyLimitNanoCny:cap,stopOnUnknownUsage});lifeAccounts.set(m.lifeId,{accountRef,...(perLife?{limitNanoCny:reservation}:{})});
  }
  const options={contexts,root:resolve(f.registryRoot,'TEST-ONLY-budget'),accounts,lifeAccounts,fixtureNow,budgetLimitsEnabled};
  const authority=new BudgetAuthority(options),c=m=>executions.get(m.lifeId);
  const reserve=(m,id=randomUUID())=>authority.execute(c(m),'reserve',{attempt_id:id,max_tokens:policy.min_output_tokens,payload_hash:'TEST-hash'});
  const bind=(m,id)=>authority.execute(c(m),'bind',{attempt_id:id,max_tokens:policy.min_output_tokens,wire_hash:'a'.repeat(64)});
  return {f,registry,contexts,authority,options,c,reserve,bind,agents,async cleanup(){registry.close();await f.cleanup();}};
}
const usage={input_tokens:100,cache_creation_input_tokens:0,cache_read_input_tokens:50,output_tokens:20};
function ledgerSnapshot(s) {
  const db=resolve(s.options.root,createHash('sha256').update('TEST-shared-account').digest('hex')+'.sqlite3');
  const script=`import sqlite3,json,sys\nfrom pathlib import Path\nc=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;c.execute('PRAGMA query_only=ON')\nr={t:[dict(x) for x in c.execute('SELECT * FROM '+t+' ORDER BY 1')] for t in ('attempts','attempt_owners','owner_audit')}\nr['other_meta']=[dict(x) for x in c.execute(\"SELECT * FROM meta WHERE key!='owner_policy' ORDER BY key\")]\nr['policy_changes']=[dict(x) for x in c.execute('SELECT * FROM policy_change_audit ORDER BY seq')] if c.execute(\"SELECT 1 FROM sqlite_master WHERE name='policy_change_audit'\").fetchone() else []\nprint(json.dumps(r));c.close()`;
  const result=spawnSync('python',['-B','-X','utf8','-c',script,db],{windowsHide:true,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}

test('T10: four trusted lives contend only on atomic shared-account admission and owner sums match',async()=>{
  const s=await setup({labels:['A','B','C','D'],cap:reservation*2});
  try {
    const results=await Promise.allSettled(s.f.manifests.map((m,i)=>s.reserve(m,'TEST-attempt-'+i)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal(results.filter(r=>r.status==='rejected').length,2);
    const account=await s.authority.inspectAccount('TEST-shared-account');
    assert.ok(account.account.settled+account.account.unsettled_reservations<=account.account.daily_limit);
    assert.equal(account.account.unsettled_reservations,reservation*2);assert.equal(account.owner_sums_verified,true);
    assert.equal(Object.values(account.by_life).reduce((sum,row)=>sum+row.unsettled_reservations,0),account.account.unsettled_reservations);
    assert.equal(Object.values(account.by_category).reduce((sum,row)=>sum+row.unsettled_reservations,0),account.account.unsettled_reservations);
    const audit=await Promise.all(s.f.manifests.map(m=>s.authority.execute(s.c(m),'audit')));
    assert.equal(audit.flatMap(a=>a.rows).filter(row=>row.operation==='reserve').length,4);
    for(let i=0;i<audit.length;i++)assert.ok(audit[i].rows.every(row=>row.life_id===s.f.manifests[i].lifeId));
  }finally{await s.cleanup();}
});

test('per-life optional ceilings preserve other lives and disjoint categories',async()=>{
  const s=await setup({perLife:true});
  try {
    const [A,B]=s.f.manifests;await s.reserve(A,'TEST A first');
    await assert.rejects(s.reserve(A,'TEST A second'),/life_budget_exhausted/);await s.reserve(B,'TEST B first');
    const status=await s.authority.execute(s.c(A),'status');assert.equal(status.life.available,0);assert.equal(status.by_life,undefined);
    const inspected=await s.authority.inspectAccount('TEST-shared-account');assert.equal(Object.keys(inspected.by_category).length,2);
  }finally{await s.cleanup();}
});

test('reserve-bind-settle is attributed, replay-safe, exact to existing price snapshot and persistent',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.f.manifests;await s.reserve(A,'TEST settle');await s.bind(A,'TEST settle');
    const settled=await s.authority.execute(s.c(A),'settle',{attempt_id:'TEST settle',usage});
    const expected=usage.input_tokens*policy.peak_nano_cny_per_token.miss+usage.cache_read_input_tokens*policy.peak_nano_cny_per_token.hit+usage.output_tokens*policy.peak_nano_cny_per_token.output;
    assert.equal(settled.charged,expected);
    const reopened=new BudgetAuthority(s.options);const state=await reopened.execute(s.c(A),'status');assert.equal(state.life.settled,expected);assert.equal(state.account.unsettled_reservations,0);
    assert.equal((await reopened.execute(s.c(A),'settle',{attempt_id:'TEST settle',usage})).duplicate,true);
    await assert.rejects(reopened.execute(s.c(B),'settle',{attempt_id:'TEST settle',usage}),/attempt_owner_mismatch/);
    await assert.rejects(s.reserve(A,'TEST settle'),/attempt_already_admitted/);
    const audit=await reopened.execute(s.c(A),'audit');assert.deepEqual(audit.rows.slice(0,3).map(row=>row.operation),['reserve','bind','settle']);
    assert.ok(audit.rows.every(row=>row.run_id===s.c(A).runId&&row.category===s.c(A).costCategory&&row.request_id===s.c(A).requestId));
  }finally{await s.cleanup();}
});

test('only unbound pre-dispatch reservations release; possible sending and unknown usage never expire',async()=>{
  const s=await setup();
  try {
    const A=s.f.manifests[0];await s.reserve(A,'TEST no-send');
    const release=await s.authority.execute(s.c(A),'release',{attempt_id:'TEST no-send'});assert.equal(release.provider_called,false);assert.equal(release.actual_usage_known,false);
    assert.equal((await s.authority.execute(s.c(A),'status')).account.unsettled_reservations,0);
    assert.equal((await s.authority.execute(s.c(A),'release',{attempt_id:'TEST no-send'})).duplicate,true);
    await assert.rejects(s.authority.execute(s.c(A),'settle',{attempt_id:'TEST no-send',usage}),/released_attempt/);
    await s.reserve(A,'TEST possible-send');await s.bind(A,'TEST possible-send');
    await assert.rejects(s.authority.execute(s.c(A),'release',{attempt_id:'TEST possible-send'}),/cannot_release/);
    await s.authority.execute(s.c(A),'unknown',{attempt_id:'TEST possible-send',reason:'TEST transport lost'});
    const reopened=new BudgetAuthority(s.options),status=await reopened.execute(s.c(A),'status');
    assert.equal(status.account.unknown_attempts,1);assert.equal(status.account.unsettled_reservations,reservation);
    await assert.rejects(s.reserve(A,'TEST no-retry'),/unresolved_usage/);
    await reopened.execute(s.c(A),'settle',{attempt_id:'TEST possible-send',usage});await s.reserve(A,'TEST after-late-receipt');
  }finally{await s.cleanup();}
});

test('incomplete terminal usage commits unknown in the same owner audit transaction',async()=>{
  const s=await setup({separateAccounts:true});
  try {
    const [A,B]=s.f.manifests;await s.reserve(A,'TEST incomplete');await s.bind(A,'TEST incomplete');
    await assert.rejects(s.authority.execute(s.c(A),'settle',{attempt_id:'TEST incomplete',usage:{}}),/incomplete_usage_reservation_retained/);
    const status=await s.authority.execute(s.c(A),'status');assert.equal(status.account.unknown_attempts,1);assert.equal(status.account.unsettled_reservations,reservation);
    const audit=await s.authority.execute(s.c(A),'audit');assert.equal(audit.rows.at(-1).outcome,'denied');assert.match(audit.rows.at(-1).detail_json,/incomplete_usage/);
    await s.reserve(B,'TEST other-account-proceeds');
  }finally{await s.cleanup();}
});

test('reused native Messages wire gate records actual attempts, bounds bytes and settles complete synthetic SSE',async()=>{
  const s=await setup();
  try {
    const A=s.f.manifests[0],bodies=[];
    const gate=s.authority.gateFor(s.c(A),{transport:async(_url,init)=>{
      bodies.push(JSON.parse(init.body));
      const events=[{type:'message_start',message:{id:'TEST-provider-receipt',usage:{input_tokens:usage.input_tokens,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:usage.cache_read_input_tokens}}},
        {type:'message_delta',usage:{output_tokens:usage.output_tokens}},{type:'message_stop'}];
      return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
    }});
    const response=await gate.within(()=>gate.fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:policy.min_output_tokens,messages:[]})}));
    await response.text();await gate.drain();assert.equal(bodies[0].max_tokens,policy.min_output_tokens-1);
    const audit=await s.authority.execute(s.c(A),'audit');assert.deepEqual(audit.rows.map(r=>r.operation),['reserve','bind','settle']);
    assert.equal(new Set(audit.rows.map(row=>row.attempt_id)).size,1);
    const status=await s.authority.execute(s.c(A),'status');assert.equal(status.account.unsettled_reservations,0);assert.ok(status.account.settled>0);
  }finally{await s.cleanup();}
});

test('wire failure retains reservation, owner mismatch/forged arguments fail before provider dispatch',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.f.manifests;let calls=0;
    const gate=s.authority.gateFor(s.c(A),{transport:async()=>{calls++;throw Error('TEST uncertain transport');}});
    await assert.rejects(gate.within(()=>gate.fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:policy.min_output_tokens,messages:[]})})),/reservation_retained/);
    assert.equal(calls,1);assert.equal((await s.authority.execute(s.c(A),'status')).account.unsettled_reservations,reservation);
    await assert.rejects(s.authority.execute({...s.c(A)},'status'),/TRUSTED_EXECUTION_CONTEXT_REQUIRED/);
    await assert.rejects(s.authority.execute(s.c(B),'reserve',{attempt_id:'TEST forged',max_tokens:256,payload_hash:'TEST',session_id:A.authoritySessionId}),/BUDGET_IDENTITY_ARGUMENT_MISMATCH/);
    await assert.rejects(s.authority.execute(s.c(B),'status',{lifeId:A.lifeId}),/BUDGET_ARGUMENT_SCOPE_INVALID/);
    const seam=createNativeBudgetSeam({ctx:{},contexts:s.contexts,authority:s.authority});
    await assert.rejects(seam.wrapTransport(async()=>{calls++;})(new URL('https://api.deepseek.com/anthropic/v1/messages'),{}),/TRUSTED_MODEL_BUDGET_CONTEXT_REQUIRED/);assert.equal(calls,1);
  }finally{await s.cleanup();}
});

test('price/policy drift, conflicting usage and provider capacity breach are durable fail-closed decisions',async()=>{
  const s=await setup();
  try {
    const A=s.f.manifests[0];await s.reserve(A,'TEST conflict');await s.bind(A,'TEST conflict');await s.authority.execute(s.c(A),'settle',{attempt_id:'TEST conflict',usage});
    await assert.rejects(s.authority.execute(s.c(A),'settle',{attempt_id:'TEST conflict',usage:{...usage,output_tokens:21}}),/conflicting_duplicate_usage/);
    await assert.rejects(s.reserve(A,'TEST blocked-by-breach'),/provider_bound_or_usage_breach/);
    const changed=new BudgetAuthority({...s.options,accounts:new Map([['TEST-shared-account',{dailyLimitNanoCny:reservation*11}]])});
    await assert.rejects(changed.execute(s.c(A),'status'),/account_policy_changed_review_required/);
    const state=await s.authority.inspectAccount('TEST-shared-account');assert.equal(state.owner_sums_verified,true);assert.ok(state.account.stop_reason);
  }finally{await s.cleanup();}
});

test('unknown policy may preserve other lives on the shared account while retaining every full reservation',async()=>{
  const s=await setup({cap:reservation*2,stopOnUnknownUsage:false});
  try {
    const [A,B]=s.f.manifests;await s.reserve(A,'TEST unknown does not freeze');await s.bind(A,'TEST unknown does not freeze');
    await s.authority.execute(s.c(A),'unknown',{attempt_id:'TEST unknown does not freeze'});await s.reserve(B,'TEST B runs');
    const account=await s.authority.inspectAccount('TEST-shared-account');assert.equal(account.account.unknown_attempts,1);
    assert.equal(account.account.unsettled_reservations,reservation*2);await assert.rejects(s.reserve(B,'TEST cannot overspend'),/budget|insufficient/);
  }finally{await s.cleanup();}
});

test('provider usage outside admitted capacity is preserved and halts later admission',async()=>{
  const s=await setup();
  try {
    const A=s.f.manifests[0];await s.reserve(A,'TEST bound breach');await s.bind(A,'TEST bound breach');
    await assert.rejects(s.authority.execute(s.c(A),'settle',{attempt_id:'TEST bound breach',usage:{...usage,output_tokens:policy.min_output_tokens+1}}),/provider_bound_violation_recorded_and_halted/);
    const state=await s.authority.execute(s.c(A),'status');assert.equal(state.account.output_tokens,policy.min_output_tokens+1);assert.equal(state.owner_sums_verified,true);
    await assert.rejects(s.reserve(A,'TEST breach no retry'),/provider_bound_or_usage_breach/);
  }finally{await s.cleanup();}
});

test('native llm iterator seam carries Host-derived run/category and status only exposes current owner details',async()=>{
  const s=await setup();
  try {
    const [A,B]=s.f.manifests;let middleware,statusTool;
    const ctx={agents:s.agents,on:(name,callback)=>{assert.equal(name,'llm/stream');middleware=callback;},effect:()=>{},tools:{register:tool=>{statusTool=tool;}}};
    s.contexts.execution=(agent,options)=>{assert.equal(options?.runId,undefined);return s.c(s.f.manifests.find(m=>m.authoritySessionId===agent.session.id));};
    const seam=createNativeBudgetSeam({ctx,contexts:s.contexts,authority:s.authority});
    const transport=seam.wrapTransport(async()=>{
      const events=[{type:'message_start',message:{id:'TEST-native',usage:{...usage,output_tokens:0}}},{type:'message_delta',usage:{output_tokens:usage.output_tokens}},{type:'message_stop'}];
      return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
    });seam.mount();mountBudgetStatus({ctx,contexts:s.contexts,authority:s.authority});
    async function* next(){const response=await transport('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:256,messages:[]})});await response.text();yield {type:'finish',reason:{kind:'stop'}};}
    await Promise.all([A,B].map(async m=>{for await(const item of middleware({sessionId:m.authoritySessionId},next))assert.equal(item.reason.kind,'stop');}));
    for(const m of [A,B]) {
      const audit=await s.authority.execute(s.c(m),'audit');assert.equal(audit.rows.length,3);assert.ok(audit.rows.every(row=>row.run_id===s.c(m).runId&&row.category===s.c(m).costCategory));
    }
    const status=await statusTool.execute({}, {agent:s.agents.get(A.authoritySessionId),callId:'TEST status'});assert.equal(status.ok,true);assert.equal(status.life_id,A.lifeId);assert.equal(status.by_life,undefined);
  }finally{await s.cleanup();}
});

test('native adapter serialized context-overflow errors retain semantic code and unknown billing state',async()=>{
  const s=await setup({labels:['A']});
  try {
    const A=s.f.manifests[0];let middleware;
    const ctx={agents:s.agents,on:(_name,callback)=>{middleware=callback;},effect:()=>{}};
    s.contexts.execution=()=>s.c(A);
    const seam=createNativeBudgetSeam({ctx,contexts:s.contexts,authority:s.authority});
    const transport=seam.wrapTransport(async()=>new Response(JSON.stringify({error:{type:'invalid_request_error',message:'maximum context length exceeded'}}),{status:400,headers:{'content-type':'application/json'}}));
    seam.mount();
    async function* next(){try{await transport('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:256,messages:[]})});}
      catch{yield {type:'finish',reason:{kind:'error',failure:{code:'TRANSPORT',message:'serialized adapter failure'}}};}}
    const items=[];for await(const item of middleware({sessionId:A.authoritySessionId},next))items.push(item);
    assert.equal(items[0].reason.failure.code,'CONTEXT_WINDOW_EXCEEDED');
    const state=await s.authority.execute(s.c(A),'status');assert.equal(state.account.unknown_attempts,1);assert.equal(state.account.unsettled_reservations,reservation);
  }finally{await s.cleanup();}
});

test('Host explicitly disables account/per-life ceilings and unknown halt while preserving usage and cold reservations',async()=>{
  const s=await setup({cap:1,perLife:true,budgetLimitsEnabled:false});
  try {
    const [A,B]=s.f.manifests;
    await Promise.all([s.reserve(A,'TEST unlimited A1'),s.reserve(A,'TEST unlimited A2'),s.reserve(B,'TEST unlimited unknown')]);
    const fullUsage={input_tokens:policy.input_bound_tokens,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:policy.min_output_tokens};
    for(const id of ['TEST unlimited A1','TEST unlimited A2']) {await s.bind(A,id);await s.authority.execute(s.c(A),'settle',{attempt_id:id,usage:fullUsage});}
    await s.bind(B,'TEST unlimited unknown');await s.authority.execute(s.c(B),'unknown',{attempt_id:'TEST unlimited unknown',reason:'TEST ONLY uncertain provider receipt'});
    const cold=new BudgetAuthority(s.options),status=await cold.execute(s.c(A),'status');
    assert.equal(status.account.daily_limit,1);assert.equal(status.account.budget_limits_enabled,false);assert.equal(status.account.daily_limit_enforced,false);
    assert.equal(status.account.available,0);assert.equal(status.account.available_kind,'reference_only_limits_disabled');assert.equal(status.account.stop_reason,null);
    assert.equal(status.account.stop_on_unknown_usage,false);assert.equal(status.account.unknown_attempts,1);assert.equal(status.account.unsettled_reservations,reservation);
    assert.equal(status.life.settled,reservation*2);assert.equal(status.life.limit,reservation);assert.equal(status.life.limit_enforced,false);assert.equal(status.life.available_kind,'reference_only_limits_disabled');
    await cold.execute(s.c(A),'reserve',{attempt_id:'TEST cold proceeds above both references',max_tokens:256,payload_hash:'TEST'});
    const snapshot=await cold.inspectAccount('TEST-shared-account');assert.equal(snapshot.owner_sums_verified,true);assert.equal(snapshot.account.settled,reservation*2);
    await assert.rejects(cold.execute(s.c(A),'review_policy',{expectedFingerprint:'a'.repeat(64),reason:'TEST model cannot change policy'}),/BUDGET_ARGUMENT_SCOPE_INVALID/);
    await assert.rejects(cold.execute(s.c(A),'status',{budgetLimitsEnabled:true}),/BUDGET_ARGUMENT_SCOPE_INVALID/);
    await assert.rejects(cold.execute(s.c(B),'settle',{attempt_id:'TEST unlimited A1',usage:fullUsage}),/attempt_owner_mismatch/);
    assert.throws(()=>new BudgetAuthority({...s.options,budgetLimitsEnabled:'false'}),/EXPLICIT_BUDGET_LIMIT_POLICY_REQUIRED/);
  }finally{await s.cleanup();}
});

test('policy drift requires explicit Host fingerprint CAS and preserves all attempts, owners, usage and owner audits',async()=>{
  const s=await setup();
  try {
    const A=s.f.manifests[0];await s.reserve(A,'TEST original settled');await s.bind(A,'TEST original settled');await s.authority.execute(s.c(A),'settle',{attempt_id:'TEST original settled',usage});
    await s.reserve(A,'TEST original unknown');await s.bind(A,'TEST original unknown');await s.authority.execute(s.c(A),'unknown',{attempt_id:'TEST original unknown'});
    const before=ledgerSnapshot(s),disabled=new BudgetAuthority({...s.options,budgetLimitsEnabled:false});
    await assert.rejects(disabled.execute(s.c(A),'status'),/account_policy_changed_review_required/);
    const review=await disabled.inspectPolicy('TEST-shared-account');assert.equal(review.matches,false);assert.equal(review.budgetLimitsEnabled,false);assert.equal(review.changeCount,0);
    assert.notEqual(review.currentFingerprint,review.requestedFingerprint);assert.deepEqual(ledgerSnapshot(s),before,'unapproved open and policy inspection do not rewrite history');
    await assert.rejects(disabled.reviewPolicy('TEST-shared-account',{expectedFingerprint:'a'.repeat(64),reason:'TEST ONLY stale approval'}),/account_policy_review_stale/);
    await assert.rejects(disabled.reviewPolicy('TEST-shared-account',{expectedFingerprint:review.currentFingerprint,reason:''}),/EXPLICIT_BUDGET_POLICY_REVIEW_REQUIRED/);
    const approved=await disabled.reviewPolicy('TEST-shared-account',{expectedFingerprint:review.currentFingerprint,reason:'TEST ONLY explicit Host authorization to disable all budget ceilings'});
    assert.equal(approved.reviewed,true);assert.equal(approved.currentFingerprint,review.requestedFingerprint);
    const after=ledgerSnapshot(s);for(const key of ['attempts','attempt_owners','owner_audit','other_meta'])assert.deepEqual(after[key],before[key]);
    assert.equal(after.policy_changes.length,1);assert.equal(after.policy_changes[0].reviewer,'HOST-CONTROL');assert.equal(after.policy_changes[0].old_fingerprint,review.currentFingerprint);assert.equal(after.policy_changes[0].new_fingerprint,review.requestedFingerprint);
    await assert.rejects(disabled.reviewPolicy('TEST-shared-account',{expectedFingerprint:review.currentFingerprint,reason:'TEST ONLY repeated stale approval'}),/account_policy_review_stale/);
    const reopened=new BudgetAuthority({...s.options,budgetLimitsEnabled:false}),current=await reopened.inspectPolicy('TEST-shared-account');
    assert.equal(current.matches,true);assert.equal(current.changeCount,1);assert.equal(current.lastChange.reason,after.policy_changes[0].reason);
    assert.equal((await reopened.execute(s.c(A),'status')).account.stop_reason,null);
    await reopened.execute(s.c(A),'reserve',{attempt_id:'TEST approved cold admission',max_tokens:256,payload_hash:'TEST'});
    await assert.rejects(s.authority.execute(s.c(A),'status'),/account_policy_changed_review_required/);
    await assert.rejects(reopened.execute(s.c(A),'policy_status'),/BUDGET_ARGUMENT_SCOPE_INVALID/);
  }finally{await s.cleanup();}
});

test('uncapped wire gate retains unknown usage and allows a later real synthetic dispatch without budget halt',async()=>{
  const s=await setup({labels:['A'],cap:1,budgetLimitsEnabled:false});
  try {
    const A=s.f.manifests[0];let calls=0;
    const gate=s.authority.gateFor(s.c(A),{transport:async()=>{
      if(++calls===1)throw Error('TEST ONLY ambiguous first transport');
      const events=[{type:'message_start',message:{id:'TEST uncapped late request',usage:{...usage,output_tokens:0}}},{type:'message_delta',usage:{output_tokens:usage.output_tokens}},{type:'message_stop'}];
      return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
    }});
    const send=()=>gate.within(()=>gate.fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:256,messages:[]})}));
    await assert.rejects(send(),/reservation_retained/);await (await send()).text();await gate.drain();
    const status=await s.authority.execute(s.c(A),'status');assert.equal(calls,2);assert.equal(status.account.unknown_attempts,1);
    assert.equal(status.account.unsettled_reservations,reservation);assert.ok(status.account.settled>1);assert.equal(status.account.stop_reason,null);assert.equal(status.owner_sums_verified,true);
  }finally{await s.cleanup();}
});

test('actual wire attempts preserve native provenance and yield per-life cache/reasoning reports without double billing',async()=>{
  const s=await setup();
  try {
    const A=s.f.manifests[0],agent=s.agents.get(A.authoritySessionId),requestId='TEST-developer-burst-request';
    agent.session.ownEvents=()=>[{type:'user/message',data:{source:{kind:'room-inbox-batch',reasonKind:'developer-test',rpcId:requestId,sender_types:['human'],roomId:'TEST-room'}}},
      {type:'turn/start',data:{turn:9}},{type:'user/message',data:{source:{kind:'life-current-state'}}}];
    const c=s.contexts.execution(agent),gate=s.authority.gateFor(c,{transport:async()=>new Response([
      {type:'message_start',message:{id:'TEST-provider-request',usage:{input_tokens:100,cache_creation_input_tokens:0,cache_read_input_tokens:50,output_tokens:0}}},
      {type:'message_delta',usage:{output_tokens:20,reasoning_tokens:7}},{type:'message_stop'}
    ].map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})});
    for(let i=0;i<2;i++) {
      const response=await gate.within(()=>gate.fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:256,
        system:'TEST ONLY stable system',tools:[{name:'read',input_schema:{type:'object'}}],messages:[{role:'user',content:'TEST ONLY stable initial message'},{role:'user',content:'TEST ONLY dynamic '+i}]})}));
      await response.text();await gate.drain();
    }
    const db=resolve(s.options.root,createHash('sha256').update('TEST-shared-account').digest('hex')+'.sqlite3');
    const query=spawnSync(s.authority.python,['-B','-X','utf8',resolve(import.meta.dirname,'usage.py'),'--ledger',db,'--day','2026-10-06','--request-id',requestId],{encoding:'utf8',windowsHide:true});
    assert.equal(query.status,0,query.stderr);const report=JSON.parse(query.stdout);
    assert.equal(report.requests.length,2);assert.equal(report.groups.length,1);assert.equal(report.groups[0].reason,'developer_test');assert.equal(report.groups[0].life_id,A.lifeId);
    assert.equal(report.total.cache_hit_rate,1/3);assert.equal(report.total.reasoning_tokens,14);assert.equal(report.total.output_tokens,40);
    const expected=2*(100*policy.peak_nano_cny_per_token.miss+50*policy.peak_nano_cny_per_token.hit+20*policy.peak_nano_cny_per_token.output);
    assert.equal(report.total.local_estimated_cost_nano_cny,expected);
    assert.equal(new Set(report.requests.map(row=>row.attempt_id)).size,2);assert.equal(new Set(report.requests.map(row=>row.run_id)).size,1);
    assert.equal(report.requests[0].prompt_metadata.system_hash,report.requests[1].prompt_metadata.system_hash);
    assert.equal(report.requests[0].prompt_metadata.tools_hash,report.requests[1].prompt_metadata.tools_hash);
    assert(!JSON.stringify(report).includes('stable system'));
    const status=await s.authority.execute(c,'status');assert.equal(status.life.usage.cache_hit_rate,1/3);assert.equal(status.life.usage.known_requests,2);
    await assert.rejects(s.authority.execute(c,'reserve',{attempt_id:'TEST forged attribution',max_tokens:256,payload_hash:'TEST',attribution:{life_id:s.f.manifests[1].lifeId}}),/IDENTITY_ARGUMENT_MISMATCH/);
  } finally {await s.cleanup();}
});
