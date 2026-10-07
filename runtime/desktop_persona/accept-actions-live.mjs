// Authorized, small read-only action acceptance in its own new Session.
import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {hostRequest} from './transport.mjs';
const out=new URL('../../reports/reasoning-20261006/',import.meta.url);
const path=new URL('actions-live-request.json',out);
try{await access(path);throw Error('Existing action request; inspect original Session, never resubmit automatically');}catch(e){if(e.code!=='ENOENT')throw e;}
const primary=(await hostRequest('GET','/status')).value.sessionId;
const reserved=JSON.parse(await readFile(new URL('actions-session.json',out),'utf8'));
const sessionId=reserved.sessionId,requestId=randomUUID(),title='动作卡片只读验收';
const catalog=(await hostRequest('GET','/tasks')).value;
assert(catalog.tasks.some(t=>t.sessionId===sessionId&&t.title===title));assert.notEqual(sessionId,primary);
const request={sessionId,requestId,text:'这是用户授权的独立动作展示验收，不是主对话。请只执行两个只读工具步骤：1. 用 read 读取你工作区 .dsh/skills/persona-desktop-connection/SKILL.md 的第1–20行（offset=1, limit=20）。2. 读完后用 terminal 执行 node --version。最后简短回答 ACTION_ACCEPTANCE_OK 并确认实际Node版本。不要修改文件、核心、便签、记忆、心境或设置，不访问私人空间或外部服务，不调用其他 Agent，不做这两步以外的工具操作。'};
const {url}=JSON.parse(await readFile(new URL('../../reports/digital-life/reconnect-20261005/.verify-auth.json',import.meta.url),'utf8'));
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});let pending;
try {
  const context=await browser.newContext({viewport:{width:1440,height:950},deviceScaleFactor:1.5});
  await context.route('**/api/**',r=>r.request().method()==='GET'?r.continue():r.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.locator('.yb-task[data-session-id="'+sessionId+'"]').click();
  await writeFile(path,JSON.stringify({...request,title,primary,submittedAt:new Date().toISOString()},null,2),{flag:'wx'});
  pending=hostRequest('POST','/prompt',request);
  const response=await pending;
  await writeFile(new URL('actions-live-response.json',out),JSON.stringify({status:response.status,state:response.value.state,sessionId,requestId,tools:response.value.tools},null,2));
  assert.equal(response.status,200);assert.equal(response.value.state,'completed');
  const cards=page.locator('.yb-action-card');await cards.first().waitFor({timeout:20000});
  await page.waitForFunction(()=>[...document.querySelectorAll('.yb-action-card > summary')].some(s=>s.textContent.includes('exit 0')),{timeout:15000});
  const read=cards.filter({hasText:'读取文件'}).first(),command=cards.filter({hasText:'执行命令'}).first();
  const readSummary=await read.locator('summary').first().innerText(),commandSummary=await command.locator('summary').first().innerText();
  assert(readSummary.includes('第 1–20 行'));assert(readSummary.includes('返回正文'));assert(commandSummary.includes('node --version'));assert(commandSummary.includes('exit 0'));
  await command.locator('summary').first().click();
  const result=await command.locator('pre').nth(1).textContent();const parsed=JSON.parse(result);assert.equal(parsed.returncode,0);assert(/v\d+\.\d+\.\d+/.test(parsed.stdout));
  assert.deepEqual(errors,[]);
  await page.screenshot({path:fileURLToPath(new URL('actions-live.png',out)),scale:'css'});
  const report={passed:true,title,sessionId,requestId,primaryUntouched:sessionId!==primary,realModel:true,installedDesktopFrontend:true,
    actualToolCalls:response.value.tools,readSummary,commandSummary,fullResultExpanded:true,nodeVersion:parsed.stdout.trim(),pageErrors:errors};
  await writeFile(new URL('actions-live-validation.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
