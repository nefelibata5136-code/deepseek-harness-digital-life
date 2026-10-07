// Authorized real-model acceptance, ALWAYS in one newly created independent Session.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {hostRequest,projectEvents} from './transport.mjs';
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const out=new URL('../../reports/reasoning-20261006/',import.meta.url);
const observe=process.argv.includes('--observe-existing');
const finalAcceptance=process.argv.includes('--final-acceptance');
const retest=observe||process.argv.includes('--retest-after-desktop-reload');
const requestFile=new URL(finalAcceptance?'live-final-request.json':retest?'live-retest-request.json':'live-request.json',out);
if(!observe)try{await access(requestFile);throw Error('An acceptance request exists; inspect its Session/request identity, never resend automatically');}catch(e){if(e.code!=='ENOENT')throw e;}
const status=(await hostRequest('GET','/status')).value;
assert(status.ready);
const probe=await hostRequest('GET','/thinking?'+new URLSearchParams({sessionId:status.sessionId}));
assert.equal(probe.status,200,'Load thinking route before running paid acceptance');
const previous=retest||finalAcceptance?JSON.parse(await readFile(new URL('live-request.json',out),'utf8')):null;
if(previous&&!observe){const prior=await hostRequest('GET','/thinking?sessionId='+previous.sessionId);assert.equal(prior.value.state,'completed','Confirm previous request completed before a distinct verification turn');}
const admitted=observe?JSON.parse(await readFile(requestFile,'utf8')):null;
const title='思考流与工具接续验收',sessionId=previous?.sessionId??randomUUID(),requestId=admitted?.requestId??randomUUID();
if(!previous){const created=await hostRequest('POST','/tasks',{requestId:sessionId,title});
assert.equal(created.value.sessionId,sessionId);assert.equal(created.value.existing,false);}assert.notEqual(sessionId,status.sessionId);
const request={sessionId,requestId,text:'这是用户授权的独立思考展示验收，不是主对话。请在你的工作区只读执行这个小任务：先通过 read 阅读 .dsh/skills/persona-desktop-connection/SKILL.md，读完后再通过 read 阅读同目录 maintain.mjs（两个工具调用分开、顺序执行）。根据这两个文件核对维护命令的校验与恢复路径，最后回答 THINKING_ACCEPTANCE_OK 并列出三条已核实的事实，包括校验是否调用模型、版本校验如何避免覆盖、恢复如何保留历史。只做上述两次读取和最后回答；不执行命令，不改文件、核心、便签、记忆、接续条、心境或状态，不访问私人空间，不调用其他 Agent。'};
if(retest)request.text='上一条只读测试已完成，但桌面服务当时仍是旧适配器，未能验证实时显示。现在已更新服务，这是新的显示复测，请重新只读执行下面两次读取，以便观察新的 reasoning 流：\n'+request.text;
if(finalAcceptance)request.text='这是独立的思考流最终验收。上一轮只产生了62字符的 reasoning，随后模型没有再产生 reasoning，不能用它检验工具前后接续。请做一项新的只读代码审查：先通过 read 读取 .dsh/skills/persona-desktop-connection/SKILL.md（limit 45）；收到结果后，再单独通过 read 读取同目录 maintain.mjs（limit 100）。根据源码逐项审查：expected hash能防止哪类陈旧写入；读出旧内容后到rename之前若另一个进程修改文件是否有TOCTOU窗口；内容先变化再变回相同字节时hash是否能识别ABA；restore失败时旧字节和备份是否完整；哪些结论需要看更多源码才能确定。最后用 THINKING_ACCEPTANCE_OK 开头给出依据、结论和一个可审查的改进建议（只建议，不修改）。所有操作仅限上述两次顺序读取，不执行命令，不改文件、核心、记忆或任何状态，不调用其他Agent或外部服务。';
const {url}=JSON.parse(await readFile(new URL('../../reports/digital-life/reconnect-20261005/.verify-auth.json',import.meta.url),'utf8'));
const browser=await chromium.launch({headless:true,channel:'chrome'});
const samples=[],errors=[],apiUpdates=[];
let interval,pending;
try {
  const context=await browser.newContext({viewport:{width:1440,height:950},deviceScaleFactor:1.5});
  await context.route('**/api/**',route=>route.request().method()==='GET'?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async response=>{
    if(new URL(response.url()).pathname==='/api/persona.thinking'){
      const value=await response.json().catch(()=>null);
      if(value?.sessionId===sessionId)apiUpdates.push({time:Date.now(),chars:value.text.length,state:value.state,revision:value.revision,cursor:value.cursor});
    }
  });
  await page.goto(url);
  if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
  if(await page.getByRole('button',{name:'展开侧栏',exact:true}).count())await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
  await page.locator('.yb-task[data-session-id="'+sessionId+'"]').click();
  await page.waitForFunction(id=>window.__personaDesktopState?.selectedSessionId===id,sessionId);
  if(!observe)await writeFile(requestFile,JSON.stringify({...request,title,primarySessionId:status.sessionId,submittedAt:new Date().toISOString()},null,2),{flag:'wx'});
  let completed=false;
  pending=(observe?(async()=>{for(;;){const s=(await hostRequest('GET','/status')).value;if(!s.activeSessionIds.includes(sessionId))return {status:200,value:{state:'completed'}};await new Promise(r=>setTimeout(r,1000));}})():hostRequest('POST','/prompt',request)).then(async response=>{
    completed=true;
    await writeFile(new URL('live-response.json',out),JSON.stringify({status:response.status,sessionId,requestId,state:response.value.state,
      tools:response.value.tools,eventCount:response.value.eventCount,finishedAt:new Date().toISOString()},null,2));
    return response;
  });
  const details=page.locator('.yb-thinking[data-thinking-live]');
  await details.waitFor({timeout:120000});
  assert.equal(await details.getAttribute('open'),null);await details.locator('summary').click();
  let sampling=false;
  interval=setInterval(async()=>{
    if(sampling)return;sampling=true;
    try{samples.push(await page.evaluate(done=>({time:Date.now(),beforeCompletion:!done,
      chars:document.querySelector('[data-thinking-live] .yb-thinking-text')?.textContent.length??0,
      label:document.querySelector('[data-thinking-live] summary')?.textContent,tools:document.querySelectorAll('[data-call-id]').length}),completed));}
    catch{}finally{sampling=false;}
  },150);
  await page.locator('.yb-thinking-text').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-thinking-live] .yb-thinking-text')?.textContent.length>0);
  await page.screenshot({path:fileURLToPath(new URL('live-streaming.png',out)),scale:'css'});
  await details.locator('summary').click();assert.equal(await page.locator('.yb-thinking-text').count(),0);
  await details.locator('summary').click();await page.locator('.yb-thinking-text').waitFor();
  const response=await pending;clearInterval(interval);interval=null;
  assert.equal(response.status,200);assert.equal(response.value.state,'completed');
  await page.getByText('THINKING_ACCEPTANCE_OK',{exact:false}).first().waitFor({timeout:15000});
  // Allow durable history reconciliation, then compare against real channel blocks.
  await page.waitForTimeout(3000);
  const root=new URL('../native_dsh/home/sessions/',import.meta.url);
  let native;
  for(const folder of await readdir(root)){
    try{native=(await readFile(new URL(folder+'/'+sessionId+'/session.v4.jsonl',root),'utf8')).trim().split('\n').map(JSON.parse);break;}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  assert(native);assert.equal(native[0].id,sessionId);
  const lastStart=native.findLastIndex(e=>e.type==='turn/start');
  const events=native.slice(lastStart),calls=events.filter(e=>e.type==='tool/call'),assistant=events.filter(e=>e.type==='assistant/message');
  const thinking={text:projectEvents(events).rows.filter(r=>r.role==='thinking').map(r=>r.text).join('\n\n')};
  assert(thinking?.text);assert(calls.filter(e=>e.data.name==='read').length>=2);
  const beforeTool=assistant.some(e=>e.seq<calls[0].seq&&e.data.message.content.some(b=>b.type==='reasoning'));
  const afterTool=assistant.some(e=>e.seq>calls.at(-1).seq&&e.data.message.content.some(b=>b.type==='reasoning'));
  assert(beforeTool&&afterTool);
  const ui=await page.locator('.yb-thinking-text').textContent();assert.equal(ui,thinking.text,'Displayed thinking equals native reasoning channel, with only secret redaction');
  const final=projectEvents(events).rows.filter(r=>r.role==='assistant').at(-1);
  assert(final.text.includes('THINKING_ACCEPTANCE_OK'));
  assert((await page.locator('.yb-markdown').allTextContents()).some(t=>t.includes('THINKING_ACCEPTANCE_OK')));
  const growing=samples.filter(s=>s.beforeCompletion&&s.chars>0);
  assert(new Set(growing.map(s=>s.chars)).size>=3,'Real reasoning grows on screen before the turn completes');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:fileURLToPath(new URL('live-completed.png',out)),scale:'css'});
  const result={passed:true,title,sessionId,requestId,primarySessionUntouched:sessionId!==status.sessionId,
    realModel:true,installedDesktopFrontend:true,defaultCollapsed:true,collapseExpand:true,
    streamGrowthBeforeCompletion:new Set(growing.map(s=>s.chars)).size,apiThinkingUpdates:apiUpdates.length,
    reasoningBeforeTool:beforeTool,reasoningAfterTool:afterTool,toolCalls:calls.map(e=>({name:e.data.name,seq:e.seq})),
    reasoningChars:thinking.text.length,exactNativeChannelMatch:true,finalAnswerSeparate:true,pageErrors:errors,
    viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})),samples,apiUpdates};
  await writeFile(new URL('live-validation.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,samples:undefined,apiUpdates:undefined}));
}finally{clearInterval(interval);await browser.close();}
