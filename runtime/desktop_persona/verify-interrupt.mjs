import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const out=new URL('../../reports/interrupt-input/',import.meta.url);
const {url}=JSON.parse(await readFile(new URL('.auth.json',out),'utf8'));
const primary='f4c1f1a0-89d3-5067-8b9b-a50c49740918',secondary='3c64cb2b-2bec-5225-b74e-05be5a10a3e0';
const browser=await chromium.launch({headless:true,channel:'chrome'});
const accounting={cost_lower_nano_cny:0,cost_upper_nano_cny:0,cache_hit_rate:null,input_tokens:0,cache_coverage_complete:true};
const calls=[],held=[],errors=[];let failCancel=false;
try{
 const context=await browser.newContext({viewport:{width:1280,height:850}});
 await context.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(request.method()==='POST'){
   const body=request.postDataJSON();if(path.startsWith('/api/persona.'))calls.push({path,body});
   if(path==='/api/persona.cancel')return route.fulfill({status:failCancel?500:200,json:failCancel?{error:'fixture cancellation rejected'}:{accepted:true}});
   if(path==='/api/persona.prompt'){await new Promise(resolve=>held.push({resolve,route,body}));return;}
   return route.abort();
  }
  if(path==='/api/persona.status')return route.fulfill({json:{ready:true,sessionId:primary,activeSessionIds:[primary],budget:{}}});
  if(path==='/api/persona.tasks')return route.fulfill({json:{primary,tasks:[{sessionId:primary,primary:true,title:'插话隔离验收'},{sessionId:secondary,title:'其它任务'}]}});
  if(path==='/api/persona.historyState')return route.fulfill({json:{sessionId:new URL(request.url()).searchParams.get('sessionId'),running:true,rows:[],eventCount:0,wakeups:[],accounting:{daily:accounting,session:accounting}}});
  if(path==='/api/persona.activity')return route.fulfill({json:{events:[]}});
  return route.continue();
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
 await page.getByRole('textbox',{name:'给人格的消息'}).waitFor({timeout:30000});
 if(await page.getByRole('button',{name:'收起状态栏',exact:true}).isVisible())await page.getByRole('button',{name:'收起状态栏',exact:true}).click();
 const input=page.getByRole('textbox',{name:'给人格的消息'}),send=page.getByRole('button',{name:'插话并继续',exact:true});
 await input.fill('第一条补充');assert(await send.isEnabled());await input.press('Enter');
 await page.waitForFunction(()=>!!window.__personaDesktopState.requests[window.__personaDesktopState.selectedSessionId]);
 await input.fill('第二条补充');assert(await send.isEnabled());await send.click();
 await page.waitForFunction(()=>window.__personaDesktopState.requests[window.__personaDesktopState.selectedSessionId]?.text==='第二条补充');
 while(held.length<2)await page.waitForTimeout(50);
 await held[0].route.fulfill({json:{state:'requires_inspection',errors:['cancelled original']}});held[0].resolve();await page.waitForTimeout(200);
 assert.equal(await page.evaluate(()=>window.__personaDesktopState.requests[window.__personaDesktopState.selectedSessionId]?.text),'第二条补充');
 assert.equal(await page.getByRole('alert').count(),0);
 await input.fill('第三条补充');await input.press('Enter');while(held.length<3)await page.waitForTimeout(50);
 assert.deepEqual(calls.slice(0,6).map(c=>c.path),Array.from({length:3},()=>['/api/persona.cancel','/api/persona.prompt']).flat());
 assert(calls.every(c=>c.body.sessionId===primary));assert.equal(new Set(held.map(x=>x.body.requestId)).size,3);
 await page.getByRole('button',{name:'停止执行',exact:true}).click();assert.equal(calls.at(-1).path,'/api/persona.cancel');
 failCancel=true;await input.fill('失败时保留草稿');await send.click();await page.getByRole('alert').waitFor();
 assert.equal(await input.inputValue(),'失败时保留草稿');assert.equal(held.length,3);
 await page.locator('.yb-root').screenshot({path:fileURLToPath(new URL('running-ui.png',out)),scale:'css'});
 for(const viewport of [{width:410,height:850},{width:1280,height:850}]){await page.setViewportSize(viewport);assert(await page.getByRole('button',{name:'停止执行',exact:true}).isVisible());}
 assert.deepEqual(errors,[]);
 const result={passed:true,observedAt:new Date().toISOString(),installedFrontend:true,isolatedApi:true,productionMessages:0,checks:['running Enter and button submissions','repeated supplements with pending POST','cancel before same Session prompt','unique request IDs','older response preserves newer request','explicit stop visible with collapsed status','cancel failure preserves draft and sends no prompt','narrow viewport controls visible'],pageErrors:errors};
 await writeFile(new URL('ui-validation.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{for(const item of held){await item.route.fulfill({json:{state:'completed'}}).catch(()=>{});item.resolve();}await browser.close();}
