import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const auth=JSON.parse(await readFile(new URL('../../reports/digital-life/reconnect-20261005/.verify-auth.json',import.meta.url),'utf8'));
const out=new URL('../../reports/billing-cache/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
  const context=await browser.newContext({viewport:{width:1280,height:850},deviceScaleFactor:1.5});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // All real application writes are blocked, even if triggered by startup.
  await context.route('**/api/**',route=>route.request().method()==='GET'?route.continue():route.abort());
  await page.goto(auth.url);
  if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.locator('.yb-head').waitFor();
  const api=await page.evaluate(async()=>{
    const catalog=await (await fetch('api/persona.tasks')).json();
    const histories=[];
    for(const task of catalog.tasks){
      const r=await (await fetch('api/persona.historyUsage?sessionId='+encodeURIComponent(task.sessionId))).json();
      histories.push({sessionId:r.sessionId,title:task.title,accounting:r.accounting,error:r.accountingError});
    }
    return {primary:catalog.primary,histories};
  });
  assert(api.histories.every(x=>x.accounting),'Production history API must return usage');
  const headers=[];
  for(const task of api.histories){
    await page.getByRole('button',{name:task.title,exact:true}).click();
    await page.locator('[data-session-usage="'+task.sessionId+'"]').waitFor();
    const text=await page.locator('.yb-head').innerText();
    const rate=task.accounting.session.cache_hit_rate;
    assert(text.includes(rate===null?'暂无已知输入用量':(rate*100).toFixed(2)+'%'));
    assert(text.includes('今日已知用量估算'));
    assert(!text.includes('今日已结算')&&!text.includes('已记账预算占用'));
    headers.push({sessionId:task.sessionId,text});
  }
  await page.getByRole('button',{name:api.histories.find(x=>x.sessionId===api.primary).title,exact:true}).click();
  await page.locator('[data-session-usage="'+api.primary+'"]').waitFor();
  await page.locator('.yb-head').screenshot({path:fileURLToPath(new URL('header.png',out)),scale:'css'});
  const viewports=[];
  for(const width of [1280,410]){
    await page.setViewportSize({width,height:850});
    viewports.push(await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth})));
  }
  assert(viewports.every(v=>!v.overflow));
  const standard=await browser.newContext({viewport:{width:1280,height:850},deviceScaleFactor:1});
  await standard.route('**/api/**',route=>route.request().method()==='GET'?route.continue():route.abort());
  const standardPage=await standard.newPage();
  await standardPage.goto(auth.url);
  await standardPage.locator('[data-session-usage]').waitFor();
  viewports.push(await standardPage.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth})));
  assert(viewports.every(v=>!v.overflow));
  assert.deepEqual(errors,[]);
  const result={passed:true,observedAt:new Date().toISOString(),readOnly:true,modelCalls:0,api,headers,viewports,pageErrors:errors};
  await writeFile(new URL('browser-validation.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,dialogs:headers.length,viewports,pageErrors:errors}));
} finally {await browser.close();}
