// Send real user requests to Persona. Only Persona may invoke Agent tools.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostRequest, history, identity } from '../desktop_persona/index.mjs';
const report = resolve(import.meta.dirname, '../../reports/subagents');
await mkdir(report, { recursive: true });
const mode = process.argv[2];
if (!['deepseek', 'codex', 'question'].includes(mode)) throw new Error('Choose deepseek, codex or question');
const nonce = 'YB-' + randomUUID().slice(0, 8);
const tasks = {
  deepseek: `# 用户委托 Codex 转交：子 Agent 实际验收 A/B
你已接入官方 Agent 工具，请由你自己自主完成下列测试。不要使用 task_create，不需要人类打开或点醒子会话；不要写文件或修改核心、便签和记忆。
1. 用 subagent 后台创建一个可继续的 DeepSeek child。给它一个自包含任务：计算 38*47，记住结果和标记 ${nonce}，只返回标记及答案。run_in_background 必须为 true，以保留 continuation。
2. 收到 child 的实际完成通知以后，报告它的实际答案，然后用 send_message 给刚才同一个 child 发第二条消息：不要重新给它前面的数值和标记，要求它回忆自己第一轮保存的标记与结果，并把那个结果加 19。收到第二轮结果后核对并报告。
3. 用 list_agents 查同一个 child 的状态，调用 interrupt_agent，随后再查 list_agents，报告真实工具回执。inactive child 的 interrupt 也可用于接口验收，不宣称停止了正在执行的任务。
请自行进行工具调用并处理异步通知；每次 child 完成官方服务会把最终输出送回你，不需要人类发消息唤醒。若第一轮等待期间你结束当前 turn，收到通知后继续完成余下步骤。最终清楚给出 child id、两轮实际答案、list 和 interrupt 结果。`,
  codex: `# 用户委托 Codex 转交：Codex Luna 子 Agent 实际验收 C
请你自己使用 subagent_codex，让真实 Codex gpt-6-luna child 完成以下自包含任务：计算 23*29，并用中文一句话解释计算方式，回答中带标记 ${nonce}。纯计算任务，不调用其他工具、不读写文件。不要用 DeepSeek 代替、不要 task_create 空 Session。等工具把实际结果返回后，把结果转告用户，并根据目前工具说明说明这条 provider 是否 one-shot、是否能 send_message 继续。不要写便签、记忆或核心。`,
  question: `# 用户委托 Codex 转交：最终能力问答 D
先转交一条已核实的控制侧交付信息：刚才 Codex 失败后，控制侧将官方 dsh-subagent-codex 的 Codex 运行依赖从 0.153.4 修正为本机已可工作的 0.159.2，并重启了正式 Host。旧版独立诊断返回 Luna/ChatGPT 不支持；0.159.2 同一登录真实返回了 667，随后你自己的 subagent_codex 也成功。这是实际版本修正，不能把前后差异猜成单纯服务抖动。官方 provider 源码没有修改，继续复用 .local/unconfigured 的 ChatGPT 登录和配置。说明文档现已存在：迁移控制目录 reports/subagents/README.md。
你现在能不能创建 Agent？
请自己做一次小实测后回答，不能只根据说明说能：自行选择官方 DeepSeek 子 Agent，给它计算 14*17 的任务，取得真实结果。同时调用 list_agents 检查你自己的 child，再据真实工具结果说明目前可用的 provider、DeepSeek continuation、Codex gpt-6-luna 的 one-shot 限制与预算边界。如果选择后台子 Agent，请收到通知后完成答案。不要新建空任务、不要写文件、核心或长期记忆。`,
};
const sessionId = await identity();
const before = await history(sessionId);
const requestId = randomUUID();
await writeFile(resolve(report, mode + '-submitted.json'), JSON.stringify({ mode, nonce, sessionId, requestId,
  firstSeq: before.eventCount, text: tasks[mode], submittedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ submitted: true, mode, sessionId, requestId, firstSeq: before.eventCount }));
const result = await hostRequest('POST', '/prompt', { sessionId, requestId, text: tasks[mode] });
await writeFile(resolve(report, mode + '-response.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
