import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=createRequire(new URL('../package.json',import.meta.url))('playwright');
const base=resolve(import.meta.dirname,'../../..');
const auth=JSON.parse(await readFile(resolve(base,'reports/self-recovery/.desktop-auth.json'),'utf8'));
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
 let updatedClient=false;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(r.url().includes('client.js'))updatedClient ||= (await r.text().catch(()=> '')).includes('persona-recovery');});
 await page.goto(auth.url);
 const next=page.getByRole('button',{name:'继续',exact:true});if(await next.count())await next.click();
 await page.getByRole('textbox',{name:'给人格的消息'}).waitFor();
 await page.route('**/api/**',r=>r.request().method()==='GET'?r.continue():r.abort());
 const collapsed=page.getByRole('button',{name:'展开状态栏',exact:true});if(await collapsed.count())await collapsed.click();
 await page.locator('[data-testid="persona-recovery"]').waitFor({timeout:45000});
 const actual=await page.evaluate(async()=>{
  const s=await(await fetch('api/persona.status')).json();
  return {ready:s.ready,pid:s.pid,sessionId:s.sessionId,recovery:s.recovery,budgetCapEnforced:s.budget?.daily_limit_enforced};
 });
 assert(actual.ready);assert.equal(actual.budgetCapEnforced,false);assert(updatedClient);
 const statusText=await page.locator('[data-testid="persona-recovery"]').innerText();
 assert((await page.locator('body').innerText()).includes('今天按用户授权暂不拦截日上限'));
 const panel=page.locator('[data-testid="persona-diagnostic-log"]');
 await panel.locator(':scope > summary').click();
 const realFailure=panel.locator('details').filter({hasText:'HTTP 400'}).first();
 await realFailure.locator('summary').click();
 const failureLog=await realFailure.locator('pre').innerText();
 assert(failureLog.includes('供应商错误：'));assert(failureLog.includes('故障编号：'));assert(failureLog.includes('本地文件：'));
 await page.screenshot({path:resolve(base,'reports/self-recovery/desktop-live.png'),scale:'css'});
 // Render-only fixture: does not fabricate a provider failure or write a Session.
 await page.route('**/api/persona.historyState?*',async route=>{
  const response=await route.fetch(),data=await response.json();
  data.rows=[...(data.rows??[]),{id:'render-only-error',seq:999999,time:Date.now(),role:'state',
   text:'执行中断：示例诊断展示\nHTTP：400\n供应商错误：工具消息顺序不符合要求\n故障编号：render-only',diagnostic:{id:'render-only'}}];
  await route.fulfill({response,json:data});
 });
 const detail=page.locator('details').filter({hasText:'执行中断：示例诊断展示'});
 await detail.waitFor({timeout:30000});await detail.locator('summary').click();
 assert((await detail.locator('pre').innerText()).includes('HTTP：400'));
 await page.screenshot({path:resolve(base,'reports/self-recovery/desktop-error-render.png'),scale:'css'});
 assert.deepEqual(errors,[]);
 const report={passed:true,observedAt:new Date().toISOString(),actual,statusText,updatedClient,pageErrors:errors,
  realPersistedHttp400LogVisible:true,detailedErrorRenderFixture:true,realModelFailuresInjected:0,mainMessagesSubmitted:0};
 await writeFile(resolve(base,'reports/self-recovery/desktop-validation.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{await browser.close();}
