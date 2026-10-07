// Installed frontend with recorded-shape action fixtures, no real tool executions.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const {url}=JSON.parse(await readFile(new URL('../../reports/digital-life/reconnect-20261005/.verify-auth.json',import.meta.url),'utf8'));
const sessionId='f4c1f1a0-89d3-5067-8b9b-a50c49740918',time=Date.now()-130000;
const tool=(callId,text,args,result,durationMs=180)=>({id:callId,callId,role:'tool',turn:1,text,args,detail:JSON.stringify(args),result,time,status:result===undefined?'running':'completed',durationMs:result===undefined?undefined:durationMs});
const rows=[tool('read','read',{file_path:'bridge/README.md',offset:72,limit:2},'<path>bridge/README.md</path>\n<type>file</type>\n<content>\n72: sender path\n73: bridge result\n\n(Showing lines 72-73 of 186. Use offset=74 to continue.)\n</content>'),
  tool('grep','grep',{pattern:'sender_mode',path:'bridge'},'Found 4 matches\n\nbridge/README.md:\n Line 72: sender_mode'),
  tool('capped','grep',{pattern:'overflow'},'Found 3 of 9 matches\n\nOutput retained'),
  tool('terminal','terminal',{command:'pnpm test bridge --filter sender'},JSON.stringify({returncode:0,stdout:'PASS_TEST_SENTINEL',stderr:''}),3400),
  tool('navigate','mcp__persona_browser__browser_navigate',{url:'https://docs.deepseek.com/thinking'},'{"status":"ok"}'),
  tool('click','mcp__persona_browser__browser_click',{element:'Thinking Mode',index:42},'{"status":"clicked"}'),
  tool('page','mcp__persona_browser__browser_read_page',{offset:0},'{"content":"reasoning_content"}'),
  tool('codex','subagent_codex',{prompt:'检查 Slack bridge sender path\n完整任务细节'},undefined),
  tool('unknown','read',{file_path:'missing-metadata.txt'},'No numbered content or size metadata')];
const accounting={cost_lower_nano_cny:0,cost_upper_nano_cny:0,cache_hit_rate:null,input_tokens:0,cache_coverage_complete:true};
const errors=[],browser=await chromium.launch({headless:true,channel:'chrome'});
try {
  const context=await browser.newContext({viewport:{width:1440,height:950},deviceScaleFactor:1.5});
  await context.route('**/api/**',route=>{
    if(route.request().method()!=='GET')return route.abort();
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/persona.status')return route.fulfill({json:{ready:true,activeSessionIds:[sessionId]}});
    if(path==='/api/persona.tasks')return route.fulfill({json:{primary:sessionId,tasks:[{sessionId,primary:true,title:'动作详情隔离验收'}]}});
    if(path==='/api/persona.historyState')return route.fulfill({json:{sessionId,currentTurn:1,running:true,rows,eventCount:20,wakeups:[],accounting:{session:accounting,daily:accounting}}});
    if(path==='/api/persona.activity')return route.fulfill({json:{events:[]}});
    if(path==='/api/persona.thinking')return route.fulfill({json:{sessionId,turn:1,text:'',state:'tools'}});
    return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
  if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
  const cards=page.locator('.yb-action-card');await cards.first().waitFor();assert.equal(await cards.count(),rows.length);
  const summary=id=>page.locator('[data-call-id="'+id+'"] > summary');
  assert((await summary('read').innerText()).includes('第 72–73 行'));
  assert((await summary('read').innerText()).includes('返回正文'));
  assert((await summary('grep').innerText()).includes('返回 4 处匹配'));
  assert((await summary('capped').innerText()).includes('共 9 处'));
  assert((await summary('terminal').innerText()).includes('exit 0'));
  assert((await summary('terminal').innerText()).includes('3.40 s'));
  assert((await summary('navigate').innerText()).includes('https://docs.deepseek.com/thinking'));
  assert((await summary('click').innerText()).includes('Thinking Mode'));
  assert((await summary('page').innerText()).includes('读取页面'));
  assert((await summary('codex').innerText()).includes('启动 Codex 子任务'));
  assert((await summary('codex').innerText()).includes('运行中 2 分'));
  assert(!(await summary('unknown').innerText()).includes(' KB'));
  const card=page.locator('[data-call-id="terminal"]');assert.equal(await card.getAttribute('open'),null);
  await summary('terminal').click();await card.getByText('PASS_TEST_SENTINEL',{exact:false}).waitFor();
  assert.equal(await card.locator('pre').nth(0).textContent(),rows[3].detail);
  assert.equal(await card.locator('pre').nth(1).textContent(),rows[3].result);
  await page.screenshot({path:fileURLToPath(new URL('../../reports/reasoning-20261006/actions-expanded.png',import.meta.url)),scale:'css'});
  await summary('terminal').click();assert.equal(await card.getAttribute('open'),null);
  assert.deepEqual(errors,[]);
  const report={passed:true,actualInstalledFrontend:true,isolatedApiFixtures:true,realToolExecutions:0,visibleActionCards:rows.length,
    readActualReturnedLines:true,returnedBodyBytesLabeled:true,searchCountAndCap:true,commandExitAndDuration:true,
    browserActions:true,codexTaskAndElapsed:true,unknownMetadataNotInvented:true,fullArgumentsAndResults:true,pageErrors:errors};
  await writeFile(new URL('../../reports/reasoning-20261006/actions-validation.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
