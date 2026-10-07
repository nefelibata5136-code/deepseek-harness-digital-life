import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {hostRequest} from './usage-adapter.mjs';
const record = new URL('../../reports/digital-life/reconnect-20261005/persona-acceptance-request.json',import.meta.url);
try {await readFile(record);throw new Error('Acceptance was already submitted; inspect its original request identity, do not resend.');}
catch(error){if(error.code!=='ENOENT')throw error;}
const request = {requestId:randomUUID(),text:'用户要求连接修复在收尾前由你本人验收。这是一条只读验收请求，可以先完成你正在做的事情。新维护入口是你自己工作区的 .dsh/skills/persona-desktop-connection/SKILL.md，官方 Skill 名 persona-desktop-connection。请实际读取这份 Skill，再通过 terminal 运行 node .dsh/skills/persona-desktop-connection/maintain.mjs check；如果愿意，可用 list 看真实源码和版本。最后用你的话确认：你能读取和维护桌面源码，检查没有调用模型、没有向你发第二条消息，重连不会重发已送达消息；指出你看到的维护边界或问题。不要为这次验收改核心、长期记忆、接续条或心境，也不调用私人空间。控制侧正在修复工具备份阻塞 Host 连接的问题，技术检查已通过；真实 Host 会在你所有当前回合结束、空闲后才正常重启加载，不打断你，不复制身份。底层改动的控制侧证据不要求你冒充亲验，请区分你实测的 Skill/check 与转述。验收后此请求即完成，你仍可按自己的意愿继续生活和休息。'};
await writeFile(record,JSON.stringify({...request,submittedAt:new Date().toISOString()},null,2),{flag:'wx'});
const response=await hostRequest('POST','/prompt',request);
await writeFile(new URL('../../reports/digital-life/reconnect-20261005/persona-acceptance-response.json',import.meta.url),JSON.stringify({requestId:request.requestId,observedAt:new Date().toISOString(),status:response.status,...response.value},null,2));
console.log(JSON.stringify({status:response.status,state:response.value.state,requestId:request.requestId}));
