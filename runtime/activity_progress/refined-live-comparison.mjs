// Same functional test, same dedicated Sessions; follow-up uses a fixed tool plan.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {hostRequest} from '../desktop_persona/transport.mjs';
import {progressInstruction,readPolicy} from './host.mjs';
const out=fileURLToPath(new URL('../../reports/activity_progress',import.meta.url));
const previous=JSON.parse(await readFile(resolve(out,'live-sessions.json'),'utf8'));
const fixture=resolve(previous.fixture,'refined');await mkdir(fixture,{recursive:true});
await writeFile(resolve(fixture,'counts.md'),'# 第二轮合成核对\n发出 53 件，已包含替换件。退回 6 件。\n','utf8');
await writeFile(resolve(fixture,'pricing.md'),'# 第二轮合成计费口径\n退回数更正为 8 件。按扣除退回的净件数计费，每件 14 元。\n','utf8');
const catalog=(await hostRequest('GET','/tasks')).value.tasks;
if(!previous.runs.every(r=>catalog.some(t=>t.sessionId===r.sessionId&&t.title===r.title)))throw Error('Dedicated Session identities changed');
const runs=previous.runs.map(r=>({...r,requestId:randomUUID()}));
await writeFile(resolve(out,'refined-sessions.json'),JSON.stringify({fixture,policy:readPolicy(),runs,startedAt:new Date().toISOString()},null,2));
console.log(JSON.stringify({event:'refined_comparison',runs}));
await Promise.all(runs.map(async run=>{
  const task=`同一功能测试的第二轮，仍在本次专用测试对话。为区分说明的影响，这轮固定工具计划：只调用 read 读取 ${fixture}/counts.md 和 ${fixture}/pricing.md，共两次 read（两个独立读取可同一条回复并行调用），不查看目录、不加载技能、不重复读取、不写文件/记忆、不调用外部服务或子Agent。核对最后应计费件数和总金额，用普通中文简短回答，并给出依据。最终不得只写进展就结束。`;
  const text=(run.enabled?progressInstruction(readPolicy()):'这组关闭中间说明；不要沿用上一轮的进展要求。')+'\n\n'+task;
  const startedAt=Date.now();const r=await hostRequest('POST','/prompt',{sessionId:run.sessionId,requestId:run.requestId,text});
  await writeFile(resolve(out,run.enabled?'refined-enabled-response.json':'refined-baseline-response.json'),JSON.stringify({sessionId:run.sessionId,enabled:run.enabled,startedAt,finishedAt:Date.now(),status:r.status,response:r.value},null,2));
  console.log(JSON.stringify({event:'refined_completed',enabled:run.enabled,status:r.status,state:r.value.state,tools:r.value.tools,text:r.value.text}));
}));
