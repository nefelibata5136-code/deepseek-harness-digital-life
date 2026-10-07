// Paid functional check, explicitly requested; only newly named test Sessions.
import {hostRequest} from '../desktop_persona/transport.mjs';
import {progressInstruction,readPolicy} from './host.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const report=fileURLToPath(new URL('../../reports/activity_progress',import.meta.url));
const fixture='.local/workspace/development/experiments/activity-progress-20261005';
await mkdir(fixture,{recursive:true});await mkdir(report,{recursive:true});
await writeFile(resolve(fixture,'delivery.md'),'# 测试资料，非真实生活记录\n计划发出 40 件。退回 3 件。\n核对说明见同目录 adjustments.md。\n','utf8');
await writeFile(resolve(fixture,'adjustments.md'),'# 测试核对说明\n发出数量 40 已含替换件，不能再加 2。退回数应更正为 4 件，旧 3 件是初稿。每件 12 元。\n','utf8');
const runs=[];
for(const enabled of [false,true]) {
  const sessionId=randomUUID(),title=enabled?'进展说明对照：开启自述':'进展说明对照：关闭自述';
  const created=await hostRequest('POST','/tasks',{requestId:sessionId,title});
  if(created.status!==200||created.value.sessionId!==sessionId||created.value.existing)throw Error('Fresh test Session identity not confirmed');
  runs.push({sessionId,title,enabled,requestId:randomUUID()});
}
await writeFile(resolve(report,'live-sessions.json'),JSON.stringify({createdAt:new Date().toISOString(),fixture,runs},null,2));
console.log(JSON.stringify({event:'fresh_test_sessions',runs}));
await Promise.all(runs.map(async run=>{
  const task=`这是独立功能测试，对话「${run.title}」，不是主对话。目的：检验进展说明是否影响资料核对。只读合成测试文件，不写记忆/心境、不调用外部服务或子Agent。实际先读 ${fixture}/delivery.md，再按其中线索读 adjustments.md，核对最终净件数与总金额。最终答复须说明更正数值和依据，并自评中间说明是否分散精力（自评不当作客观测量）。`;
  const text=run.enabled?progressInstruction(readPolicy())+'\n\n'+task:'本对照组关闭中间进展说明，请直接执行必要读取，完成后统一回答。\n\n'+task;
  const start=Date.now();console.log(JSON.stringify({event:'submitting',title:run.title,sessionId:run.sessionId}));
  const r=await hostRequest('POST','/prompt',{sessionId:run.sessionId,requestId:run.requestId,text});
  await writeFile(resolve(report,run.enabled?'live-enabled-response.json':'live-baseline-response.json'),JSON.stringify({sessionId:run.sessionId,title:run.title,enabled:run.enabled,startedAt:start,finishedAt:Date.now(),status:r.status,response:r.value},null,2));
  console.log(JSON.stringify({event:'completed',sessionId:run.sessionId,status:r.status,state:r.value.state,tools:r.value.tools,text:r.value.text}));
}));
