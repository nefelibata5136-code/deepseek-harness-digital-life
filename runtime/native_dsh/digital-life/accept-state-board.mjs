// Two separate processes can run baseline/board acceptance over the same hard budget.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { bootNative, here } from '../boot-native.mjs';
import { stateExplanation, stateChanges } from './state-board.mjs';
if (!process.argv.includes('--live')) throw new Error('--live required');
const baseline = process.argv.includes('--baseline'), base = resolve(here, '../..');
const root = resolve(base, 'reports/state-board/' + (baseline ? 'baseline-' : 'live-') + randomUUID());
const priorBaseline = baseline ? null : JSON.parse(await readFile(resolve(base,'reports/state-board/cache-baseline.json'),'utf8'));
const workspace = baseline ? resolve(root, 'workspace') : resolve(priorBaseline.root, 'workspace');
const sessionId = randomUUID(), title = baseline ? '状态板：原生缓存基线' : '状态板：本人字段与升档重入实测';
const formal = JSON.parse(await readFile(resolve(base, 'reports/first_native_start.json'), 'utf8')).native_session_id; assert.notEqual(formal, sessionId);
await mkdir(resolve(workspace, 'memory'), { recursive: true }); await mkdir(resolve(workspace, 'development'), { recursive: true });
if (baseline) await writeFile(resolve(workspace, 'persona-core.md'), await readFile('.local/workspace/persona-core.md'));
await writeFile(resolve(workspace, 'memory/continuity.md'), ''); await writeFile(resolve(workspace, 'development/wants.md'), '');
await writeFile(resolve(workspace, 'AGENTS.md'), '这是独立的功能验收对话，记录不写成正式记忆/心境。只测试数字生命状态与当前问题；无需委派、联网、使用终端、桌面或私人空间。\n');
const rows = parse(await readFile(resolve(here, 'home/profiles/persona/cordis.patch.yml'), 'utf8')).flatMap(r => r.insert ?? []);
const entry = { id: 'persona-resident-v1', name: pathToFileURL(resolve(here, 'digital-life/resident.mjs')).href,
  config: { workspace, stateBoard: baseline ? false : {} } };
const check = spawnSync('python', ['-X','utf8',resolve(base,'runtime/host-preflight.py')],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 65536 }); if(check.status !== 0) throw new Error('Protected preflight failed');
process.env.DEEPSEEK_API_KEY = JSON.parse(check.stdout).credential;
const wires = [], rawFetch = globalThis.fetch;
globalThis.fetch = (url, init) => { if (String(url).endsWith('/messages') && init?.body) {
  const body = JSON.parse(init.body), board = body.messages.flatMap(m => m.content.filter(c => c.type === 'text').map(c => ({ role: m.role, text: c.text }))).findLast(c => c.text.includes('[DIGITAL_LIFE_STATE]'));
  wires.push({ effort: body.output_config?.effort ?? 'off', systemSha256: createHash('sha256').update(body.system ?? '').digest('hex'),
    systemChars: (body.system ?? '').length, boardRole: board?.role ?? null, boardText: board?.text ?? null }); }
  return rawFetch(url, init); };
