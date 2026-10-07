import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createFixture} from '../multi-life/fixture.mjs';
import {LifeRegistry} from '../multi-life/registry.mjs';
import {bootScoped} from '../multi-life/boot-scoped.mjs';
import {mountPlatform} from '../multi-life/platform/mount.mjs';
import {mountModernRouter} from './modern.mjs';
test('native life_delegate tool uses the common Luna router and respects the DS switch',async()=>{
 const fixture=await createFixture(),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});let host;
 try{
  for(const m of fixture.manifests)registry.register(m);
  host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root});
  Object.assign(host,mountPlatform(host,{root:fixture.root+'/platform'}));
  const router=await mountModernRouter(host.runtime);router.notify=false;host.runtime.subagentReady=Promise.resolve(router);
  router.settings.protectedRoot=fixture.root;router.slotRoot=fixture.root+'/luna-slots';router.auditRoot=fixture.root+'/subagent-audit';
  let settle;const completion=new Promise(resolve=>settle=resolve);
  router.provider=async()=>({start:async request=>({id:randomUUID(),result:completion.then(()=>({stopReason:'completed',output:request.prompt})),dispose:async()=>{}})});
  const parent=await host.runtime.create({lifeId:fixture.manifests[0].lifeId,sessionId:fixture.manifests[0].authoritySessionId,role:'authority'});
  const call=(name,args)=>host.ctx.tools.execute({agent:parent,name,arguments:args,callId:randomUUID(),signal:new AbortController().signal});
  for(const name of ['life_delegate','subagent','subagent_codex']) {
   const started=await Promise.race([call(name,{task:'native delegate entry',run_in_background:false}),delay(1000).then(()=>{throw new Error(name+' blocked the native parent tool step');})]);
   assert.equal(started.isError,false,JSON.stringify(started));assert.equal(started.value.background,true);
   assert.equal(started.value.wait_requested,true);assert.notEqual(started.value.status,'completed');
   assert.equal(started.value.model,'gpt-5.6-luna');
  }
  settle();await Promise.all([...router.pending]);assert.equal((await router.results(parent)).agents.length,3);
  assert((await router.results(parent)).agents.every(row=>row.status==='completed'));
  const denied=await call('life_delegate',{task:'explicit DS must stop',provider:'deepseek'});
  assert.match(JSON.stringify(denied),/DEEPSEEK_SUBAGENTS_DISABLED/);
  assert(!host.ctx.tools.schemas(parent).some(t=>t.name==='subagent_deepseek'));
 }finally{await host?.ctx.fiber.dispose();registry.close();}
});
