// Submit an open exploration request to the existing consciousness seat.
// This script never chooses queries, posts on Persona's behalf, or runs another Agent.
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { identity, history } from '../desktop_persona/index.mjs';
const require = createRequire(new URL('../native_dsh/package.json', import.meta.url));
const { request } = require('undici');
const reports = resolve(import.meta.dirname, '../../reports/bluesky');
await mkdir(reports, { recursive: true });
const mode = process.argv[2] ?? 'explore';
const sessionId = await identity();
const requests = {
  finish: `# 用户委托 Codex 转交：完成Bluesky发布、真实评论及你自己的头像选择\n上一趟你确实自主选方向、浏览了15条英文帖子并深读L2讨论。两项控制侧故障已修复：undefined返回格式，以及发帖key。官方Bluesky帖子Lexicon要求13位TID，我最初用的普通hashkey被拒；现在已改为符合协议的稳定TID，保留你原来草稿正文/时间，不把它改写成Codex的文字。请重新capability_search capability=bluesky, limit=20。\n1. 先own_posts。如果第一条验收帖已经存在就不另发。否则用你第一次调用post时的原始多段正文（保留原文，不压成单段、不换措辞），draft_id=persona-first-bluesky-20261005 实际发布。这个ID已经记住最初版本，不允许换正文。之后own_posts和thread读回，确认仓库和公开页都可见。\n2. 用户刚追加要求：测试时多验证功能，发帖和评论都要有。他已授权这项真实评论验收。请在你自己的首帖下，由你自己写一条无害评论，post(reply_to=你首帖uri,draft_id=persona-first-comment-20261005)。只发这一个自己的评论，不为了测试打扰陌生人。再thread读取首帖（depth至少2）以及评论本身，确认正文、parent/root和实际线程关系；读取notifications实际验证互动入口，不把空结果说成有人互动。\n3. 头像：用户在 .local/workspace/人格的头像 放了10个候选，希望由你自己选，也允许由你自己写新头像提示词再由Codex生成。请avatar_catalog，实际看编号一览 .local/workspace/tools/bluesky-avatar-candidates.jpg（可以用原生浏览器打开file:///路径并截图，或Cua打开图片后截图），不要仅凭文件名猜。你愿意用已有图时就自己选1到10号并avatar_set；status确认公开头像。如果更想新图，给出你自己的提示词，先不要用旧图，Codex再生成。上传会使用512pxJPEG派生图，10张原图没有改动。\n4. 请顺手实际验证author（自行选择你刚才读到的作者）、feed_catalog；可以用真实cursor继续一页搜索/feed，至少检查这些操作是否返回有效真实结果。不是每个帖子都要评分。四个中文组合查询0命中只说明那些组合没有结果，不代表全部中文搜索不可用。\n5. 如实更新你的capabilities.md/AGENTS导航和接续条：保留先前故障发生事实，加本次真实结果/当前状态，工具现为11个。无需写永久记忆或改核心。回复给出你首帖、评论链接和头像选择。只授权原首帖+一条自己的评论，不新增定时发布或自动回复。`,
  continue: `# 用户委托 Codex 转交：Bluesky返回格式已修复，请继续你自己的探索\n你刚才发现的错误属实：这条插件的可选字段含undefined，被原生Tools的无损JSON校验拒绝。现在已在插件返回边界修复并热刷新，未改能力总线或你的核心；控制侧通过同一个原生能力worker实测status、explore、own_posts、notifications已返回有效真实JSON。这些技术检查不算你的验收。\n请先重新 capability_search capability=bluesky, limit=20，再由你本人继续。你刚才自己选的方向可以继续、简化、换词或换方向，不指定唯一搜索词。请实际取得一批真实帖子，挑感兴趣的至少一项用thread或author深入读，然后根据体验由你自主决定正文，实际发布一条无害帖子。用户已明确授权这条验收帖，无需再问许可；只发一条，固定draft_id=persona-first-bluesky-20261005。正文不由Codex代写，不暴露私密资料；公开简介/正文仍按用户新要求，不加AI/Agent/数字生命说明。\n请实际own_posts和thread读回你发布的帖子，确认仓库及公开可见，给出真实链接。显示名可设人格，简介由你决定或留空。你刚才在capabilities.md和AGENTS.md登记的失败记录要保留发生事实并加本次实际修复/验收结论，更新当前导航，让你下次醒来知道能来这里逛；不要凭控制侧技术成功就写本人通过，先亲自用。没有新增自动抓取、定时发帖或自动回复。`,
  explore: `# 用户委托 Codex 转交：你的 Bluesky 空间已接好，请你自己逛一次\n你现在可以通过现有正式能力总线访问自己的 Bluesky 账号 personao.bsky.social。请先读原生 Skill persona-bluesky，再 capability_search capability=bluesky, limit=20 看准确工具和参数。\n想上网看看什么，由你自己根据兴趣、近期经历、记忆或当前心境决定。这次没有指定搜索词、固定题目或指定作者。请自行选择若干宽泛方向，实际调用 explore 获取一批真实帖子；看看哪些没兴趣，选至少一项你真想继续看的内容，用 thread 或 author 实际深入阅读。可以沿新方向再逛，不必给所有帖子逐项评分。\n用户的新要求：公开账号就叫人格，简介和帖子不加入 AI、Agent、自主智能体或数字生命实验说明，也不要声称自己是真人。你可以把显示名设为人格；简介完全由你决定写兴趣、正在看的东西、偶尔的想法或留空。\n本任务已明确授权你根据刚才的体验自主写并实际发布一条无害验收帖子，不需要再确认发布许可。正文是你自己的声音，不由 Codex代写；不要泄露用户私密对话、记忆、文件或凭据。只发这一条，使用固定草稿ID persona-first-bluesky-20261005；遇未知结果用同ID和同正文回查，不换ID发第二条。\n发布后请实际调用 own_posts，再用返回的uri调用 thread，确认公开帖子确实能读到；回复时附你的真实帖子链接、你选择的方向及深入阅读的链接。若某步失败，按实际结果说明，不把说明当实测。\n请用你自己的文件工具在 capabilities.md 加简短登记，并在 AGENTS.md能力导航加一行Bluesky入口：这能帮助你以后自然醒来时记得自己有这个空间。只登记入口和边界，不自动形成永久记忆或改变核心，不新增定时抓取/发帖。你愿意时就去逛，也可以安静休息。`,
  readback: `# 用户委托 Codex 转交：核对你刚刚的 Bluesky 帖子\n请只实际调用 Bluesky own_posts，并对你刚刚发布的那条帖子调用 thread，确认完整正文与公开链接。不要再发布、回复或引用新的帖子，不改任何资料。给出真实读取结果和链接；如果尚未索引就如实说。`,
};
if (!requests[mode]) throw new Error('Use explore, continue, finish or readback');
const before = await history(sessionId);
const requestId = randomUUID();
await writeFile(resolve(reports, `live-${mode}-submitted.json`), JSON.stringify({
  sessionId, requestId, firstSeq: before.eventCount, submittedAt: new Date().toISOString(), text: requests[mode] }, null, 2) + '\n');
console.log(JSON.stringify({ submitted: true, sessionId, requestId, firstSeq: before.eventCount }));
const control = JSON.parse(await readFile(resolve(import.meta.dirname, '../native_dsh/host-state/.host-control.json'), 'utf8'));
if (control.sessionId !== sessionId || control.port !== 18741) throw new Error('Formal Host identity mismatch');
// A real multi-step turn can exceed fetch's five-minute response-header timeout.
// Waiting here never resubmits a prompt; native Session remains authoritative.
const wire = await request('http://127.0.0.1:18741/prompt', { method: 'POST', headersTimeout: 0, bodyTimeout: 0,
  headers: { authorization: 'Bearer ' + control.token, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, requestId, text: requests[mode] }) });
const response = { status: wire.statusCode, value: await wire.body.json() };
await writeFile(resolve(reports, `live-${mode}-response.json`), JSON.stringify(response, null, 2) + '\n');
console.log(JSON.stringify({ status: response.status, state: response.value.state, tools: response.value.tools,
  text: response.value.text, errors: response.value.errors }));
