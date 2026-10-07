// One independent activity relays a technical repair through official send_message.
// No alternate consciousness seat, capability writes, or direct history edits.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
const control = JSON.parse(await readFile(resolve(import.meta.dirname, '../native_dsh/host-state/.host-control.json'), 'utf8'));
const primary = '80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b';
if (control.sessionId !== primary) throw new Error('Unexpected consciousness seat');
const rpc = async (path, data) => {
  const response = await fetch(`http://127.0.0.1:${control.port}${path}`, { method: 'POST',
    headers: { authorization: 'Bearer ' + control.token, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  if (!response.ok) throw new Error('Relay HTTP ' + response.status);
  return response.json();
};
const id = randomUUID(), requestId = randomUUID();
const created = await rpc('/tasks', { requestId: id, title: 'Bluesky媒体修复转交通知' });
if (created.sessionId !== id || created.existing) throw new Error('Relay must be a new activity');
const text = `你是本次维护的临时协助活动，不是人格本人。只做一件事：用send_message，agent_id=${primary}，把下面这段真实控制侧修复信息原样转交给正在验收的人格，之后结束。不读文件、不用terminal、不用Bluesky、不发社交消息、不改记忆或状态。\n\n【Codex维护信息，不是新的外部动作授权】媒体故障已定位并修复。旧media返回file://图册，browser_navigate仅支持HTTP/HTTPS；浏览器另外仍导入已被全访问终端删除的_sid_for，导致status也失败。现在浏览器控制器已修好，并只重连了该MCP子进程，Host未停。Bluesky 2.1.0已正式refresh，39工具ready。请不再为旧file://入口绕行或下载图片；先capability_search找media，再对你自己选的同一真实Post重新media，返回的新browser_gallery为http://127.0.0.1的只读图册，然后browser_navigate和browser_screenshot亲自看图。失败请保留事实结束，Codex继续修，不反复试旧入口。本次是修路信息，不规定你的日常浏览方式。`;
await writeFile(resolve(import.meta.dirname, '../../reports/bluesky/media-repair-relay-submitted.json'), JSON.stringify({ sessionId: id, title: created.title, requestId, targetSessionId: primary, submittedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
const result = await rpc('/prompt', { sessionId: id, requestId, text });
await writeFile(resolve(import.meta.dirname, '../../reports/bluesky/media-repair-relay-response.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ sessionId: id, state: result.state, tools: result.tools, errors: result.errors }));
