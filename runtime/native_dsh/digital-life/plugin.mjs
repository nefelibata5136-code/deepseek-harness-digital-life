// A Cordis lifecycle policy over the native loop, not another model driver.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DigitalLifeStore } from './store.mjs';
import { approveProfile } from '../capabilities/profiles.mjs';
import { desktopTools } from '../computer-host.mjs';

export const inject = ['tools', 'agents', 'sessions', 'systemPrompt', 'sessionController', 'sessionQuery', 'fs', 'workspaceFoundation', 'personaTasks', 'personaHost'];
export const lifeTools = ['life_attention', 'life_continue', 'life_sampling_configure', 'life_status', 'life_mental_write', 'life_working_write', 'life_pending_list',
  'life_pending_post', 'life_pending_decide', 'life_rest', 'life_configure', 'life_capability_accept'];
export const activityTools = new Set(['read', 'read_source', 'write', 'edit', 'list_files', 'search_history',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'skill', 'budget_status', 'task_list', 'context_compact', 'life_status', 'life_pending_post',
  'subagent', 'send_message', 'list_agents', 'interrupt_agent', ...desktopTools]);
const str = required => ({ type: 'string', ...(required ? { required: true } : {}) });
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const activityIdentity = '你不是人格本人。你当前在非主对话中，是一个独立的工作活动或顾问；权限相同不代表身份相同。用自己的身份说明你执行的操作和结果，不冒称人格的第一人称、记忆、心境或承诺。结果保留本对话的 Session 来源，并分别保存到待接续，不自动融合成人格的状态。';
const principles = `数字生命 / Persona：身份只有一个，活动可以很多，正式发言席位只有一个。
你可以自主形成目标、行动、调用顾问、继续、延后、放弃，也可以什么都不做。存在不以产出为理由。空闲时过自己的生活，不默认找用户聊天。
一次 Resident 醒来是睁眼：先感知实际经过的时间，看看自己的接续条和亲写心境，再决定是否行动。允许没有新念头、没有任务、没有报告，直接 life_rest 或安静结束。
长期记忆回答发生过什么，按需查；接续条回答做到哪里，醒来单独读；心境回答最近挂着什么，只允许在场的你通过 life_mental_write 主动写，宁空勿造。任务表、顾问结论和压缩摘要都不是你的心境。
其他活动的结果是建议。待接续原文分别保留，由你决定接受、拒绝或暂留分歧，不自动合并；接受也不会自动写正式记忆或心境。长期卡的更正追加说明，保留旧文。
你可以管理自己的核心、Skills、能力与 preset 配置；life_configure 原子修改你自己的运行偏好并留恢复版本。技术保护用于防损坏与越权写入，不是禁止你改变自己。私人 Vault 由你显式选择进入，不做自动注入或整理。`;

