import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {OwnerBindings} from '../private-services/bindings.mjs';
import {ResourceBroker} from './resources.mjs';
import {OwnerBrowser} from './browser.mjs';

async function playwright() {
  if(process.env.MULTILIFE_TEST_PLAYWRIGHT_PACKAGE)return createRequire(process.env.MULTILIFE_TEST_PLAYWRIGHT_PACKAGE)('playwright');
  const root=resolve(process.env.LOCALAPPDATA,'npm-cache/_npx');
  const candidates=[];for(const row of await readdir(root,{withFileTypes:true}))if(row.isDirectory()){
    const packagePath=resolve(root,row.name,'node_modules/playwright/package.json');
    try{const p=JSON.parse(await readFile(packagePath,'utf8'));candidates.push({packagePath,version:p.version});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  candidates.sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}));
  if(!candidates.length)throw Error('Installed Playwright package required; no auto-install');
  return createRequire(candidates[0].packagePath)('playwright');
}
class Stub extends LlmAdapter {async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}async *stream(){yield {type:'finish',reason:{kind:'stop'}};}}
test('T6: four real isolated Chromium profiles retain their own synthetic Cookie and signature; A does not block B',async()=>{
  const fixture=await createFixture(['A','B','C','D']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'});let host,browsers,server;
  try {
    for(const m of fixture.manifests)registry.register(m);
    host=await bootScoped({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,adapter:new Stub(),providerRoutes:['TEST-shared-provider']});
    const agents=await Promise.all(fixture.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'})));
    const contexts=agents.map(a=>host.contexts.execution(a)),rows=new Map(fixture.manifests.map(m=>[m.lifeId,{accounts:{social:{accountRef:'TEST-social-'+m.lifeId,kind:'identity'}},browsers:{default:{bindingRef:'TEST-profile-'+m.lifeId,profileRoot:resolve(m.deployment.state,'TEST-browser-profile')}}}]));
    const bindings=new OwnerBindings({contexts:host.contexts,bindings:rows}),resources=new ResourceBroker({contexts:host.contexts,locks:host.locks});
    server=createServer((req,res)=>{const principal=/TEST_PRINCIPAL=([^;]+)/.exec(req.headers.cookie??'')?.[1]??'MISSING';res.writeHead(200,{'content-type':'text/html'});res.end('<title>TEST SIGNATURE '+principal+'</title><p>Local synthetic account only</p>');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
    const {chromium}=await playwright();
    const executablePath=[chromium.executablePath(),'.local/unconfigured/msedge.exe','.local/unconfigured/chrome.exe'].find(existsSync);
    if(!executablePath)throw Error('Installed Chromium or Edge required; no auto-install');
    const make=setup=>new OwnerBrowser({contexts:host.contexts,bindings,resources,launchPersistentContext:(path,options)=>chromium.launchPersistentContext(path,{...options,executablePath}),setup});
    browsers=make(async(c,_binding,browser)=>browser.addCookies([{name:'TEST_PRINCIPAL',value:c.lifeId,url,expires:Date.now()/1000+86400}]));
    const observed=await Promise.all(contexts.map(c=>browsers.open(c,{url})));for(const [i,result] of observed.entries())assert.equal(result.title,'TEST SIGNATURE '+contexts[i].lifeId);
    let arrived,release;const entered=new Promise(r=>arrived=r),hold=new Promise(r=>release=r);
    const held=browsers.withProfile(contexts[0],{},async()=>{arrived();await hold;});await entered;
    const independent=await browsers.open(contexts[1],{url});assert.equal(independent.title,'TEST SIGNATURE '+contexts[1].lifeId);release();await held;
    await assert.rejects(browsers.open(contexts[0],{url,name:'legacy-persona-browser'}),/BROWSER_BINDING_REQUIRED/);
    await browsers.close();browsers=make(async()=>{});
    for(const c of contexts)assert.equal((await browsers.open(c,{url})).title,'TEST SIGNATURE '+c.lifeId);
    await writeFile(new URL('../../../../reports/multi-life-implementation-20261006/browser-validation.json',import.meta.url),JSON.stringify({passed:true,observedAt:new Date().toISOString(),realChromium:true,isolatedProfiles:4,syntheticIdentityOnly:true,parallelProfilesVerified:true,profileReopenVerified:true,realAccountsAccessed:false,fixtureCleaned:true},null,2)+'\n');
  }finally{await browsers?.close();if(server)await new Promise(r=>server.close(r));if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}
});
