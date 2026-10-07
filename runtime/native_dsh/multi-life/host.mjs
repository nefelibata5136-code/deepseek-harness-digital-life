import {resolve} from 'node:path';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {bootLifeKernel} from './boot-scoped.mjs';
import {createLifeServices} from './life-services/index.mjs';
import {mountLifeServiceTools} from './life-services/tools.mjs';
import {mountLifeNativeSchedule} from './life-services/native-schedule.mjs';
import {mountPrivateServices} from './private-services/index.mjs';
import {mountPlatform} from './platform/mount.mjs';
import {createNativeMemorySources} from './platform/native-memory-sources.mjs';
import {mountLifeCapabilities} from './platform/capabilities.mjs';
import {OwnerAttachments} from './platform/attachments.mjs';
import {OwnerBrowser} from './platform/browser.mjs';
import {BudgetAuthority,createNativeBudgetSeam,mountBudgetStatus} from './budget/index.mjs';
import {fail} from './contracts.mjs';
import {isOfficialProviderFactory,isOfficialRawTransport} from './platform/official-provider.mjs';

// One composition; same implementations for N owners. No current-life singleton.
// Registry/manifest objects are trusted Host inputs, never model tool arguments.
export async function bootLifeHost({registry,root,fixtureRoot,adapter,providerRoutes,memoryBindings,ownerBindings,
  admit,authorityPolicy,actorPolicy,allowFullAccessPrivateTools,hostCredentialForMemory,sessionRoot,
  privacyPolicy,budgetConfig,rawModelTransport,providerFactory,capabilityOptions={},browserOptions,fairPolicy,extensions=[],externalWorld=false,platformRoot,scheduleRoot,digitalLifePreset=false}) {
  if(typeof admit!=='function')fail('EXPLICIT_RESOURCE_ADMISSION_REQUIRED');
  if(registry.mode==='production') {
    if(privacyPolicy!=='logical-owner-routing')fail('EXPLICIT_PRIVACY_POLICY_REQUIRED');
    if(!budgetConfig||typeof rawModelTransport!=='function'||typeof providerFactory!=='function')fail('PRODUCTION_PROVIDER_BUDGET_BINDING_REQUIRED');
    if(!isOfficialProviderFactory(providerFactory)||adapter||providerRoutes?.length!==1||providerRoutes[0]!=='deepseek-official')fail('PRODUCTION_AUDITED_PROVIDER_FACTORY_REQUIRED');
    if(!isOfficialRawTransport(rawModelTransport))fail('PRODUCTION_CAPTURED_RAW_TRANSPORT_REQUIRED');
    if(registry.list().some(m=>m.deployment.provider!=='deepseek-official'||m.deployment.model!=='deepseek-flash'))fail('PRODUCTION_UNPRICED_PROVIDER_ROUTE');
    for(const m of registry.list()) {
      if(!memoryBindings?.has(m.lifeId)||!ownerBindings?.has(m.lifeId))fail('PRODUCTION_PRIVATE_BINDING_REQUIRED');
      if(memoryBindings.get(m.lifeId).syntheticProvider)fail('SYNTHETIC_PROVIDER_FIXTURE_ONLY');
      if(m.kind==='legacy'&&(typeof authorityPolicy!=='function'||typeof actorPolicy!=='function'))fail('EXPLICIT_LEGACY_PERMISSION_POLICY_REQUIRED');
    }
  }
  let result;
  return bootLifeKernel({registry,root,fixtureRoot,adapter,providerRoutes,sessionRoot,digitalLifePreset,extensions:[async host=>{
    const {ctx,contexts,runtime,locks}=host;
    const schedule=await mountLifeNativeSchedule(ctx,{contexts,runtime,root:scheduleRoot??resolve(root,'schedule-storage'),admit});
    const running=new Set();ctx.on('session/event',(session,event)=>{
      if(event.type==='turn/start')running.add(session.id);if(event.type==='turn/end')running.delete(session.id);
    });
    const tasks={running:()=>[...running],
      list:async()=>registry.list().flatMap(m=>registry.sessions(m.lifeId)).map(row=>({sessionId:row.sessionId,lifeId:row.lifeId,role:row.role,status:row.status}))};
    const life=createLifeServices({contexts,schedule,tasks,locks,authorityPolicy});
    ctx.provide('digitalLifeOwnerServices',{services:life,contexts,tasks,status:async()=>({stop_reason:null,requestAdmission:'native-provider-budget-seam'})});
    mountLifeServiceTools(ctx,{services:life,execution:exec=>contexts.execution(exec.agent,{callId:exec.callId})});
    ctx.effect(()=>()=>life.dispose(),'per-life state service');
    const privateServices=mountPrivateServices({ctx,contexts,memoryBindings,ownerBindings,actorPolicy,
      allowFullAccessPrivateTools,hostCredentialForMemory,nativeSources:createNativeMemorySources(host),
      allowPrivateOperation:(c,exec)=>c.role!=='delegate'&&exec.name==='life_send_message'&&exec.arguments.publish_private_turn===true});
    host.fairPolicy=fairPolicy;
    const platform=mountPlatform(host,{root:platformRoot??resolve(root,'platform'),externalWorld});
    Object.assign(host,{life,schedule,privateServices,...platform});result=host;
    host.capabilities=mountLifeCapabilities(host,capabilityOptions);host.attachments=new OwnerAttachments(host);
    if(browserOptions){host.browser=new OwnerBrowser({contexts,bindings:privateServices.bindings,resources:platform.resources,...browserOptions});ctx.effect(()=>()=>host.browser.close(),'owner browser lifecycle');}
    if(budgetConfig) {
      const authority=new BudgetAuthority({contexts,root:resolve(registry.controlRoot,'budget'),...budgetConfig});
      host.providerAccountBindings=new Map([...budgetConfig.lifeAccounts].map(([lifeId,binding])=>[lifeId,binding.accountRef]));
      const seam=createNativeBudgetSeam({ctx,contexts,authority,screenRequest:(...args)=>host.screenModelRequest?.(...args)});seam.mount();mountBudgetStatus({ctx,contexts,authority});host.budget=authority;host.modelExecution=seam.currentContext;
      const transport=seam.wrapTransport(rawModelTransport);host.modelTransport=transport;
      if(providerFactory)ctx.llm.registerAdapter(providerRoutes,await providerFactory({host,transport}));
    }
    const turns=new WeakMap(),pendingEnds=new Set(),failures=new Map();
    ctx.on('agent/pre-step',async(request,next)=>{
      const decision=await next();if(decision.kind==='reject')return decision;
      const c=contexts.execution(request.agent);
      if(c.role!=='authority')return decision;
      if(failures.has(c.lifeId))fail('LIFE_LIFECYCLE_CHECKPOINT_FAILED');
      const turn=[...request.agent.session.ownEvents()].findLast(e=>e.type==='turn/start')?.data.turn;
      if(turns.get(request.agent)===turn)return decision;
      const snapshot=await life.snapshotFor(c,{admitWake:true});turns.set(request.agent,turn);
      // Keep earlier snapshots byte-stable for Provider prefix reuse. The
      // newest appended snapshot is current; rewriting old ones breaks cache.
      const state={snapshot_semantics:'Latest appended snapshot is current; earlier snapshots are historical.',lifeId:c.lifeId,time:snapshot.time,mental:snapshot.mental,continuity:snapshot.continuity,
        pending:snapshot.pending,settings:snapshot.settings,autonomy:'You may refuse, rest, change interests, or take no action. No permanent task defines your existence.'};
      return {...decision,messages:[...decision.messages,createUserMessage({content:[{type:'text',text:JSON.stringify(state)}],source:{kind:'life-current-state',lifeId:c.lifeId,form:'snapshot'}})]};
    },{prepend:true});
    ctx.on('session/event',(session,event)=>{
      if(event.type!=='turn/end')return;
      const agent=ctx.agents.get(session.id);if(!agent)return;
      const c=contexts.execution(agent);if(c.role!=='authority')return;
      const checkpoint=life.recordTurnEnd(c,{at:new Date(event.time).toISOString(),reason:event.data.reason?.kind})
        .catch(error=>failures.set(c.lifeId,error)).finally(()=>pendingEnds.delete(checkpoint));pendingEnds.add(checkpoint);
    });
    // No background timer starts at boot. Explicit controller enables ticking.
    host.tick=lifeId=>life.tick({lifeId,runtime,admit,isRunning:id=>tasks.running().includes(id)});
    host.processInbox=options=>host.rooms.processRequested({...options,runtime});
    host.drainCheckpoints=async()=>{await Promise.all([...pendingEnds]);if(failures.size)fail('LIFE_LIFECYCLE_CHECKPOINT_FAILED');};
  },...extensions]}).then(host=>result??host);
}
