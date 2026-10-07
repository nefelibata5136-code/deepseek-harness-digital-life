// Same router/official backend with isolated native owners; actual shell/read/write.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {createFixture} from '../multi-life/fixture.mjs';
import {LifeRegistry} from '../multi-life/registry.mjs';
import {bootScoped} from '../multi-life/boot-scoped.mjs';
import {mountModernRouter} from './modern.mjs';
const report=resolve(import.meta.dirname,'../../../reports/luna-full-access-20261007');await mkdir(report,{recursive:true});
const fixture=await createFixture(),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});let host;
try{
 for(const m of fixture.manifests)registry.register(m);
 host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root});
 const router=await mountModernRouter(host.runtime);router.notify=false;
 const parents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
 const inputs=[];
 for(let i=0;i<2;i++){
  const input={nonce:randomUUID(),a:19+i*7,b:43+i*5};inputs.push(input);
  await writeFile(resolve(fixture.manifests[i].deployment.workspace,'full-access-input.json'),JSON.stringify(input));
 }
 const starts=await Promise.all(parents.map(parent=>router.start(parent,{task:'完全访问功能验收：请真实使用 shell 命令读取当前 cwd 的 full-access-input.json 文本（PowerShell Get-Content，不用图像 read/view）。不要猜内容。计算文件中 a+b，并在同一 cwd 创建 full-access-output.json，包含 nonce、sum、Host父life_id和cwd。再用 shell 读回输出验证。仅操作这两个测试文件，返回 nonce、sum、实际工具名。不要访问凭据或别的目录。'})));
 await Promise.all([...router.pending]);
 const results=await Promise.all(starts.map((r,i)=>router.results(parents[i],{child_id:r.child_id})));
 await writeFile(resolve(report,'official-full-access.json'),JSON.stringify({checked_at:new Date().toISOString(),fixture_root:fixture.root,results},null,2));
 for(let i=0;i<2;i++){
  const row=results[i];assert.equal(row.status,'completed');assert.equal(row.actual_model,'gpt-5.6-luna');assert.equal(row.sandbox_policy,'dangerFullAccess');assert.equal(row.approval_policy,'never');assert(row.command_count>0);
  const actual=JSON.parse((await readFile(resolve(fixture.manifests[i].deployment.workspace,'full-access-output.json'),'utf8')).replace(/^\uFEFF/,''));
 assert.equal(actual.nonce,inputs[i].nonce);assert.equal(actual.sum,inputs[i].a+inputs[i].b);assert.equal(actual.life_id??actual['Host父life_id'],fixture.manifests[i].lifeId);
 }
 console.log(JSON.stringify({ok:true,results:results.map(({output,...r})=>r)}));
}finally{await host?.ctx.fiber.dispose();registry.close();}
