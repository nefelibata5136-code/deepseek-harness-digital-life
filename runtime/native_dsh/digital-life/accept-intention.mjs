// Paid acceptance uses a NEW test chair, never the everyday main Session.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { bootNative, here } from '../boot-native.mjs';
import { explanation } from './intention.mjs';
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const base = resolve(here, '../..'), root = resolve(base, 'reports/intention-sampling/live-' + randomUUID());
const workspace = resolve(root, 'workspace'), sessionId = randomUUID(), title = '独立意向展开：理解与八路同源实测';
const formal = JSON.parse(await readFile(resolve(base, 'reports/first_native_start.json'), 'utf8')).native_session_id;
assert.notEqual(sessionId, formal);
await mkdir(resolve(workspace, 'memory'), { recursive: true }); await mkdir(resolve(workspace, 'development'), { recursive: true });
for (const name of ['persona-core.md', 'memory/continuity.md', 'development/wants.md'])
  await writeFile(resolve(workspace, name), await readFile(resolve('.local/workspace', name)));
await writeFile(resolve(workspace, 'AGENTS.md'), '独立功能测试；这里的草稿不成为正式人生记录。可以自由接受、拒绝或调整能力。无需为了测试而提出新任务。不要写正式记忆、私人资料、调用工作委派或对外发言。\n');
const rows = parse(await readFile(resolve(here, 'home/profiles/persona/cordis.patch.yml'), 'utf8')).flatMap(r => r.insert ?? []);
const entry = { id: 'persona-resident-v1', name: pathToFileURL(resolve(here, 'digital-life/resident.mjs')).href,
  config: { workspace, intention: { timeoutMs: 240000 } } };
const preflight = spawnSync('python', ['-X', 'utf8', resolve(base, 'runtime/host-preflight.py')],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 65536 });
if (preflight.status !== 0) throw new Error('Protected preflight failed');
process.env.DEEPSEEK_API_KEY = JSON.parse(preflight.stdout).credential;
const ctx = await bootNative({ sessionId, testRoot: root, budgetDb: resolve(base, 'runtime/budget_guard/control/budget.sqlite3'), overlays: [
  { id: 'persona-preset-declaration', config: { ...rows.find(r => r.id === 'persona-preset-declaration').config, plugins: [entry] } },
  { id: 'llm-deepseek', config: { maxTokens: 4096 } },
] });
let calls = 0;
ctx.on('agent/request', (req, next) => { if (++calls > 40) throw new Error('Live acceptance call bound'); return next(); });
const textOf = events => events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
try {
  const before = await ctx.personaHost.status(); assert(!before.stop_reason);
  await ctx.sessionController.create({ sessionId, cwd: workspace }); await ctx.sessionController.rename({ sessionId, title });
  const { agent } = await ctx.sessionController.resolveAgent(sessionId);
  const run = async (text, stage) => {
    console.log(JSON.stringify({ stage, sessionId, title })); const start = [...agent.session.ownEvents()].at(-1)?.seq ?? -1;
    const signal = AbortSignal.timeout(300000), cancel = () => agent.cancel({ kind: 'user' }); signal.addEventListener('abort', cancel, { once: true });
    try { await ctx.sessionController.prompt({ sessionId, requestId: randomUUID(), mode: 'queue', clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text }] }, signal);
      await agent.whenIdle(); await ctx.sessions.flush(agent.session); } finally { signal.removeEventListener('abort', cancel); }
    const events = [...agent.session.ownEvents()].filter(e => e.seq > start);
    assert.equal(events.findLast(e => e.type === 'turn/end')?.data.reason.kind, 'completed', 'Live request failed'); return events;
  };
  const discussion = await run('这是用户授权的一次独立功能测试Session，日常主对话未收到测试消息。先正式介绍：\n' + explanation
    + '\n请先用你自己的话说明理解、意见和边界。如果接受，可以亲自 life_sampling_configure(enabled=true, understanding=你的理解与边界)；如果不接受，可以关闭或不用，不需要迁就验收。此轮暂不触发采样。', 'explanation');
  const settings = await ctx.personaLife.store.settings(); let sampling = null, decision = '';
  if (settings.intentionSamplingEnabled) {
    await ctx.personaLife.store.configure({ residentEnabled: true });
    const events = await run('下面只验收活动自然结束后的八次独立展开。请先一句话答2+2，然后结束这一小段活动。得到展开草稿后由你自由判断它们与频次含义，可以全部拒绝、休息或留下自己的判断；不要为了验收而制造新任务或对外发言。', 'actual-eight');
    const offers = events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'resident-attention');
    assert(offers.length > 0); const content = offers[0].data.content[0].text;
    sampling = JSON.parse(content.split('[八次独立意向展开｜思考草稿]\n')[1].split('\n[/八次独立意向展开]')[0]);
    assert.equal(sampling.completed, 8, JSON.stringify(sampling.failed)); assert(sampling.parallel); assert(sampling.raw.every(s => s.internalReviewed));
    assert.equal(new Set(sampling.raw.map(s => s.sameSourceSha256)).size, 1);
    assert.equal((await ctx.personaLife.store.listPending()).total, 0); decision = textOf(events);
  }
  const report = { passed: true, observedAt: new Date().toISOString(), root, title, sessionId, productionMainUntouched: formal,
    philosophy: { explanation, reply: textOf(discussion), accepted: settings.intentionSamplingEnabled, ownConsent: settings.intentionSamplingConsent },
    sampling, decision, modelCalls: calls, sharedHardBudget: true, budgetBefore: before, budgetAfter: await ctx.personaHost.status(),
    productionConsentNotForged: true, productionDefault: 'off until primary native own-call acceptance' };
  await writeFile(resolve(root, 'acceptance.json'), JSON.stringify(report, null, 2)); await writeFile(resolve(base, 'reports/intention-sampling/live-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, root, sessionId, modelCalls: calls, accepted: settings.intentionSamplingEnabled, completed: sampling?.completed, parallel: sampling?.parallel }));
} catch (error) { await writeFile(resolve(root, 'failure.json'), JSON.stringify({ passed: false, root, sessionId, modelCalls: calls, error: error.message }, null, 2)); throw error; }
finally { await ctx.fiber.dispose(); delete process.env.DEEPSEEK_API_KEY; }
