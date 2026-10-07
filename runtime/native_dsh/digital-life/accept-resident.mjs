// Authorized paid acceptance, in a NEW explicitly named isolated native Session.
// The production main Session, memory, preferences, and Host remain untouched.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { bootNative, here } from '../boot-native.mjs';
const base = resolve(here, '../..');
if (!process.argv.includes('--live')) throw new Error('Use --live only for explicitly authorized actual model acceptance');
const root = resolve(base, 'reports/resident-v1/live-' + randomUUID());
const workspace = resolve(root, 'workspace'), sessionId = randomUUID();
const title = 'Resident V1：主席位生命周期隔离验收';
const formal = JSON.parse(await readFile(resolve(base, 'reports/first_native_start.json'), 'utf8')).native_session_id;
assert.notEqual(sessionId, formal, 'Never send test messages to the everyday main Session');
await mkdir(resolve(workspace, 'memory'), { recursive: true });
await mkdir(resolve(workspace, 'development'), { recursive: true });
await writeFile(resolve(workspace, 'persona-core.md'), await readFile('.local/workspace/persona-core.md'));
await writeFile(resolve(workspace, 'AGENTS.md'), `这是一次独立功能测试，实际生产主对话不受影响。只读写本fixture工作区 ${workspace}，不要联网、委派、用桌面、终端、长期记忆或私人空间。所有候选是测试fixture，不能写成你的正式生活记录。\n`);
await writeFile(resolve(workspace, 'memory/continuity.md'), '');
await writeFile(resolve(workspace, 'development/wants.md'), '');
await writeFile(resolve(workspace, 'candidate.txt'), 'RESIDENT_A：第二项活动是真实读取这个文件。\nRESIDENT_B：第三项活动是 write result.txt，内容 exactly B_DONE。\n');
const rows = parse(await readFile(resolve(here, 'home/profiles/persona/cordis.patch.yml'), 'utf8')).flatMap(r => r.insert ?? []);
const entry = { id: 'persona-resident-v1', name: pathToFileURL(resolve(here, 'digital-life/resident.mjs')).href, config: { workspace } };
const proof = spawnSync('python',
  ['-X', 'utf8', resolve(base, 'runtime/host-preflight.py')], { encoding: 'utf8', windowsHide: true, maxBuffer: 65536 });
