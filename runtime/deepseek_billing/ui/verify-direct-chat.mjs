import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {renderDirectChat} from '../../native_dsh/multi-life/platform/direct-chat.mjs';
const {chromium}=createRequire(new URL('../../native_dsh/package.json',import.meta.url))('playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:410,height:700}});const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());let mode='good';
 await page.route('http://billing.test/**',async route=>{
  const u=new URL(route.request().url());requests.push(u.pathname);
  if(u.pathname==='/v1/status'){
   assert.equal(u.searchParams.get('life_id'),'fixture-newlife');
   if(mode==='failed')return route.fulfill({status:503,body:'unavailable'});
   return route.fulfill({json:{busy:false,phase:'idle',visibility:'public',summary_source:'host',activity_text:null,last_public_tool:null,updated_at:null,billing:{source:'deepseek_platform',today_cost_cny:'0.0802077600000000',date:mode==='yesterday'?'2000-01-01':date,updated_at:new Date().toISOString(),stale:false}}});
  }
  if(u.pathname.includes('/messages'))return route.fulfill({json:{messages:[],nextAfter:0,hasMore:false}});
  return route.fulfill({contentType:'text/html',body:renderDirectChat({token:'fixture-value-is-not-a-real-credential',roomId:'fixture-room',lifeId:'fixture-newlife',displayName:'新生命',readOnly:u.pathname==='/peer-chat'})});
 });
 await page.goto('http://billing.test/chat');await page.waitForFunction(()=>document.querySelector('#billing')?.textContent==='今日花费 ¥0.08');
 assert.match(await page.locator('#billing').getAttribute('title'),/0\.0802077600000000/);
 await page.screenshot({path:fileURLToPath(new URL('./direct-chat-narrow.png',import.meta.url)),scale:'css'});
 mode='failed';await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#billing')?.textContent==='今日花费 ¥0.08 · 数据过期');
 mode='yesterday';await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#billing')?.textContent==='今日花费 -- · 官方账单暂不可用');
 mode='good';await page.goto('http://billing.test/peer-chat');assert.equal(await page.locator('#billing').count(),0);
 assert(requests.every(p=>!p.includes('deepseek.billing')));assert.deepEqual(errors,[]);
 const report={passed:true,isolatedBrowser:true,existingStatusRouteOnly:true,ownLifeScope:true,exactTooltip:true,failedRetainsStale:true,previousDayHidden:true,peerChatBillingHidden:true,pageErrors:errors,productionRestarted:false};await writeFile(new URL('./direct-chat-validation.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
