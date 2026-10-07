import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('../../native_dsh/package.json',import.meta.url))('playwright');
let context;
try{
 context=await chromium.launchPersistentContext(process.env.LOCALAPPDATA+'/PersonaHost/DeepSeekBillingBrowser/deepseek-billing-profile',{channel:'chrome',headless:true});
 const page=context.pages()[0];const counts={requests:0,cost_requests:0,cost_responses:0,failed_requests:0};const failures=new Set();
 page.on('request',r=>{counts.requests++;if(new URL(r.url()).pathname==='/api/v0/usage/by_api_key/cost')counts.cost_requests++;});
 page.on('response',r=>{if(new URL(r.url()).pathname==='/api/v0/usage/by_api_key/cost')counts.cost_responses++;});
 page.on('requestfailed',r=>{counts.failed_requests++;failures.add(r.failure()?.errorText?.match(/net::[A-Z_]+/)?.[0]??'NETWORK_FAILURE');});
 let status;try{status=(await page.goto('https://platform.deepseek.com/usage',{waitUntil:'domcontentloaded',timeout:20000})).status();}catch{status='NAVIGATION_FAILED';}
 await page.waitForTimeout(8000);
 const signs=await page.evaluate(()=>{const s=document.body.innerText;return {login:/登录|sign in|log in/i.test(s),verification:/captcha|人机|验证您|checking your browser/i.test(s),usage:/消费金额|用量|Usage/i.test(s),blank:s.trim().length===0};});
 console.log(JSON.stringify({status,path:new URL(page.url()).pathname,...counts,failures:[...failures],signs}));
}catch{console.log(JSON.stringify({error:'BILLING_DIAGNOSTIC_BROWSER_UNAVAILABLE',note:'先停止唯一 producer 再运行诊断，不与常驻 profile 并发。'}));process.exitCode=1;}
finally{await context?.close().catch(()=>{});}