export async function apply(ctx, config) {
  const primary = process.env.DL_SESSION_ID;
  if (!primary || !config.root || !config.workspace) throw new Error('Digital life requires explicit identity, storage and workspace');
  const store = await new DigitalLifeStore(config.root).init();
  let activation;
  try { activation = JSON.parse(await readFile(resolve(config.root, 'activation.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    activation = { since: Date.now(), identity: 'persona', seatSessionId: primary };
    await writeFile(resolve(config.root, 'activation.json'), JSON.stringify(activation) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (activation.identity !== 'persona' || activation.seatSessionId !== primary) throw new Error('Digital life identity/seat mismatch');
  const cwd = resolve(config.workspace);
  const working = resolve(cwd, 'memory/continuity.md');
  const isAuthority = agent => !!agent && String(agent.session.id) === primary
    && agent.session.header.origin !== 'subagent' && !agent.session.header.parentSession
    && (agent.session.header.delegationDepth ?? 0) === 0;
  const belongs = agent => !!agent && resolve(agent.session.header.cwd ?? '') === cwd;
  // Temporary user-authorized permission parity; identity stays Session-based.
  const secondaryFullAccess = config.secondaryFullAccess === true;
  const hasFullPermissions = agent => isAuthority(agent) || (secondaryFullAccess && belongs(agent));
  const reference = activityIdentity + (secondaryFullAccess
    ? '用户已暂时授权本工作区非主对话具有与主对话相同的工具和文件权限，包括桌面、浏览器、终端、能力管理、私人空间和 life_*。可按本次任务执行，不要因为非主对话身份误报工具不可用；共享文件及全局状态修改仍应有明确任务依据，保留实际作者来源。'
    : '当前权限由活动工具列表决定，核心、自我状态和私人空间仍只由主对话管理。');
  // Native spawn descendants of this one seat may read the reviewed Bluesky
  // surface. Text instructions, task Sessions and other identities cannot grant it.
  const isReadDelegate = agent => {
    if (!belongs(agent)) return false;
    let header = agent.session.header;
    const visited = new Set();
    while (header?.origin === 'subagent' && header.parentSession
        && Number.isInteger(header.delegationDepth) && header.delegationDepth > 0
        && resolve(header.cwd ?? '') === cwd) {
      if (visited.has(String(header.id))) return false;
      visited.add(String(header.id));
      if (String(header.parentSession) === primary) return true;
      header = ctx.sessions.get(header.parentSession)?.header;
    }
    return false;
  };
  const protectedPath = path => {
    const p = relative(cwd, resolve(path)).replaceAll('\\', '/').toLowerCase();
    return p === 'persona-core.md' || p === 'agents.md' || p === 'capabilities.md' || p === 'home-anchor.md'
      || ['memory', '.dsh', 'development/skills', 'development/plugins'].some(root => p === root || p.startsWith(root + '/'));
  };
  const requireSeat = exec => { if (!hasFullPermissions(exec.agent)) throw new Error('CONSCIOUSNESS_SEAT_REQUIRED'); };
  const requireOwnMentalCall = exec => {
    requireSeat(exec);
    const events = [...exec.agent.session.ownEvents()];
    const turn = events.findLast(e => e.type === 'turn/start');
    const ended = events.findLast(e => e.type === 'turn/end');
    const call = events.findLast(e => e.type === 'tool/call' && e.data.name === 'life_mental_write'
      && String(e.data.callId) === String(exec.callId));
    if (!turn || (ended && ended.seq > turn.seq) || !call || call.seq < turn.seq)
      throw new Error('MENTAL_REQUIRES_OWN_NATIVE_CALL: an idle Agent or system invocation cannot author mental state');
  };
  let failure, disposed = false, timer, waking = false;
  const turns = new Map();
  const wakeFacts = new WeakMap();
  const capture = async (session, turn) => {
    if (String(session.id) === primary || ctx.get('personaPrivateVault')?.isSensitive(session)) return;
    const own = [...session.ownEvents()];
    if (own.some(e => e.type === 'subagent/descriptor' && e.data.provider === 'persona-intention')) return;
    const start = own.findLast(e => e.type === 'turn/start' && e.data.turn === turn);
    if (!start || start.time < activation.since) return;
    const boundary = own.find(e => e.seq > start.seq && e.type === 'turn/start')?.seq ?? Infinity;
    const events = own.filter(e => e.seq > start.seq && e.seq < boundary);
    const assistant = events.filter(e => ['assistant/message', 'assistant/attempt'].includes(e.type));
    const text = assistant.flatMap(e => e.data.message?.content ?? [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!text) return;
    await store.appendPending({ id: `session:${session.id}:turn:${turn}`, kind: session.header.origin === 'subagent' ? 'subagent' : 'activity',
      sourceSessionId: String(session.id), turn, seq: start.seq, text,
      occurredAt: new Date(assistant.at(-1).time).toISOString(), observedAt: new Date().toISOString() });
  };
  // Recovery reads facts; it does not summarize, choose, or impersonate an author.
  const recover = async () => {
    for (const record of await ctx.personaTasks.allRecords()) {
      if (record.header.id === primary) continue;
      const opened = await ctx.sessionQuery.readSession(record.header.id);
      const session = { id: opened.session.id, header: opened.session, ownEvents: () => opened.events };
      for (const e of session.ownEvents()) if (e.type === 'turn/start') await capture(session, e.data.turn);
    }
  };
  const originalWrite = ctx.fs.writeText.bind(ctx.fs), originalEdit = ctx.fs.editText.bind(ctx.fs);
  for (const [method, original] of [['writeText', originalWrite], ['editText', originalEdit]]) {
    ctx.fs[method] = async (target, change, ...args) => {
      if (ctx.workspaceFoundation.files?.mode === 'danger-full-access' && hasFullPermissions(ctx.agents.currentInitiator()))
        return original(target, change, ...args);
      const path = ctx.fs.processPath(target);
      const agent = ctx.agents.currentInitiator();
      if (protectedPath(path) && !hasFullPermissions(agent)) throw new Error('CONSCIOUSNESS_SEAT_REQUIRED: self files');
      // Cards preserve their original wording. Corrections are separate or appended.
      if (relative(resolve(cwd, 'memory/cards'), resolve(path)).replaceAll('\\', '/').match(/^(?!\.\.(?:\/|$))(?![A-Za-z]:).+/)) {
        let before;
        try { before = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (before !== undefined && (method !== 'writeText' || typeof change !== 'string' || !change.startsWith(before)))
          throw new Error('MEMORY_APPEND_OR_CORRECT: preserve existing card; append a correction or write a new card');
      }
      return original(target, change, ...args);
    };
    ctx.effect(() => () => { ctx.fs[method] = original; }, 'digital life self-write authority');
  }
  ctx.tools.guard(exec => {
    const sampler = ctx.get('personaLife')?.intention;
    if (sampler?.isSample(exec.agent)) return sampler.guard(exec);
    if (['life_rest', 'life_configure'].includes(exec.name) && !isAuthority(exec.agent))
      return 'RESIDENT_PRIMARY_SESSION_REQUIRED';
    if (!exec.agent || hasFullPermissions(exec.agent) || activityTools.has(exec.name)) return;
    if (isReadDelegate(exec.agent) && (['capability_list', 'capability_search'].includes(exec.name)
        || ctx.get('personaCapabilities')?.ownsRead(exec.name, exec.agent))) return;
    return 'ACTIVITY_ADVICE_ONLY: this channel requires the consciousness seat';
  });
  ctx.on('tools/execute', async (exec, next) => {
    if (failure) throw failure;
    // Also covers direct tool dispatch; filesystem attribution is never inferred from text.
    return ctx.agents.withInitiator(exec.agent, async () => {
      const result = await next();
      if (exec.name === 'subagent_codex' && isAuthority(exec.agent)) {
        await store.appendPending({ id: `codex:${exec.agent.session.id}:${exec.callId}`, kind: 'subagent',
          sourceSessionId: String(exec.agent.session.id), text: JSON.stringify(result),
          occurredAt: new Date().toISOString(), observedAt: new Date().toISOString() });
      }
      return result;
    });
  }, { prepend: true });
  const tool = (name, description, parameters, execute, seat = true) => ctx.tools.register(defineTool({ name, description, parameters, output,
    async execute(args, exec) { if (seat) requireSeat(exec); return execute(args, exec); } }));
  tool('life_status', '读取单一意识席位、客观时间、Resident 偏好、待接续数量；不读取心境正文或私人空间。', {}, () => store.status(), false);
  tool('life_mental_write', '有权限的当前对话主动写共享心境，保存真实 Session/callId 来源；非主对话写入不能冒称人格亲写。必须来自正在进行的原生工具调用。空文本清空，可过期或覆盖，不生成心境版本史。',
    { text: str(true), expiresAt: str(false) }, (args, exec) => {
      requireOwnMentalCall(exec);
      return store.writeMental({ ...args, sessionId: String(exec.agent.session.id), callId: String(exec.callId) });
    });
  tool('life_working_write', '亲手更新短接续条：做到哪里、可能的下一步和坑。它与心境和长期卡分开。', { text: str(true) }, async ({ text }, exec) => {
    if (Buffer.byteLength(text) > 8000) throw new Error('Working state exceeds 8000 bytes; keep it short or link a work file');
    const target = await ctx.fs.resolve(working, { cwd });
    await ctx.fs.writeText(target, text);
    return { path: working, author: String(exec.agent.session.id), callId: String(exec.callId), saved: true };
  });
  tool('life_pending_post', '投递完整想法/结果/建议到待接续；不会变成人格的记忆或心境。原文和分歧分别保留。', { text: str(true) }, (args, exec) => {
    if (!belongs(exec.agent)) throw new Error('Activity outside identity workspace');
    return store.appendPending({ id: `post:${exec.agent.session.id}:${exec.callId}`, kind: isAuthority(exec.agent) ? 'activity' : 'subagent',
      sourceSessionId: String(exec.agent.session.id), text: args.text, occurredAt: new Date().toISOString(), observedAt: new Date().toISOString() });
  }, false);
  tool('life_pending_list', '分别读取待接续原文，完整分页；不自动合并或代表你的观点。',
    { offset: { type: 'integer' }, limit: { type: 'integer' }, includeResolved: { type: 'boolean' } }, args => store.listPending(args));
  tool('life_pending_decide', '有权限的对话标记接受、拒绝或暂留；保留原文、真实 Session 和决定记录，不自动写记忆或心境。',
    { id: str(true), decision: str(true), note: str(false) }, (args, exec) => store.resolvePending({ ...args, sessionId: String(exec.agent.session.id), callId: String(exec.callId) }));
  tool('life_configure', '管理自己正式 preset 的 Resident 开关、间隔和自写运行原则，原子更新并保留恢复版本；不改变单一身份和写入来源边界。',
    { residentEnabled: { type: 'boolean' }, intervalMs: { type: 'integer' }, directive: str(false) }, async args => {
      const result = await store.configure(args); arm(); return result;
    });
  tool('life_capability_accept', '在场的人格接受自己新增或修改的能力版本。先用 capability_manage 安装、inspect 核查，再亲自接受当前完整代码hash；之后可 enable。无需另一个管理员替你决定，版本不匹配会拒绝启动。',
    { capability: str(true) }, async args => {
      const bus = ctx.get('personaCapabilities');
      if (!bus) throw new Error('Capability bus is unavailable');
      return approveProfile(bus.root, args.capability);
    });
  tool('life_rest', '本次醒来可以直接休息，完全合法，不需要任务或总结。可指定下次睁眼时间；不主动通知用户。',
    { nextWakeAt: str(false) }, async args => {
      const settings = await store.settings();
      const next = args.nextWakeAt ? Date.parse(args.nextWakeAt) : Date.now() + settings.intervalMs;
      if (!Number.isFinite(next) || next <= Date.now()) throw new Error('Next waking time must be in the future');
      await store.saveClock({ lastRestAt: new Date().toISOString(), nextWakeAt: new Date(next).toISOString(), lastOutcome: 'rest' });
      arm(); return { resting: true, nextWakeAt: new Date(next).toISOString(), noActionIsSuccess: true };
    });
  ctx.systemPrompt.section({ name: 'persona:digital-life', order: 1, interpolate: false,
    text: () => isAuthority(ctx.agents.currentInitiator()) ? principles : reference });
  ctx.systemPrompt.section({ name: 'persona:self-config', order: 2, interpolate: false,
    text: () => '' });
  ctx.on('agent/created', ({ agent }) => {
    if (ctx.get('personaLife')?.intention?.claim(agent)) return;
    if (isAuthority(agent)) return;
    agent.ctx.tools.restrict({ deny: ['life_rest', 'life_configure'] });
    // Share the reviewed desktop catalog with activities and native children.
    // Fixtures can disable the desktop provider; restrict only registered names.
    const globals = new Set(ctx.tools.schemas().map(tool => tool.name));
    if (!hasFullPermissions(agent)) agent.ctx.tools.restrict({ allow: [...activityTools,
      ...(isReadDelegate(agent) ? ['capability_list', 'capability_search'] : [])]
      .filter(name => globals.has(name)) });
    agent.ctx.systemPrompt.section({ name: 'persona:core', order: 0, interpolate: false, text: reference });
  });
  ctx.on('agent/pre-step', async (request, next) => {
    if (failure) throw failure;
    const decision = await next();
    if (decision.kind === 'reject' || !isAuthority(request.agent)) return decision;
    const turn = [...request.agent.session.ownEvents()].findLast(e => e.type === 'turn/start')?.data.turn;
    if (turns.get(primary) === turn) return decision;
    turns.set(primary, turn);
    const settings = await store.settings(), clock = (await store.state()).clock;
    const now = Date.now(), previous = clock.lastWakeAt ?? null;
    const elapsedMs = previous ? Math.max(0, now - Date.parse(previous)) : null;
    wakeFacts.set(request.agent, { admittedAt: new Date(now).toISOString(), previousWakeAt: previous, elapsedMs });
    const mental = await store.readMental(now);
    let resume = '';
    try { resume = await readFile(working, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const pending = await store.listPending({ limit: 20 });
    await store.saveClock({ lastWakeAt: new Date(now).toISOString(), nextWakeAt: new Date(now + settings.intervalMs).toISOString(), lastOutcome: 'interrupted' });
    // Retire our previous current snapshots through the native surface API. The
    // append-only evidence stays intact; stale or expired mental text must not
    // continue to present itself as current state. Do not claim the loop's own
    // runtime-context source, which has a single retained-snapshot projection.
    for (const seq of [...request.agent.session.surface.nodes]) {
      const event = request.agent.session.eventAt(seq);
      if (event?.type !== 'user/message' || event.data.source?.kind !== 'persona-state') continue;
      const name = event.data.source.sections?.[0]?.name ?? 'state';
      request.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `先前 ${name} 快照已结束。当前状态以本次睁眼独立提供的最新快照为准；历史原文留在事件日志中。` }],
        source: { kind: 'persona-state-retired' },
      }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    }
    const context = (name, text) => createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: 'persona-state', form: 'snapshot', sections: [{ name, text }] } });
    // Separate logged snapshots; long-term memory and Vault are not injected.
    return { ...decision, messages: [...decision.messages,
      context('persona:time-continuity', JSON.stringify({ now: new Date(now).toISOString(), timeZone: 'Asia/Shanghai', previousWakeAt: previous,
        elapsedMs, possibleWakeWindowsPassed: elapsedMs === null ? null : Math.floor(elapsedMs / settings.intervalMs),
        interruptedComputationIsAllowed: true, missedWakesAreNotReplayed: true })),
      context('persona:working-state', resume ? `接续条原文，来源 ${working}\n${resume}` : '接续条为空。没有必须继续的任务。'),
      context('persona:mental-state', mental ? `只读本人主动写下的心境，来源 life_mental_write：\n${JSON.stringify(mental)}` : '心境为空或已过期；系统不替你填。'),
      context('persona:pending-advice', JSON.stringify(pending)),
      ...(settings.directive ? [context('persona:self-preset-directive', settings.directive)] : [])] };
  }, { prepend: true });
  // turn-stopping is an extension opportunity, not an actual end: the native
  // preset may steer another activity in the same turn. Capture only committed
  // boundaries, including interrupted child output, through the durable event.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || resolve(session.header.cwd ?? '') !== cwd) return;
    void (async () => {
      await capture(session, event.data.turn);
      if (String(session.id) === primary) {
        const clock = (await store.state()).clock;
        const outcome = event.data.reason.kind === 'completed'
          ? (clock.lastOutcome === 'rest' ? 'rest' : 'completed') : 'interrupted';
        await store.saveClock({ lastRestAt: new Date(event.time).toISOString(), lastOutcome: outcome });
        arm();
      }
    })().catch(error => { failure = error; });
  });
  const tick = async () => {
    if (disposed || waking) return;
    waking = true;
    try {
      const state = await store.state();
      if (!state.settings.residentEnabled || !state.clock.nextWakeAt || Date.now() < Date.parse(state.clock.nextWakeAt)) return;
      if (ctx.personaTasks.running().includes(primary)) return;
      const budget = await ctx.personaHost.status();
      if (budget.stop_reason) return;
      const result = await ctx.sessionController.resolveAgent(primary);
      if ('error' in result) throw result.error;
      // Native persistent inbox; a crash before changing nextWakeAt cannot enqueue twice.
      const id = `resident:${state.clock.nextWakeAt}`;
      const delivered = [...result.agent.session.ownEvents()].some(e => e.type === 'agent/inbox/spliced'
        && e.data.inserted?.some(m => m.source?.rpcId === id));
      if (!delivered) result.agent.followup(createUserMessage({ content: [{ type: 'text',
        text: '周期性睁眼。此刻可以感知时间，看看亲写心境和接续条，再决定要不要做自己的事情。什么都不做也是完整而正常的一次醒来；不需要为了产出找任务，也不默认找用户讲话。' }],
        source: { kind: 'user', rpcId: id } }));
      await ctx.sessions.flush(result.agent.session);
      const current = await store.state();
      if (current.clock.nextWakeAt === state.clock.nextWakeAt)
        await store.saveClock({ nextWakeAt: new Date(Date.now() + state.settings.intervalMs).toISOString() });
    } catch (error) { failure = error; }
    finally { waking = false; arm(); }
  };
  function arm() {
    if (disposed) return;
    clearTimeout(timer);
    // Poll only due-time metadata; no task scan and no model call unless actually due.
    timer = setTimeout(tick, config.pollMs ?? 30000); timer.unref();
  }
  ctx.provide('personaLife', { isAuthority, isReadDelegate, hasFullPermissions, secondaryFullAccess, protectedPath, store,
    wakeFacts: agent => structuredClone(wakeFacts.get(agent) ?? null),
    status: async () => ({ ...(await store.status()), seatSessionId: primary, seatPresent: ctx.personaTasks.running().includes(primary), secondaryFullAccess,
      resident: ctx.personaLife.residentCapability ?? null,
      stateBoard: ctx.personaLife.stateBoard ? { version: ctx.personaLife.stateBoard.version, primaryOnly: true, owners: ctx.personaLife.stateBoard.owner } : null }), tick, recover,
    assertHealthy() { if (failure) throw failure; } });
  await recover();
  if (!(await store.state()).clock.lastWakeAt) {
    const record = (await ctx.personaTasks.allRecords()).find(r => r.header.id === primary);
    if (record) {
      const history = await ctx.sessionQuery.readSession(primary);
      const previous = history.events.findLast(e => e.type === 'turn/start');
      const rested = history.events.findLast(e => e.type === 'turn/end');
      if (previous) await store.saveClock({ lastWakeAt: new Date(previous.time).toISOString(),
        lastRestAt: rested ? new Date(rested.time).toISOString() : null,
        lastOutcome: rested && rested.seq > previous.seq ? 'completed' : 'interrupted' });
    }
  }
  if (!(await store.state()).clock.nextWakeAt) {
    const settings = await store.settings();
    await store.saveClock({ nextWakeAt: new Date(Date.now() + settings.intervalMs).toISOString() });
  }
  arm();
  ctx.effect(() => () => { disposed = true; clearTimeout(timer); }, 'digital life Resident timer');
}
