// Reads the actual installed Desktop APIs; blocks all application writes.
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const folder=new URL('../../reports/digital-life/reconnect-20261005/',import.meta.url);
const {url}=JSON.parse(await readFile(new URL('.verify-auth.json',folder),'utf8'));
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
  const context=await browser.newContext();
  let blockedWrites=0;
  await context.route('**/api/**',route=>{if(route.request().method()==='GET')return route.continue();blockedWrites++;return route.abort();});
  const page=await context.newPage();
  await page.goto(url);
  if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.locator('.yb-root').waitFor({timeout:30000});
  const api=await page.evaluate(async()=>{
    const response=await fetch('/api/persona.status');
    const value=await response.json();
    const result={status:response.status,transportVersion:response.headers.get('x-persona-transport-version'),
      ready:value.ready,hostPid:value.pid,sessionId:value.sessionId,busy:value.busy,connection:value.connection};
    if(value.ready){
      const tasks=await(await fetch('/api/persona.tasks')).json();
      const history=await(await fetch('/api/persona.historyState?sessionId='+encodeURIComponent(value.sessionId))).json();
      result.primary=tasks.primary;result.taskCount=tasks.tasks.length;result.historyRows=history.rows.length;
    }
    return result;
  });
  const result={observedAt:new Date().toISOString(),actualInstalledDesktopApis:true,readOnly:true,modelCalls:0,blockedWrites,...api};
  await writeFile(new URL('desktop-api-final.json',folder),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}catch {
  console.error('Read-only Desktop check unavailable; inspect local startup state. Authentication URL is withheld.');
  process.exitCode=1;
}finally{await browser.close();}