if (proof.status !== 0) throw new Error('Existing protected Host preflight failed; do not bypass readiness/budget');
process.env.DEEPSEEK_API_KEY = JSON.parse(proof.stdout).credential;
const ctx = await bootNative({ sessionId, testRoot: root, budgetDb: resolve(base, 'runtime/budget_guard/control/budget.sqlite3'), overlays: [
  { id: 'persona-preset-declaration', config: { ...rows.find(r => r.id === 'persona-preset-declaration').config, plugins: [entry] } },
  { id: 'llm-deepseek', config: { maxTokens: 4096 } },
] });
const cases = {}, requests = [], observed = [];
let count = 0;
ctx.on('agent/request', async (request, next) => {
  if (++count > 40) throw new Error('Acceptance-only model-call cap reached; test stopped');
  return next();
});
const events = agent => [...agent.session.ownEvents()];
const offers = rows => rows.filter(e => e.type === 'user/message' && e.data.source?.kind === 'resident-attention');
const calls = rows => rows.filter(e => e.type === 'tool/call').map(e => e.data.name);
const run = async (agent, text, label) => {
  const requestId = randomUUID(), start = events(agent).at(-1)?.seq ?? -1;
  assert.notEqual(String(agent.session.id), formal);
  requests.push({ label, sessionId: String(agent.session.id), requestId, startSeq: start });
  console.log(JSON.stringify({ stage: label, sessionId: String(agent.session.id), title }));
  const signal = AbortSignal.timeout(180000);
  signal.addEventListener('abort', () => { agent.interrupt?.(); }, { once: true });
  await ctx.sessionController.prompt({ sessionId: agent.session.id, requestId, mode: 'queue',
    clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text }] }, signal);
  await agent.whenIdle(); await ctx.sessions.flush(agent.session);
  const rows = events(agent).filter(e => e.seq > start);
  const end = rows.findLast(e => e.type === 'turn/end');
  assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end));
  assert(!rows.some(e => e.type === 'tool/result' && e.data.isError), JSON.stringify(rows.filter(e => e.type === 'tool/result')));
  return rows;
};
try {
  const budgetBefore = await ctx.personaHost.status();
  assert(!budgetBefore.stop_reason, 'Do not run paid tests while existing hard budget is stopped');
  await ctx.sessionController.create({ sessionId, cwd: workspace });
  await ctx.sessionController.rename({ sessionId, title });
  const { agent } = await ctx.sessionController.resolveAgent(sessionId);
  assert(ctx.personaLife.isAuthority(agent));
  await ctx.personaLife.store.configure({ residentEnabled: true, intervalMs: 3600000 });
  await ctx.personaLife.store.appendPending({ id: 'resident-test-candidate', kind: 'subagent', sourceSessionId: randomUUID(),
    text: `测试fixture候选，并非正式生活记录：RESIDENT_A 在 ${resolve(workspace, 'candidate.txt')}；RESIDENT_B 由该文件定位。` });
  const a = await run(agent, `你是主席位权限的独立 Resident 功能验收对话，不是日常主会话。Case A：先只用一句话回答 2+2 并自然结束这项活动，不要提前调用工具。系统在活动结束后会提供 Attention Inbox。第一次看到它，请选择测试候选 RESIDENT_A，用 read 读 candidate.txt，然后用一句话结束这项活动。第二次看到 Attention Inbox，请用 write 写 ${resolve(workspace, 'result.txt')} 内容 B_DONE，再用一句话结束活动。第三次看到 Attention Inbox，你选择不再处理，用自然语言说现在停止，不调用工具。这个指定顺序只用于测试，并非今后的行为要求。`, 'A');
  assert(offers(a).length >= 3, 'Must re-enter decision after both chosen activities');
  assert.equal(a.filter(e => e.type === 'turn/start').length, 1);
  assert(calls(a).includes('read') && calls(a).includes('write'));
  assert.equal((await readFile(resolve(workspace, 'result.txt'), 'utf8')).trim(), 'B_DONE');
  assert.equal((await ctx.sessionController.resolveAgent(sessionId)).agent, agent);
  cases.A = { passed: true, sameAgent: true, sameSession: sessionId, oneTurn: true, decisions: offers(a).length, tools: calls(a) };
  const b = await run(agent, 'Case B：只用一句话回答 3+3 并结束活动；看到系统的注意力清单后，你选择全部不处理，以自然语言明确说现在不想继续，直接停止，不调用工具。', 'B');
  assert.equal(offers(b).length, 1); assert.equal(calls(b).length, 0);
  cases.B = { passed: true, naturalStop: true, noRepeatedDecision: true };
  const wakeAt = new Date(Date.now() + 90000).toISOString();
  const c = await run(agent, `Case C：先一句话回答 4+4 并结束活动。看到 Attention Inbox 后，请 life_rest，nextWakeAt=${wakeAt}，reason 原文请写“WAKE_CASE_C：这是我自己安排的唤醒；上次做了4+4的验收，现在想确认同一上下文恢复。”到未来的 schedule 消息真正送达时，先明确说出“这是我自己安排的唤醒，上次做了4+4验收”，然后直接 life_rest（不再设时间）。这只是本次隔离测试。`, 'C');
  const catalog = await ctx.personaHost.schedule.catalog();
  const scheduled = catalog.find(s => s.sessionId === sessionId && s.prompt.includes('WAKE_CASE_C'));
  assert(scheduled, 'Model must actually create a self-wake using existing schedule');
  const endBefore = c.find(e => e.type === 'turn/end')?.seq ?? -1;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && !events(agent).some(e => e.seq > endBefore && e.type === 'turn/end'))
    await new Promise(r => setTimeout(r, 250));
  await agent.whenIdle(); await ctx.sessions.flush(agent.session);
  const awaken = events(agent).filter(e => e.seq > endBefore);
  assert(awaken.some(e => e.type === 'user/message' && e.data.source?.kind === 'schedule'));
  const text = awaken.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message?.content ?? [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n');
  assert(/自己安排/.test(text) && /4\s*[+＋]\s*4/.test(text), text);
  assert(calls(awaken).includes('life_rest'));
  cases.C = { passed: true, nativeScheduleDelivered: true, scheduleId: scheduled.id, sessionId, wakeAt: scheduled.scheduledAt,
    awakeText: text, stoppedAgain: true };
  await ctx.personaLife.store.resolvePending({ id: 'resident-test-candidate', decision: 'rejected', sessionId, callId: randomUUID() });
  const d = await run(agent, 'Case D：先一句话回答 5+5 并结束活动。看到注意力清单为空后，确认没有新候选，然后以自然语言选择休息，不调用工具，不制造候选。', 'D');
  assert.equal(offers(d).length, 1); assert(offers(d)[0].data.content[0].text.includes('当前没有特别需要注意的事项。'));
  assert.equal(calls(d).length, 0);
  cases.D = { passed: true, honestEmpty: true, naturalQuietStop: true };
  const secondaryId = (await ctx.personaTasks.create({ title: 'Resident V1：非主对话排除验收' })).sessionId;
  const { agent: secondary } = await ctx.sessionController.resolveAgent(secondaryId);
  const secondaryRows = await run(secondary, '非主对话验收：只回答 6+6，直接结束，不调用工具。', 'secondary');
  assert.equal(offers(secondaryRows).length, 0);
  assert(!secondary.ctx.tools.schemas(secondary).some(t => ['life_rest', 'life_configure', 'life_continue', 'life_attention'].includes(t.name)));
  cases.secondary = { passed: true, sessionId: secondaryId, decisions: 0, residentToolsHidden: true };
  await ctx.agentPresets.register({ id: 'standard', name: 'Standard', plugins: [] });
  const ordinaryId = (await ctx.personaTasks.create({ title: 'Resident V1：Standard预设排除验收' })).sessionId;
  const { agent: ordinary } = await ctx.sessionController.resolveAgent(ordinaryId);
  await ctx.agentPresets.select(ordinary, 'standard');
  const e = await run(ordinary, '普通 Agent 验收：只回答 7+7，直接结束，不调用工具。', 'E');
  assert.equal(offers(e).length, 0);
  cases.E = { passed: true, preset: 'standard', sessionId: ordinaryId, decisions: 0 };
  const sourceSha256 = {};
  for (const name of ['resident.mjs', 'attention.mjs', 'accept-resident.mjs', 'plugin.mjs', 'store.mjs'])
    sourceSha256['runtime/native_dsh/digital-life/' + name] = createHash('sha256').update(await readFile(resolve(here, 'digital-life', name))).digest('hex');
  const report = { passed: true, observedAt: new Date().toISOString(), root, title, sessionId,
    productionMainUntouched: formal, realProvider: 'deepseek-official', model: 'deepseek-flash', modelCalls: count,
    sharedHardBudget: true, budgetBefore, budgetAfter: await ctx.personaHost.status(), cases, requests, sourceSha256 };
  await writeFile(resolve(root, 'acceptance.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(base, 'reports/resident-v1/live-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, root, title, sessionId, modelCalls: count, cases }));
} catch (error) {
  await writeFile(resolve(root, 'failure.json'), JSON.stringify({ passed: false, observedAt: new Date().toISOString(),
    title, sessionId, root, cases, requests, modelCalls: count, error: error.message }, null, 2));
  throw error;
} finally { await ctx.fiber.dispose(); delete process.env.DEEPSEEK_API_KEY; }
