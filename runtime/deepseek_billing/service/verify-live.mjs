import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=createRequire(new URL('../../native_dsh/package.json',import.meta.url))('playwright');
const folder=new URL('../../../reports/deepseek-billing-repair-20261007/',import.meta.url);
const {url}=JSON.parse(await readFile(new URL('.verify-auth.json',folder),'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1200,height:800}});
const errors=[];let blockedWrites=0;
await context.route('**/api/**',route=>{if(route.request().method()==='GET')return route.continue();blockedWrites++;return route.abort();});
try {
 const page=await context.newPage();page.on('pageerror',()=>errors.push('PAGE_ERROR'));
 await page.goto(url,{waitUntil:'domcontentloaded'});
 if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
 await page.locator('.yb-root').waitFor({timeout:30000});
 await page.locator('.yb-official-billing').first().waitFor({timeout:30000});
 await page.waitForFunction(()=>document.querySelector('.yb-official-billing')?.textContent.includes('¥'),{timeout:30000});
 const billing=await page.evaluate(async()=>{
  const status=await(await fetch('/api/persona.status')).json();
  const ids=['80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b','44d7298c-0e3e-5224-a7ac-f5a901916a83'];
  const snapshots=[];for(const id of ids){const response=await fetch('/api/persona.billing?sessionId='+id);const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={response_length:text.length,content_type:response.headers.get('content-type')};}snapshots.push({session_id:id,status:response.status,...data});}
  const bad=await fetch('/api/persona.billing?sessionId=b96b9ef3-2431-520e-b9d3-e1a1b820c5b1');
  return {selected_session:window.__personaDesktopState?.selectedSessionId,displayed:document.querySelector('.yb-official-billing')?.textContent,title:document.querySelector('.yb-official-billing')?.title,snapshots,unknown_owner_status:bad.status,host_ready:status.ready};
 });
 await page.screenshot({path:fileURLToPath(new URL('persona-status.png',folder))});
 const direct=await context.newPage();await direct.goto('http://127.0.0.1:18842/chat',{waitUntil:'domcontentloaded'});
 await direct.locator('#billing').waitFor({timeout:30000});
 await direct.waitForTimeout(1000);
 const directBilling={text:await direct.locator('#billing').innerText(),title:await direct.locator('#billing').getAttribute('title')};
 await direct.screenshot({path:fileURLToPath(new URL('new-life-status.png',folder))});
 const before=JSON.parse(await readFile(new URL('../../multi_life_supervisor/supervisor/deepseek-billing/cache.json',import.meta.url),'utf8')).refresh_count;
 const cacheLatency=await page.evaluate(async()=>{const times=[];for(let i=0;i<20;i++){const started=performance.now();const r=await fetch('/api/persona.billing?sessionId=80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b');await r.json();times.push(performance.now()-started);}return {mean_ms:times.reduce((a,b)=>a+b,0)/times.length,max_ms:Math.max(...times)};});
 const after=JSON.parse(await readFile(new URL('../../multi_life_supervisor/supervisor/deepseek-billing/cache.json',import.meta.url),'utf8')).refresh_count;
 assert(billing.snapshots.every(s=>s.status===200&&s.billing.source==='deepseek_platform'));
 assert.equal(billing.unknown_owner_status,403);assert.equal(before,after);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({selected_session:billing.selected_session,displayed:billing.displayed,snapshots:billing.snapshots}));assert(billing.displayed.includes('¥'));assert(directBilling.text.includes('¥'));
 const result={observed_at:new Date().toISOString(),installed_desktop_web_ui:true,...billing,direct_new_life:directBilling,cache_reads:20,cache_latency:cacheLatency,refresh_count_before:before,refresh_count_after:after,reads_did_not_refresh:before===after,blocked_writes:blockedWrites,page_errors:errors};
 await writeFile(new URL('renderer-validation.json',folder),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
