import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const out=new URL('../../reports/steering-fix/',import.meta.url),{url}=JSON.parse(await readFile(new URL('.auth.json',out),'utf8'));
const primary='f4c1f1a0-89d3-5067-8b9b-a50c49740918';let supported=true,running=false;
const calls=[],errors=[],accounting={cost_lower_nano_cny:0,cost_upper_nano_cny:0,cache_hit_rate:null,input_tokens:0,cache_coverage_complete:true};
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const context=await browser.newContext({viewport:{width:1280,height:850}});
 await context.route('**/api/**',async route=>{
  const r=route.request(),p=new URL(r.url()).pathname;
  if(r.method()==='POST'){
   if(!p.startsWith('/api/persona.'))return route.abort();
   const body=r.postDataJSON();calls.push({p,body});
   if(p==='/api/persona.prompt')return route.fulfill({json:{state:body.mode==='steer'?'accepted':'completed',requestId:body.requestId,sessionId:body.sessionId}});
   if(p==='/api/persona.cancel')return route.fulfill({json:{accepted:true}});
   return route.abort();
  }
  if(p==='/api/persona.status')return route.fulfill({json:{ready:true,sessionId:primary,activeSessionIds:running?[primary]:[],inputCapabilities:{steer:supported}}});
  if(p==='/api/persona.tasks')return route.fulfill({json:{primary,tasks:[{sessionId:primary,primary:true,title:'原生插话隔离验收'}]}});
  if(p==='/api/persona.historyState')return route.fulfill({json:{sessionId:primary,running,eventCount:0,rows:[],wakeups:[],accounting:{session:accounting,daily:accounting}}});
  if(p==='/api/persona.activity')return route.fulfill({json:{events:[]}});
  return route.continue();
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
 if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
 const input=page.getByRole('textbox',{name:'给人格的消息'});await input.waitFor({timeout:30000});
 for(const text of ['补充一','补充二','补充三']){await input.fill(text);await input.press('Enter');await page.waitForFunction(()=>!window.__personaDesktopState.requests[window.__personaDesktopState.selectedSessionId]);}
 assert.equal(calls.length,3);assert(calls.every(c=>c.p==='/api/persona.prompt'&&c.body.mode==='steer'&&c.body.sessionId===primary));
 assert.equal(new Set(calls.map(c=>c.body.requestId)).size,3);assert.equal(await page.getByRole('alert').count(),0);
 running=true;await page.getByRole('button',{name:'停止执行',exact:true}).waitFor({timeout:10000});
 await page.getByRole('button',{name:'停止执行',exact:true}).click();assert.equal(calls.at(-1).p,'/api/persona.cancel');
 supported=false;await page.getByRole('button',{name:'排队发送',exact:true}).waitFor({timeout:10000});
 await input.fill('旧Host不自动取消');await input.press('Enter');await page.waitForFunction(()=>!window.__personaDesktopState.requests[window.__personaDesktopState.selectedSessionId]);
 assert.equal(calls.at(-1).body.mode,'queue');assert.equal(calls.filter(c=>c.p==='/api/persona.cancel').length,1);
 assert.deepEqual(errors,[]);
 const result={passed:true,observedAt:new Date().toISOString(),installedFrontend:true,isolatedApis:true,steeringSupplements:3,staleIdlePollDoesNotForceNextTurnQueue:true,automaticCancels:0,explicitStopCancels:1,oldHostFallback:'queue',acceptedReceiptDoesNotClaimCompletion:true,pageErrors:errors,productionMessages:0};
 await writeFile(new URL('ui-validation.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
