// Isolated native owners + the same production router + real official Codex.
// This is backend acceptance; formal life Sessions are tested separately.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from '../multi-life/fixture.mjs';
import {LifeRegistry} from '../multi-life/registry.mjs';
import {bootScoped} from '../multi-life/boot-scoped.mjs';
import {mountModernRouter} from './modern.mjs';
const report=resolve(import.meta.dirname,'../../../reports/luna-default-20261006');
await mkdir(report,{recursive:true});
const fixture=await createFixture();
const registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});
let host;
try {
 for(const m of fixture.manifests)registry.register(m);
 host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root});
 const router=await mountModernRouter(host.runtime);router.notify=false;
 const parents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
 const prompts=['Return exactly A-391: '+(17*23),'Return exactly B-551: '+(19*29),'Return exactly A-899: '+(31*29),'Return exactly B-323: '+(17*19)];
 const starts=await Promise.all(prompts.map((prompt,i)=>router.start(parents[i%2],{prompt})));
 await Promise.all([...router.pending]);
 const results=await Promise.all(starts.map((r,i)=>router.results(parents[i%2],{child_id:r.child_id})));
 await writeFile(resolve(report,'official-four-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
 assert(results.every(r=>r.status==='completed'&&r.model==='gpt-5.6-luna'));
 for(let i=0;i<4;i++)assert(results[i].output.some(b=>b.type==='text'&&b.text.includes(prompts[i].slice(15).split(':')[0])));
 await assert.rejects(router.results(parents[1],{child_id:starts[0].child_id}),/NOT_VISIBLE/);
 console.log(JSON.stringify({ok:true,results:results.map(({output,...row})=>row)}));
}finally{await host?.ctx.fiber.dispose();registry.close();}
