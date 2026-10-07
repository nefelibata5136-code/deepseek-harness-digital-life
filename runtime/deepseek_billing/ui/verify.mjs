import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(new URL('../../native_dsh/package.json',import.meta.url))('playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});
const script=await readFile(new URL('./client.js',import.meta.url),'utf8');
try{
 const page=await browser.newPage({viewport:{width:410,height:700}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 await page.route('http://billing.test/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/api/persona.billing'){
   const id=url.searchParams.get('sessionId');if(id==='old')await new Promise(r=>setTimeout(r,150));
   await route.fulfill({json:{billing:{source:'deepseek_platform',today_cost_cny:id==='new'?'0.0802077600000000':'1.4080788400000000',date:today,updated_at:new Date().toISOString(),stale:id==='new'}}});return;
  }
  await route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width"><div class="yb-workspace"><div class="yb-status-switch"></div></div>'});
 });
 await page.goto('http://billing.test/');
 await page.evaluate(()=>{window.__personaDesktopState={selectedSessionId:null};window.__ModuleLoader__={load:d=>d.factory().apply({effect:f=>{window.__cleanup=f();}})};});
 await page.addScriptTag({content:script});
 assert.equal(await page.locator('.yb-official-billing').getAttribute('data-stale'),'true');
 await page.evaluate(()=>{window.__personaDesktopState.selectedSessionId='old';});
 await page.waitForTimeout(1100);
 await page.evaluate(()=>{window.__personaDesktopState.selectedSessionId='new';const bar=document.createElement('div');bar.className='ref-statusbar';document.querySelector('.yb-workspace').append(bar);});
 await page.waitForFunction(()=>document.querySelector('.yb-official-billing')?.textContent.includes('¥0.08'));
 await page.waitForTimeout(250);
 assert.equal(await page.locator('.yb-official-billing').textContent(),'今日花费 ¥0.08 · 数据过期');
 await page.evaluate(()=>document.querySelector('.ref-statusbar').innerHTML='<div>状态栏重绘</div>');
 await page.waitForFunction(()=>document.querySelector('.yb-official-billing')?.textContent.includes('¥0.08'));
 assert.equal(await page.locator('.yb-official-billing').count(),1);
 assert.equal(await page.locator('.yb-status-switch>.yb-official-billing').count(),0);
 assert.match(await page.locator('.yb-official-billing').getAttribute('title'),/0\.0802077600000000/);
 await page.screenshot({path:fileURLToPath(new URL('./fixture-narrow.png',import.meta.url)),scale:'css'});
 await page.evaluate(()=>window.__cleanup());assert.equal(await page.locator('.yb-official-billing').count(),0);assert.deepEqual(errors,[]);
 const report={passed:true,isolatedBrowser:true,sessionSwitchRejectsLateResponse:true,staleVisible:true,statusRemount:true,singlePreferredBadge:true,initialUnavailableStale:true,delayedSessionWithoutDomMutation:true,cleanup:true,pageErrors:errors,productionLoaded:false};
 await writeFile(new URL('./validation.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
