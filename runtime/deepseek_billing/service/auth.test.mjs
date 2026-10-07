import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {waitForBillingResponse} from './auth.mjs';
const {chromium}=createRequire(new URL('../../native_dsh/package.json',import.meta.url))('playwright');
test('delayed frontend redirect is reported as login expiry instead of response timeout',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.route('http://billing.test/**',route=>route.fulfill({contentType:'text/html',body:new URL(route.request().url()).pathname==='/usage'?'<script>setTimeout(()=>location.href="/sign_in",100)</script>':'Login fixture'}));
  const started=Date.now();const result=waitForBillingResponse(page,new Promise(()=>{}),{timeout:3000});result.catch(()=>{});
  await page.goto('http://billing.test/usage');await assert.rejects(result,/BILLING_LOGIN_REQUIRED/);assert(Date.now()-started<3000);
 }finally{await browser.close();}
});
