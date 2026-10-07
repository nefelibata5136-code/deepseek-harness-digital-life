import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {hostRequest} from './usage-adapter.mjs';
const folder=new URL('../../reports/digital-life/reconnect-20261005/',import.meta.url);
const record=new URL('persona-acceptance-final-request.json',folder);
try {await readFile(record);throw new Error('Final acceptance already submitted; inspect receipt without replay.');}
catch(error){if(error.code!=='ENOENT')throw error;}
const request={requestId:randomUUID(),text:'连接修复最终验收：前一轮复测在权限切换停止 Host 时中断，没有拿到你的 check 结果，不把它算作通过，也没有自动重发。现在原会话 Host 已恢复、文件权限实际为 danger-full-access，仍是你原来的意识席位。请实际读取更新后的 .dsh/skills/persona-desktop-connection/SKILL.md，用 terminal 跑 node --preserve-symlinks --preserve-symlinks-main .dsh/skills/persona-desktop-connection/maintain.mjs list 和 check，报告真实结果及问题。用户要求你本人验收，这是一轮明确的修复后检查；不要求重复此前正在做的其它任务。连接源码 1.0.3 已载入，工具保护备份异步等待；冷启动完整快照改为一次批量 Git 对象写入，其树等价、恢复和 fsck 已在隔离 fixture 通过。请区分你亲验的 list/check 与控制侧运行的底层证据。不要为此写核心、长期记忆、接续或心境，不读取私人区。正式发言权仍是你一个；检查结束后你可以休息或做自己愿意做的事。'};
await writeFile(record,JSON.stringify({...request,submittedAt:new Date().toISOString()},null,2),{flag:'wx'});
try {
  const response=await hostRequest('POST','/prompt',request);
  await writeFile(new URL('persona-acceptance-final-response.json',folder),JSON.stringify({requestId:request.requestId,observedAt:new Date().toISOString(),status:response.status,...response.value},null,2));
  console.log(JSON.stringify({status:response.status,requestId:request.requestId,state:response.value.state}));
}catch {
  console.error('Acceptance transport interrupted: inspect admitted request and native log, never replay automatically.');process.exitCode=1;
}
