// Isolated browser against the installed Desktop; all application writes are blocked.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {connectionStatus} from './usage-adapter.mjs';
const require = createRequire(import.meta.url);
const {chromium} = createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const {url} = JSON.parse(await readFile(new URL('../../reports/digital-life/reconnect-20261005/.verify-auth.json', import.meta.url), 'utf8'));
const out = new URL('../../reports/digital-life/reconnect-20261005/', import.meta.url);
const {native_session_id:primary} = JSON.parse(await readFile(new URL('../../reports/first_native_start.json',import.meta.url),'utf8'));
const accounting = {cost_lower_nano_cny:0,cost_upper_nano_cny:0,cache_hit_rate:null,input_tokens:0,cache_coverage_complete:true};
const live = {ready:true,sessionId:primary,busy:false,activeSessionIds:[]};
const log = {sessionId:primary,rows:[{id:'isolated-test',role:'user',time:Date.now(),text:'隔离连接测试数据，未发送至正式人格。'}],
  running:false,eventCount:1,wakeups:[],accounting:{session:accounting,daily:accounting}};
const browser = await chromium.launch({headless:true, channel:'chrome'});
let writes = 0, blockedWrites = 0, offlineReads = 0, mode = 'healthy', held = 0, maxHeld = 0, offlineResponse = false;
const errors = [];
try {
  const context = await browser.newContext({viewport:{width:1280,height:850}});
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if(route.request().method() !== 'GET') { blockedWrites++; if(path.startsWith('/api/persona.')) writes++; return route.abort(); }
    if(mode !== 'healthy' && path === '/api/persona.status') {
      if(mode === 'slow') {
        held++; maxHeld = Math.max(maxHeld, held);
        await new Promise(resolve => setTimeout(resolve, 7000)); held--;
      }
      const state = mode === 'conflict' ? {state:'stopped',reason:'conflict'} : {state:'stopped'};
      const diagnostic = await connectionStatus({request:async()=>{throw new Error('Controlled isolated-browser outage');},supervisor:async()=>state});
      offlineResponse = true;
      return route.fulfill({status:200,json:diagnostic});
    }
    if(path === '/api/persona.status') offlineResponse = false;
    if(offlineResponse && ['/api/persona.tasks','/api/persona.historyState'].includes(path)) offlineReads++;
    if(path === '/api/persona.status') return route.fulfill({status:200,json:live});
    if(path === '/api/persona.tasks') return route.fulfill({status:200,json:{primary,tasks:[{sessionId:primary,primary:true,title:'隔离连接测试'}]}});
    if(path === '/api/persona.historyState') return route.fulfill({status:200,json:log});
    return route.continue();
  });
  const page = await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);
  if(await page.getByRole('button',{name:'继续',exact:true}).count()) await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.locator('[data-session-usage]').waitFor({timeout:60000});
  const initialIdentity = await page.locator('[data-session-usage]').getAttribute('data-session-usage');
  const initialRows = await page.locator('.yb-message').count(); assert(initialRows > 0);
  mode = 'stopped';
  await page.getByRole('status').filter({hasText:'人格常驻服务尚未启动'}).waitFor({timeout:45000});
  assert.equal(await page.locator('.yb-message').count(), initialRows, 'Outage preserves displayed history');
  await page.locator('.yb-root').screenshot({path:fileURLToPath(new URL('browser-outage.png',out)),scale:'css'});
  mode = 'conflict'; await page.getByRole('status').filter({hasText:'检测到旧运行环境'}).waitFor({timeout:15000});
  mode = 'slow'; await page.waitForTimeout(8500); assert.equal(maxHeld,1,'Polling never overlaps');
  mode = 'healthy'; await page.getByRole('status').filter({hasText:'人格常驻服务'}).waitFor({state:'hidden',timeout:45000});
  await page.locator('[data-session-usage]').waitFor();
  assert.equal(await page.locator('[data-session-usage]').getAttribute('data-session-usage'), initialIdentity);
  assert.equal(offlineReads,0,'No history/task reads while service is offline'); assert.equal(writes,0); assert.deepEqual(errors,[]);
  const result = {passed:true,observedAt:new Date().toISOString(),actualInstalledDesktopFrontend:true,simulatedApi:true,
    isolatedBrowser:true,simulatedOutage:true,productionHostStopped:false,modelCalls:0,personaWriteAttempts:writes,blockedNonPersonaWrites:blockedWrites-writes,
    initialIdentity,initialRows,offlineReads,maxConcurrentStatusRequests:maxHeld,pageErrors:errors,
    checks:['explicit stopped/conflict messages','cached history preserved','slow read does not multiply polling','automatic recovery preserves identity']};
  await writeFile(new URL('browser-validation.json',out),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
} finally {await browser.close();}
