import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {hostRequest} from './usage-adapter.mjs';
const folder=new URL('../../reports/digital-life/reconnect-20261005/',import.meta.url);
const record=new URL('persona-acceptance-followup-request.json',folder);
try {await readFile(record);throw new Error('Follow-up already submitted: inspect receipt, never replay.');}
catch(error){if(error.code!=='ENOENT')throw error;}
const request={requestId:randomUUID(),text:'连接修复验收的后续：你刚才发现的源码 EPERM 和子进程 spawn EPERM 已作兼容修复。控制侧已用与你当前 terminal 相同的受限令牌实测 check 成功，但仍请你本人验收。请重新读 .dsh/skills/persona-desktop-connection/SKILL.md，再实际运行 node --preserve-symlinks --preserve-symlinks-main .dsh/skills/persona-desktop-connection/maintain.mjs check，可同时用 list 确认源码可读。请报告真实结果和仍存在的问题；不要为了验收修改身份、长期记忆、接续或心境，不访问私人区域。用户另有 Agent 正在开放你的完整访问权限，本修复不替它决定权限策略。检查完成且所有回合空闲后，控制侧会正常重启原 Host 加载已离线验证的异步备份改动。请区分你实际跑过的检查与控制侧证据，允许指出未验收部分。此消息是修复后的一次明确复测，不是自动重发旧消息。'};
await writeFile(record,JSON.stringify({...request,submittedAt:new Date().toISOString()},null,2),{flag:'wx'});
const response=await hostRequest('POST','/prompt',request);
await writeFile(new URL('persona-acceptance-followup-response.json',folder),JSON.stringify({requestId:request.requestId,observedAt:new Date().toISOString(),status:response.status,...response.value},null,2));
console.log(JSON.stringify({status:response.status,requestId:request.requestId,state:response.value.state}));