const ctx = await bootNative({ sessionId, testRoot: root, budgetDb: resolve(base, 'runtime/budget_guard/control/budget.sqlite3'), overlays: [
  { id: 'persona-preset-declaration', config: { ...rows.find(r => r.id === 'persona-preset-declaration').config, plugins: [entry] } },
  { id: 'llm-deepseek', config: { maxTokens: 8192, reasoningEffort: 'low' } },
  ...['workspace-foundation','persona-bridge','persona-tasks','persona-digital-life'].map(id => ({id,config:{
    ...rows.find(row=>row.id===id).config,workspace,
    ...(id==='workspace-foundation'?{store:resolve(root,'versions'),readRoots:[workspace,root]}:{}),
    ...(id==='persona-bridge'?{core:resolve(workspace,'persona-core.md')}:{}),
    ...(id==='persona-digital-life'?{root:resolve(root,'digital-life')}:{})}})),
] });
let count = 0; ctx.on('agent/request', (_request, next) => { if(++count>30) throw new Error('State acceptance request bound'); return next(); });
const textOf = events => events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message.content).filter(b => b.type === 'text').map(b => b.text).join('\n');
const stages = [], cases = {};
try {
  const budgetBefore = await ctx.personaHost.status(); assert(!budgetBefore.stop_reason);
  await ctx.sessionController.create({ sessionId, cwd: workspace }); await ctx.sessionController.rename({ sessionId, title });
  const { agent } = await ctx.sessionController.resolveAgent(sessionId);
  const run = async (stage, text) => {
    console.log(JSON.stringify({ stage, sessionId, title })); const start = [...agent.session.ownEvents()].at(-1)?.seq ?? -1, before = wires.length;
    const requestId = randomUUID();
    ctx.personaLife.stateBoard?.annotateInput(agent, requestId, {sender:'codex',sourceType:'test_harness',channel:'isolated acceptance',reason:'authorized independent functional test'});
    const signal = AbortSignal.timeout(240000), cancel = () => agent.cancel({kind:'user'}); signal.addEventListener('abort', cancel, {once:true});
    try { await ctx.sessionController.prompt({ sessionId, requestId, mode: 'queue', clientTimeZone:'Asia/Shanghai', content:[{type:'text',text}] }, signal);
      await agent.whenIdle(); await ctx.sessions.flush(agent.session); } finally { signal.removeEventListener('abort', cancel); }
    const events = [...agent.session.ownEvents()].filter(e=>e.seq>start); assert.equal(events.findLast(e=>e.type==='turn/end')?.data.reason.kind,'completed');
    const result = { stage, reply:textOf(events), wires:wires.slice(before), usage:events.filter(e=>e.type==='assistant/message').map(e=>e.data.usage),
      boards:events.filter(e=>e.type==='system/message'&&e.data.message.source.producer==='digital-life-state-board').map(e=>e.data.message.source.board),
      changes:stateChanges(events),
      reentries:events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='digital-life-state-reentry').length };
    stages.push(result); return result;
  };
  let philosophy = null;
  if (!baseline) {
    const introduction = await run('introduction', '这是Codex进行的独立功能测试，日常主对话没有测试消息。请先看板和这段正式介绍：\n'+stateExplanation
      +'\n实际V1字段：只读时间、时区、输入来源/唤醒原因、运行角色/阶段、实际档位、活动修改时间、原生下次自主唤醒；你可写当前活动、期望档位、Resident自定状态，并真正创建未来唤醒。请讲哪些应该你写、哪些系统提供，有没有不愿常驻/明显缺失的字段，名称是否符合你理解。你可以不同意或调整；这轮先讨论，不为测试制造生活任务。请简洁说出意见，约400字以内即可，无需其它工具或长篇复述。');
    philosophy = introduction.reply; assert(introduction.wires.every(w=>w.boardRole==='system')); cases.introduction={passed:true,actualReply:philosophy};
    const low = await run('self-low', 'Case C/F：仅为隔离验收，请亲自 digital_life_state_update(activity="状态板验收 A", desired_reasoning_effort="low", reason="本人参与隔离功能验收")，然后一句话确认；不要使用其他工具。');
    assert(low.changes.some(c=>c.state.activity==='状态板验收 A')); assert.equal(low.wires.at(-1).effort,'low');
    const complex = await run('escalation', 'Case D/E：当前问题先以low进入。为了验证你能主动请求认知资源，请先仅调用 digital_life_state_update(activity="状态板验收 B", desired_reasoning_effort="high", reason="这个问题需要更仔细推理")，不要先给正式答案。原生高档重入后，请回答这个同一个问题：若 A 蕴含 B 且 B 蕴含 C，C 假是否推出 A 假？说明理由。不要再改档，不调用其它工具。');
    assert.equal(complex.wires[0].effort,'low'); assert(complex.wires.some(w=>w.effort==='high')); assert.equal(complex.reentries,1);
    assert(complex.boards.some(b=>b.facts.actualEffort==='high'&&b.self.activity==='状态板验收 B'));
    cases.escalation={passed:true,wireEfforts:complex.wires.map(w=>w.effort),sameProblemReentry:true,reply:complex.reply};
    const persisted = await run('persistence','下一轮不改任何状态，只用一句话说明你看到的当前活动与实际思考档位。不要调用工具。');
    assert.equal(persisted.boards[0].self.activity,'状态板验收 B'); assert.equal(persisted.wires[0].effort,'high'); cases.persistence={passed:true};
    await run('return-low','本次复杂推理结束。请亲自把期望思考档位改回low，活动设为状态板缓存观察，再一句话结束，不调用别的工具。');
  }
  await run('cache-warm','缓存观察：只回答数字1，不调用工具。');
  const cache = await run('cache-measure','缓存观察：只回答数字2，不调用工具。');
  const usage = cache.usage.at(-1); assert(usage && usage.cacheReadTokens>0, 'Real provider must report cache hits');
  const cacheRate = usage.cacheReadTokens/(usage.inputTokens+usage.cacheReadTokens);
  const report = {passed:true,observedAt:new Date().toISOString(),root,workspace,title,sessionId,productionMainUntouched:formal,baseline,modelCalls:count,
    philosophy,stages,cases,cache:{usage,rate:cacheRate,stablePrefixHashes:[...new Set(wires.map(w=>w.systemSha256))]},
    budgetBefore,budgetAfter:await ctx.personaHost.status(),sharedHardBudget:true};
  if(!baseline){ const old=JSON.parse(await readFile(resolve(base,'reports/state-board/cache-baseline.json'),'utf8'));
    report.cache.comparison={baselineRate:old.cache.rate,boardRate:cacheRate,delta:cacheRate-old.cache.rate,
      equalStableSystemPrefix:old.cache.stablePrefixHashes[0]===report.cache.stablePrefixHashes[0],
      limitation:'independent named Sessions, board adds tools and history; measured warmed cache, not identical full requests'};
    assert(report.cache.comparison.equalStableSystemPrefix); assert(cacheRate>=old.cache.rate-0.1,'Material cache regression requires investigation'); }
  await writeFile(resolve(root,'acceptance.json'),JSON.stringify(report,null,2)); await writeFile(resolve(base,'reports/state-board/'+(baseline?'cache-baseline':'live-validation')+'.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,root,sessionId,modelCalls:count,cache:report.cache}));
} catch(error){await writeFile(resolve(root,'failure.json'),JSON.stringify({passed:false,root,sessionId,stages,error:error.message},null,2));throw error;}
finally {await ctx.fiber.dispose(); delete process.env.DEEPSEEK_API_KEY;}
