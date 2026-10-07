// Isolated installed native kernel, no provider transport or model calls.
import assert from 'node:assert/strict';
import {createFixture} from './fixture.mjs';
import {LifeRegistry} from './registry.mjs';
import {bootScoped} from './boot-scoped.mjs';
import {authorPressure} from './compaction.mjs';
const fixture=await createFixture(['A','B']);
const registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
let host;
try {
  for(const m of fixture.manifests)registry.register(m);
  host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root});
  assert(host.ctx.tokenMeter);assert(host.ctx.compaction);assert(host.ctx.personaCompaction.authorPressure);
  assert.equal(host.ctx.compaction.config.auto,false);
  const expected=['context_compact','context_compact_prepare','context_compact_commit','context_compact_status','context_compact_read'];
  for(const m of fixture.manifests) {
    const agent=await host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'});
    const schemas=host.ctx.tools.schemas(agent).map(t=>t.name);
    for(const name of expected)assert(schemas.includes(name),name+' missing');
    const c=host.contexts.execution(agent);assert.equal(c.lifeId,m.lifeId);assert.equal(c.sessionId,m.authoritySessionId);
    assert.throws(()=>host.contexts.forAgent({session:agent.session}),/TRUSTED_AGENT_CONTEXT_REQUIRED/);
    const other=fixture.manifests.find(x=>x.lifeId!==m.lifeId);
    assert.throws(()=>host.contexts.target(c,other.authoritySessionId));
  }
  assert.equal(authorPressure.authorMaxTokens,8192);
  console.log(JSON.stringify({ok:true,nativeTokenMeter:true,selfAuthoredOnly:true,twoOwnerToolDiscovery:true,foreignOwnerRejected:true,noModelCalls:true}));
}finally{if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}
