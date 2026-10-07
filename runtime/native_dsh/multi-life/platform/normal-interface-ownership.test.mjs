import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {canonical,privatePaths,validateManifest} from '../contracts.mjs';
import {assertOwnershipPath,createNormalInterfaceOwnership,mountNormalInterfaceOwnership} from './normal-interface-ownership.mjs';

async function fixture() {
  const f=await createFixture(['OWNERSHIP-A','OWNERSHIP-B']);
  for(const m of f.manifests) {
    m.deployment.privateRoots=[resolve(f.root,m.lifeId,'history'),resolve(f.root,m.lifeId,'native-sessions')];
    for(const root of m.deployment.privateRoots)await mkdir(root,{recursive:true});
  }
  return f;
}
test('symmetric paths cover history/journals, dynamic N-way roots, aliases, Host control and shared writes',async()=>{
  const f=await fixture();
  try {
    const [A,B]=f.manifests,shared=resolve(f.root,'public-project'),control=resolve(f.root,'trusted-control');
    await mkdir(shared);await mkdir(control);await writeFile(resolve(shared,'public.txt'),'TEST ONLY public');
    const rows=[A,B],options={lifeId:A.lifeId,manifests:()=>rows,controlRoots:[control],protectedWriteRoots:[control]};
    for(const owner of rows)for(const peer of rows.filter(m=>m!==owner))for(const root of privatePaths(peer))
      assert.throws(()=>assertOwnershipPath({...options,lifeId:owner.lifeId},resolve(root,'private.txt')),/OTHER_LIFE_PRIVATE_RESOURCE/);
    assert.equal(assertOwnershipPath(options,resolve(shared,'public.txt')),canonical(resolve(shared,'public.txt')));
    assert.equal(assertOwnershipPath(options,resolve(shared,'new.txt'),{write:true}),canonical(resolve(shared,'new.txt')));
    assert.throws(()=>assertOwnershipPath(options,resolve(control,'token.json')),/TRUSTED_CONTROL_RESOURCE/);
    const link=resolve(shared,'peer-link');await symlink(B.deployment.workspace,link,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>assertOwnershipPath(options,resolve(link,'same-name.txt')),/OTHER_LIFE_PRIVATE_RESOURCE/);
    const C=structuredClone(B);C.lifeId='life-'+randomUUID();C.deployment={...B.deployment,workspace:resolve(f.root,'future-life')};
    await mkdir(C.deployment.workspace);rows.push(C);
    assert.throws(()=>assertOwnershipPath(options,resolve(C.deployment.workspace,'later.txt')),/OTHER_LIFE_PRIVATE_RESOURCE/);
    assert.throws(()=>validateManifest({...A,deployment:{...A.deployment,privateRoots:'untrusted'}},'fixture'),/PRIVATE_RESOURCE_ROOTS_INVALID/);
  }finally{await f.cleanup();}
});

test('owner is bound by Host context; model selectors and direct opaque private paths fail',async()=>{
  const f=await fixture();
  try {
    const [A,B]=f.manifests,agent={session:{id:A.authoritySessionId}},trusted={lifeId:A.lifeId,sessionId:A.authoritySessionId};
    const policy=createNormalInterfaceOwnership({manifests:()=>f.manifests,resolveOwner:value=>{assert.equal(value,agent);return trusted;}});
    const c=policy.forAgent(agent);
    for(const field of ['life_id','lifeId','ownerLifeId','owner_life_id','owner'])
      assert.throws(()=>policy.assertArguments(c,{name:'read_source',arguments:{file_path:resolve(A.deployment.workspace,'same-name.txt'),[field]:B.lifeId}}),/OWNER_IS_HOST_BOUND/);
    for(const name of ['terminal','subagent','subagent_codex'])
      assert.throws(()=>policy.assertArguments(c,{name,arguments:{command:'Get-Content '+resolve(B.deployment.privateRoots[0],'secret.txt')}}),/OTHER_LIFE_PRIVATE_RESOURCE/);
    assert.throws(()=>policy.forAgent({session:{id:B.authoritySessionId}}));
    assert.doesNotThrow(()=>policy.assertArguments(c,{name:'observe_life',arguments:{life_id:B.lifeId}}));
    assert.doesNotThrow(()=>policy.assertArguments(c,{name:'life_send_message',arguments:{body:B.deployment.workspace}}));
  }finally{await f.cleanup();}
});

