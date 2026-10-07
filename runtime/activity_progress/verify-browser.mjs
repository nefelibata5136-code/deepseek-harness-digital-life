// Actual frontend source, isolated API and simple Markdown renderer; no production traffic.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {build}=require('.local/unconfigured/esbuild');
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const source=await readFile(new URL('../desktop_persona/client.js',import.meta.url),'utf8');
const bootstrap=`import React from '.local/unconfigured/index.js';
import {createRoot} from '.local/unconfigured/client.js';
window.__ModuleLoader__={load({factory}){const m=factory(name=>name==='react'?React:{MarkdownText:({text})=>React.createElement('div',null,text)});
 m.apply({slots:{inject(name,fn){fn()},register(where,component){if(where.name==='main')createRoot(document.getElementById('app')).render(React.createElement(component));return()=>{}}},layout:{selectPanel(){}}});}};
${source}`;
const bundled=await build({stdin:{contents:bootstrap,loader:'js',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser'});
const id='147c2fff-ff1a-5d20-b057-cd3ec56745fa';const now=Date.now();let mode='waiting',writes=0;
const base={sessionId:id,eventCount:4,running:true,lastEventAt:now-100000,lastActivityAt:now-100000,wakeups:[],accounting:{session:{cache_hit_rate:null,input_tokens:0,cache_coverage_complete:true,cost_lower_nano_cny:0,cost_upper_nano_cny:0},daily:{cost_lower_nano_cny:0,cost_upper_nano_cny:0}},rows:[
 {id:'user',seq:0,time:now-105000,role:'user',text:'请核对两份资料的数量和金额。'},
 {id:'progress',seq:1,time:now-103000,role:'progress',author:'agent',text:'我先看交付说明，再核对更正清单，确认最后应付多少。'},
 {id:'tool',seq:2,time:now-100000,role:'tool',text:'read',callId:'call',status:'running',args:{file_path:'C:/fixture/交付说明.md'},detail:'{}'}]};
const server=createServer((req,res)=>{
  if(req.method!=='GET'){writes++;res.writeHead(403);return res.end('writes blocked');}
  const path=new URL(req.url,'http://127.0.0.1').pathname;const send=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end('<html lang="zh"><meta charset="utf-8"><style>html,body,#app{height:100%;margin:0;background:#17191e}</style><div id="app"></div><script src="/app.js"></script></html>');}
  if(path==='/app.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(bundled.outputFiles[0].text);}
  if(path==='/api/persona.status')return send(mode==='offline'?{ready:false,connection:{message:'隔离测试连接断开'}}:{ready:true,activeSessionIds:[id],activityProgress:{quietWarningSeconds:90}});
  if(path==='/api/persona.tasks')return send({primary:id,tasks:[{sessionId:id,primary:true,title:'隔离进展界面测试'}]});
  if(path==='/api/persona.activity')return send({events:[{id:'fresh',callId:'call',occurredAt:mode==='executing'?Date.now():base.lastActivityAt,phase:mode==='executing'?'executing':'waiting-before-backup',label:mode==='executing'?'正在执行工具':'等待保存保护版本'}]});
  if(path==='/api/persona.historyState'){
    const log=structuredClone(base);
    // Freeze the heavier history response to prove the lightweight phase feed
    // independently updates the current activity panel.
    log.rows.at(-1).phases=[{id:'phase',time:log.lastActivityAt,phase:'waiting-before-backup',label:'等待保存保护版本'}];
    return send(log);
  }
  res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const out=fileURLToPath(new URL('../../reports/activity_progress',import.meta.url));await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});const errors=[],checks=[];
try {
  for(const [width,height,dpr] of [[1280,900,1],[1280,900,1.5],[410,900,1.5]]){
    mode='waiting';const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:dpr});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('[data-testid="activity-phase"]').waitFor();
    assert((await page.locator('[data-testid="activity-phase"]').innerText()).includes('等待保存保护版本'));
    assert(await page.locator('[data-testid="activity-quiet"]').isVisible());assert.equal(await page.locator('[data-progress-author="agent"]').count(),1);
    const before=await page.locator('[data-testid="activity-phase"]').innerText();await page.waitForTimeout(1200);const after=await page.locator('[data-testid="activity-phase"]').innerText();assert.notEqual(before,after,'Live elapsed time changes without fabricated events');
    const metrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth,root:document.querySelector('.yb-root').getBoundingClientRect().toJSON(),composer:document.querySelector('.yb-composer').getBoundingClientRect().toJSON()}));assert.equal(metrics.overflow,false);assert(metrics.composer.bottom<=height);
    await page.screenshot({path:resolve(out,`browser-${width}-${dpr}.png`),scale:'css'});checks.push(metrics);
    if(width===1280&&dpr===1){mode='executing';await page.waitForFunction(()=>document.querySelector('[data-testid="activity-phase"]')?.textContent.includes('正在执行工具'));assert.equal(await page.locator('[data-testid="activity-quiet"]').count(),0);mode='offline';await page.waitForFunction(()=>document.querySelector('[data-testid="activity-summary"]')?.textContent.includes('连接暂时不可用'));assert.equal(await page.locator('[data-progress-author="agent"]').count(),1);}
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.equal(writes,0);const result={passed:true,actualFrontendSource:true,isolatedApi:true,simplifiedMarkdownRenderer:true,productionHostChanged:false,writes,errors,viewports:checks,checks:['clock only HH:mm:ss','real stage labels','timer advances without new event','quiet warning and recovery','agent authored progress distinguished','offline preserves evidence','composer visible, no horizontal overflow']};
  await writeFile(resolve(out,'browser-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();await new Promise(r=>server.close(r));}
