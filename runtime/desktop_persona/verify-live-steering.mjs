// Actual installed Desktop endpoints. Block application POSTs; never send a prompt.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const out=new URL('../../reports/steering-fix/',import.meta.url),{url}=JSON.parse(await readFile(new URL('.auth.json',out),'utf8'));
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const context=await browser.newContext();await context.route('**/api/**',r=>r.request().method()==='GET'?r.continue():r.abort());
 const page=await context.newPage();const errors=[];let newClient=false;
 page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(r.url().includes('client.js'))newClient||=(await r.text().catch(()=>'' )).includes("mode=status?.inputCapabilities?.steer?'steer':'queue'");});
 await page.goto(url);if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
 await page.getByRole('textbox',{name:'给人格的消息'}).waitFor({timeout:30000});
 const live=await page.evaluate(async()=>{const r=await fetch('api/persona.status'),s=await r.json();return {httpStatus:r.status,ready:s.ready,pid:s.pid,sessionId:s.sessionId,inputCapabilities:s.inputCapabilities};});
 assert.equal(live.httpStatus,200);assert.equal(live.ready,true);assert.equal(live.inputCapabilities?.steer,true);assert(newClient);
 assert.deepEqual(errors,[]);const result={passed:true,observedAt:new Date().toISOString(),actualInstalledDesktop:true,actualHostReadback:true,newClientLoaded:true,productionMessages:0,readOnly:true,...live};
 await writeFile(new URL('desktop-live-validation.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