test('native read/write, direct read_source, Skills and session-query obey the same Host owner policy',async()=>{
  const f=await fixture(),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});let host;
  try {
    for(const m of f.manifests)registry.register(m);
    host=await bootScoped({registry,root:f.nativeRoot,fixtureRoot:f.root,extensions:[async host=>{
      mountNormalInterfaceOwnership(host.ctx,{registry,contexts:host.contexts,manifests:()=>registry.list(),controlRoots:[resolve(f.root,'control-secrets')]});
      // Same direct Node reader used by the old full-access read_source path.
      host.ctx.tools.register(defineTool({name:'read_source',description:'TEST ONLY direct full-access source reader',parameters:{file_path:{type:'string',required:true}},
        output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async args=>({content:await readFile(args.file_path,'utf8')})}));
    }]});
    const agents=await Promise.all(f.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    const call=(agent,name,args)=>host.ctx.tools.execute({agent,name,arguments:args,callId:randomUUID(),signal:new AbortController().signal});
    for(let index=0;index<agents.length;index++) {
      const owner=f.manifests[index],peer=f.manifests[1-index],agent=agents[index];
      const own=await call(agent,'read',{file_path:resolve(owner.deployment.workspace,'same-name.txt')});assert.equal(own.isError,false);assert(JSON.stringify(own).includes(index?'OWNERSHIP-B':'OWNERSHIP-A'));
      for(const name of ['read','read_source','write','edit']) {
        const args={file_path:resolve(peer.deployment.workspace,'same-name.txt'),...name==='write'?{content:'TEST ONLY forbidden'}:{},...name==='edit'?{old_string:'TEST',new_string:'FORBIDDEN'}:{}};
        const denied=await call(agent,name,args);assert(denied.isError,JSON.stringify(denied));assert(JSON.stringify(denied).includes('OTHER_LIFE_PRIVATE_RESOURCE'),JSON.stringify(denied));
      }
      const source=await call(agent,'read_source',{file_path:resolve(owner.deployment.workspace,'same-name.txt')});assert.equal(source.isError,false);
      const skill=await call(agent,'skill',{name:'fixture-skill'});assert.equal(skill.isError,false);assert(JSON.stringify(skill).includes(index?'OWNERSHIP-B':'OWNERSHIP-A'));
      const deniedQuery=await call(agent,'session_trace',{session_id:peer.authoritySessionId});
      // The minimal scoped kernel does not mount the session-query tool; check
      // the exact service through the same trusted operation context instead.
      assert(deniedQuery.isError);
      const policy=host.ctx.get('normalInterfaceOwnership'),c=policy.forAgent(agent);
      await assert.rejects(policy.run(c,()=>host.ctx.sessionQuery.observeSession(peer.authoritySessionId)),/OTHER_LIFE_PRIVATE_SESSION/);
      const ownSnapshot=await policy.run(c,()=>host.ctx.sessionQuery.observeSession(owner.authoritySessionId));ownSnapshot[Symbol.dispose]();
    }
    assert.equal(await readFile(resolve(f.manifests[1].deployment.workspace,'same-name.txt'),'utf8'),'TEST ONLY FILE OWNERSHIP-B\n');
    // A local worker may own only A while the trusted neutral snapshot protects
    // B. Neither the model nor the local Registry has to register B as runnable.
    assert.throws(()=>host.ctx.get('normalInterfaceOwnership').pathFor(f.manifests[0].lifeId,resolve(f.manifests[1].deployment.privateRoots[0],'raw.log')),/OTHER_LIFE_PRIVATE_RESOURCE/);
  }finally{if(host)await host.ctx.fiber.dispose();registry.close();await f.cleanup();}
});

test('parallel owner contexts do not become a process-wide current life',async()=>{
  const f=await fixture();
  try {
    const [A,B]=f.manifests,policy=createNormalInterfaceOwnership({manifests:f.manifests});
    let release;const barrier=new Promise(r=>release=r),order=[];
    const first=policy.run({lifeId:A.lifeId},async()=>{order.push(policy.active().lifeId);await barrier;assert.equal(policy.active().lifeId,A.lifeId);});
    await policy.run({lifeId:B.lifeId},async()=>{assert.equal(policy.active().lifeId,B.lifeId);order.push(B.lifeId);release();});await first;
    assert.deepEqual(order,[A.lifeId,B.lifeId]);assert.equal(policy.active(),undefined);
  }finally{await f.cleanup();}
});

test('a one-life worker uses the neutral manifest snapshot without adopting or starting peers',async()=>{
  const f=await fixture(),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});let host;
  try {
    const [A,B]=f.manifests;registry.register(A);
    host=await bootScoped({registry,root:f.nativeRoot,fixtureRoot:f.root,extensions:[async h=>{
      mountNormalInterfaceOwnership(h.ctx,{registry,contexts:h.contexts,ownerLifeId:A.lifeId,manifests:()=>f.manifests});
    }]});
    const agent=await host.runtime.create({lifeId:A.lifeId,sessionId:A.authoritySessionId,role:'authority'});
    const denied=await host.ctx.tools.execute({agent,name:'read',arguments:{file_path:resolve(B.deployment.workspace,'same-name.txt')},callId:randomUUID(),signal:new AbortController().signal});
    assert(denied.isError);assert(JSON.stringify(denied).includes('OTHER_LIFE_PRIVATE_RESOURCE'));
    assert.equal(registry.list().length,1);assert.equal(host.ctx.agents.list().length,1);
    const ownFs=host.ctx.agentPresets.serviceFor(agent,'fs');
    await assert.rejects(ownFs.resolve(resolve(B.deployment.privateRoots[0],'raw.jsonl')),/OTHER_LIFE_PRIVATE_RESOURCE/);
  }finally{if(host)await host.ctx.fiber.dispose();registry.close();await f.cleanup();}
});
