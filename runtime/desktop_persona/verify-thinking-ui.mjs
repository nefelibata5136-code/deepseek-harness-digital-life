// Real installed Desktop frontend, isolated API fixtures; no model or real writes.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const {url}=JSON.parse(await readFile(new URL('../../reports/digital-life/reconnect-20261005/.verify-auth.json',import.meta.url),'utf8'));
const out=new URL('../../reports/reasoning-20261006/',import.meta.url);
const sessionId='f4c1f1a0-89d3-5067-8b9b-a50c49740918';
const accounting={cost_lower_nano_cny:0,cost_upper_nano_cny:0,cache_hit_rate:null,input_tokens:0,cache_coverage_complete:true};
let revision=1,text='第一段真实通道测试文本。',state='thinking',running=true,committed=false,blocked=0;
const errors=[],resources=[];
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
  const context=await browser.newContext({viewport:{width:1280,height:850},deviceScaleFactor:1.5});
  const intercept=async route=>{
    if(route.request().method()!=='GET'){blocked++;return route.abort();}
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/persona.status')return route.fulfill({json:{ready:true,activeSessionIds:running?[sessionId]:[]}});
    if(path==='/api/persona.tasks')return route.fulfill({json:{primary:sessionId,tasks:[{sessionId,primary:true,title:'思考展示隔离验收'}]}});
    if(path==='/api/persona.historyState')return route.fulfill({json:{sessionId,currentTurn:1,running,eventCount:committed?5:1,
      rows:[{id:'user',turn:1,role:'user',text:'隔离验收',time:Date.now()},...(committed?[{id:'thinking:1',role:'thinking',turn:1,text}]:[]),
        ...(!running?[{id:'final',role:'assistant',turn:1,text:'FINAL_UI_SENTINEL',time:Date.now()}]:[])],wakeups:[],accounting:{session:accounting,daily:accounting}}});
    if(path==='/api/persona.thinking')return route.fulfill({json:{sessionId,turn:1,text,state,revision,cursor:revision}});
    if(path==='/api/persona.activity')return route.fulfill({json:{events:[]}});
    return route.continue();
  };
  await context.route('**/api/**',intercept);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async response=>{if(response.url().includes('client.js')){const body=await response.text().catch(()=> '');resources.push({thinkingCode:body.includes('yb-thinking-text'),url:response.url().split('?')[0]});}});
  await page.goto(url);
  if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
  const details=page.locator('.yb-thinking[data-thinking-live]');await details.waitFor({timeout:30000});
  assert.equal(await details.getAttribute('open'),null);assert.equal(await page.locator('.yb-thinking-text').count(),0);
  await details.locator('summary').click();await page.getByText(text,{exact:true}).waitFor();
  text+='\n第二段在本轮结束前流式接上。';revision++;
  await page.getByText(text,{exact:true}).waitFor();assert(running);
  state='tools';revision++;committed=true;
  await details.locator('summary').filter({hasText:'执行工具中'}).waitFor();
  await page.waitForTimeout(3000);
  assert.notEqual(await details.getAttribute('open'),null,'Expanded state survives live-to-durable reconciliation');
  assert.equal(await details.count(),1);
  state='thinking';text+='\n工具之后继续思考。';revision++;
  await page.getByText(text,{exact:true}).waitFor();
  await details.locator('summary').click();assert.equal(await page.locator('.yb-thinking-text').count(),0);
  text+='\n收起时保留新增原文。';revision++;
  await page.waitForTimeout(600);await details.locator('summary').click();await page.getByText(text,{exact:true}).waitFor();
  // Stress the actual plain-text renderer; record frame stalls and input responsiveness.
  await page.evaluate(()=>{window.__thinkingFrames=[];let previous=performance.now();const tick=now=>{window.__thinkingFrames.push(now-previous);previous=now;window.__thinkingFrame=requestAnimationFrame(tick);};window.__thinkingFrame=requestAnimationFrame(tick);});
  const fixtureChars=200000;
  text='大量思考文本，保留原始换行。\n'.repeat(25000).slice(0,fixtureChars);revision++;
  await page.waitForFunction(expected=>document.querySelector('[data-thinking-live] .yb-thinking-text')?.textContent.length===expected,fixtureChars);
  for(let i=0;i<8;i++){text+='\n持续追加 '+i;revision++;await page.waitForTimeout(380);}
  const start=Date.now();await page.getByRole('textbox',{name:'给人格的消息'}).fill('输入仍然响应');const inputMs=Date.now()-start;
  const frames=await page.evaluate(()=>{cancelAnimationFrame(window.__thinkingFrame);return window.__thinkingFrames;});
  frames.sort((a,b)=>a-b);const p95=frames[Math.floor(frames.length*.95)],maxFrame=frames.at(-1);
  assert(inputMs<1000,'Large reasoning must not block the composer');
  running=false;state='completed';revision++;
  await page.getByText('FINAL_UI_SENTINEL',{exact:true}).waitFor({timeout:10000});
  assert(!(await details.innerText()).includes('FINAL_UI_SENTINEL'));
  await page.screenshot({path:fileURLToPath(new URL('ui-expanded.png',out)),scale:'css'});
  const viewports=[];
  for(const [width,dpr] of [[1280,1],[410,1.5]]){
    const c=await browser.newContext({viewport:{width,height:850},deviceScaleFactor:dpr});
    await c.route('**/api/**',intercept);const p=await c.newPage();await p.goto(url);
    if(await p.getByRole('button',{name:'继续',exact:true}).count())await p.getByRole('button',{name:'继续',exact:true}).click();
    await p.locator('.yb-thinking[data-thinking-live]').waitFor();
    viewports.push(await p.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth})));
    assert.equal(viewports.at(-1).overflow,false);
    await c.close();
  }
  await page.setViewportSize({width:410,height:850});await page.waitForTimeout(200);
  viewports.push(await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth})));
  await page.screenshot({path:fileURLToPath(new URL('ui-narrow.png',out)),scale:'css'});
  assert.equal(viewports[0].overflow,false);assert.deepEqual(errors,[]);assert(resources.some(r=>r.thinkingCode));
  const result={passed:true,actualInstalledFrontend:true,isolatedApiFixtures:true,modelCalls:0,blockedWrites:blocked,
    defaultCollapsed:true,streamingBeforeCompletion:true,collapseExpand:true,expandedAcrossCommit:true,toolContinuity:true,
    finalAnswerSeparate:true,fixtureChars,inputMs,p95FrameMs:p95,maxFrameMs:maxFrame,pageErrors:errors,resources,viewports};
  await writeFile(new URL('ui-validation.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
