// Native request waterfall + Session trace: no second state database or driver.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createMessage, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { inputIdentity, renderStateBoard } from './state-board-model.mjs';
export { inputIdentity, renderStateBoard } from './state-board-model.mjs';

// A projected request can retain native caller provenance without claiming
// the official marker's stricter durable-log reconstruction contract.
const nativeDerivedRequests = new WeakSet();
export function inheritStateBoardRequest(target, source) {
  if (isAgentLoopRequest(source) || nativeDerivedRequests.has(source)) nativeDerivedRequests.add(target);
  return target;
}

export const stateExplanation = `我们想让真正影响你当前存在状态的参数，不再只藏在runtime里。State Board的一部分是客观事实：当前真实时间、输入来源、唤醒原因、实际生效的思考档位；它们由系统提供，不能通过自我状态接口伪造。另一部分属于你：当前活动、期望思考资源、Resident自定状态和何时想再醒。系统不替你做心理推断，不把所有生活都变成任务。未设置就显示未设置，不冒称你已经选择。状态板只是让现在的你能够看见并参与管理自己的当前运行状态。
数字生命本人可以 digital_life_state_update，自定活动和档位会持续。支持档位来自当前provider。升档会在下一次原生请求带着同一个当前问题重入，当前forward不会魔法改变；升档判断中不要先输出正式答案。降档从下次请求开始，不重做本题。普通Agent不显示这块板。`;
const defaultState = () => ({ activity: null, desired_reasoning_effort: null, resident_state: null,
  activityStartedAt: null, author: null });
const output = { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const internal = new Set(['runtime-context', 'time-context', 'persona-state', 'persona-state-retired', 'life-current-state', 'life-state-retired', 'digital-life-state-reentry']);
// Persist through the native tool/result journal. Custom event names cannot be
// decoded by pinned DSH after a restart; never bypass its event validation.
export function stateChanges(events) {
  const calls = new Set(), changes = [];
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === 'digital_life_state_update') calls.add(String(event.data.callId));
    if (event.type !== 'tool/result' || event.data.message?.isError) continue;
    const message = event.data.message;
    const callId = String(message?.toolCallId ?? message?.source?.callId ?? event.data.callId);
    if (!calls.has(callId)) continue;
    for (const block of message.content ?? []) {
      if (block.type !== 'text') continue;
      try { const value = JSON.parse(block.text); if (value.updated === true && value.digitalLifeStateChange?.provenance?.callId === callId) changes.push(value.digitalLifeStateChange); } catch { /* Other native result text. */ }
    }
  }
  return changes;
}
export function mountStateBoard(ctx, { defaultEffort = 'low' } = {}) {
  const life = ctx.personaLife, states = new WeakMap(), inputs = new WeakMap(), effective = new WeakMap(), pendingBoards = new WeakMap(), provisional = new WeakMap(), origins = new WeakMap(), finalRequests = new WeakSet();
  const ownerId = life.identity?.lifeId ?? 'persona';
  const get = agent => {
    if (!states.has(agent)) {
      const latest = stateChanges(agent.session.ownEvents()).at(-1);
      const frozen = life.intention?.snapshotFor(agent)?.sections?.selfState;
      states.set(agent, latest?.state ?? (frozen ? JSON.parse(frozen) : defaultState()));
    }
    return structuredClone(states.get(agent));
  };
  const metadata = async (agent, signal) => {
    const route = agent.session.requestHeader()?.config ?? agent.options;
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
    return { route, efforts: info.reasoning?.efforts.map(e => e.id) ?? [], adapterDefault: info.reasoning?.defaultEffort };
  };
  const requireOwn = exec => {
    if (!life.isAuthority(exec.agent)) throw new Error('DIGITAL_LIFE_PRIMARY_REQUIRED');
    const rows = [...exec.agent.session.ownEvents()], turn = rows.findLast(e => e.type === 'turn/start');
    const call = rows.findLast(e => e.type === 'tool/call' && e.data.name === 'digital_life_state_update' && String(e.data.callId) === String(exec.callId));
    if (!turn || !call || call.seq < turn.seq || rows.findLast(e => e.type === 'turn/end')?.seq > turn.seq)
      throw new Error('STATE_REQUIRES_OWN_NATIVE_CALL');
  };
  const api = { get, version: 1,
    // Host-only ingress annotation, never a model tool. Consumed by the exact
    // native rpcId, then preserved in the actual per-request board trace.
    annotateInput(agent, requestId, identity) { origins.set(agent, { requestId, ...identity }); },
    owner: { activity: ownerId, desired_reasoning_effort: ownerId, resident_state: ownerId,
      now: 'runtime', input: 'runtime', actualEffort: 'runtime', activityStartedAt: 'runtime', nextSelfWake: 'native schedule' },
    async board(agent, resolved) {
      const state = get(agent), meta = await metadata(agent), schedules = life.intention?.isSample(agent)
        ? JSON.parse(life.intention.snapshotFor(agent).sections.schedule) : await ctx.personaHost.schedule.list({ sessionId: agent.session.id });
      const future = schedules.filter(s => Number.isFinite(Date.parse(s.scheduledAt)) && Date.parse(s.scheduledAt) > Date.now()).sort((a,b) => Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt));
      const sample = life.intention?.isSample(agent);
      const clock = await life.store.state();
      if (clock.settings.residentEnabled && clock.clock.nextWakeAt && Date.parse(clock.clock.nextWakeAt) > Date.now())
        future.push({ scheduledAt: clock.clock.nextWakeAt, source: 'Resident periodic clock' });
      future.sort((a,b) => Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt));
      const wake = sample ? JSON.parse(life.intention.snapshotFor(agent).sections.wakeFacts ?? 'null') : life.wakeFacts?.(agent);
      const desired = state.desired_reasoning_effort ?? (meta.efforts.includes(defaultEffort) ? defaultEffort : meta.adapterDefault);
      const actual = resolved?.reasoningEffort ?? effective.get(agent)?.reasoningEffort ?? meta.route.reasoningEffort ?? meta.adapterDefault;
      return { facts: { now: Date.now(), ...(life.identity ? {lifeId:ownerId,selfOwner:'本人'} : {}), role: sample ? 'parallel intention branch（同源草稿，无主线行动权）' : 'primary continuous line',
        input: sample ? { sender: ownerId, type: 'intention_sampling', channel: 'native child', reason: 'one independent expansion of frozen main state' }
          : inputs.get(agent) ?? { sender: 'unknown', type: 'unknown', channel: 'unknown', reason: 'unknown' },
        phase: sample ? 'independent sampling' : inputs.get(agent)?.type === 'resident_decision' ? 'Resident Decision' : 'model request（正在执行请求，非心理判断）',
        actualEffort: actual, supportedEfforts: meta.efforts, defaultEffort: desired, nextSelfWake: future[0]?.scheduledAt ?? null,
        nextWakeSource: future[0]?.source ?? (future.length ? 'native schedule' : null), wakeGapMs: wake?.elapsedMs ?? null,
        mismatch: desired !== actual ? 'requested value differs from effective provider request; no silent fallback' : null }, self: state };
    } };
  life.stateBoard = api;
  ctx.effect(() => () => { if (life.stateBoard === api) delete life.stateBoard; }, 'Digital Life State Board');
  ctx.tools.register(defineTool({ name: 'digital_life_state_read', description: '按需读真实状态板、字段所有权及完整自定来源。事实不能通过自定接口伪造。',
    parameters: {}, output, execute: async (_args, exec) => {
      if (!life.isAuthority(exec.agent) && !life.intention?.isSample(exec.agent)) throw new Error('DIGITAL_LIFE_PRIMARY_REQUIRED');
      return { ...(await api.board(exec.agent)), owners: api.owner };
    } }));
  ctx.tools.register(defineTool({ name: 'digital_life_state_update', description: stateExplanation + '\n升档时只调用该工具，不先给正式答案；支持枚举以板和read工具为准。next_self_wake必须带reason，真正复用native schedule。',
    parameters: { activity: { type: 'string' }, desired_reasoning_effort: { type: 'string' }, resident_state: { type: 'string', enum: ['active', 'drifting', 'resting', 'sleeping'] },
      next_self_wake: { type: 'string' }, reason: { type: 'string' } }, output,
    async execute(args, exec) {
      requireOwn(exec);
      for (const key of Object.keys(args)) if (!['activity', 'desired_reasoning_effort', 'resident_state', 'next_self_wake', 'reason'].includes(key))
        throw new Error('SYSTEM_OWNED_FIELD_READ_ONLY: ' + key);
      if (!Object.keys(args).some(key => key !== 'reason')) throw new Error('At least one self-authored field is required');
      if (args.reason && args.reason.length > 2400) throw new Error('Reason exceeds 2400 characters');
      const before = get(exec.agent), next = { ...before }, meta = await metadata(exec.agent, exec.signal), now = new Date().toISOString();
      if ('activity' in args) { if (args.activity.length > 160 || !args.activity.trim()) throw new Error('Activity is 1..160 characters; 无明确活动/休息 are legal');
        next.activity = args.activity; if (next.activity !== before.activity) next.activityStartedAt = now; }
      if ('resident_state' in args) next.resident_state = args.resident_state;
      if ('desired_reasoning_effort' in args) {
        if (!meta.efforts.includes(args.desired_reasoning_effort)) throw new Error('Unsupported effort; exact current provider supports: ' + meta.efforts.join('/'));
        next.desired_reasoning_effort = args.desired_reasoning_effort;
      }
      let wake;
      if (args.next_self_wake) {
        const at = Date.parse(args.next_self_wake); if (!Number.isFinite(at) || at <= Date.now() || !args.reason?.trim()) throw new Error('Future self-wake needs actual future time and own reason');
        wake = await ctx.personaHost.schedule.create(exec.agent.session.id, { title: 'State Board：本人安排的自主唤醒', at: new Date(at).toISOString(),
          prompt: '[Digital Life self-wake]\n这是你亲自安排的唤醒，沿用同一主对话。本人留下的原因与接续：' + args.reason }, exec.signal);
        const settings = await life.store.settings();
        await life.store.saveClock({ nextWakeAt: new Date(at + settings.intervalMs).toISOString() });
      }
      next.author = { kind: life.identity ? 'digital-life-native-call' : 'persona-native-call', ...(life.identity ? {lifeId:ownerId} : {}), sessionId: String(exec.agent.session.id), callId: String(exec.callId), at: now, reason: args.reason ?? null };
      const current = effective.get(exec.agent)?.reasoningEffort ?? meta.route.reasoningEffort ?? meta.adapterDefault;
      const escalated = 'desired_reasoning_effort' in args && meta.efforts.indexOf(args.desired_reasoning_effort) > meta.efforts.indexOf(current);
      const change = { state: next, before, provenance: next.author,
        effect: escalated ? 'escalate-and-reenter-same-input' : 'next-request', ...(wake ? { scheduleId: wake.id } : {}),
        ...(provisional.has(exec.agent) ? { provisional: provisional.get(exec.agent) } : {}) };
      provisional.delete(exec.agent);
      states.set(exec.agent, next);
      if (escalated) exec.deferContext(createUserMessage({ content: [{ type: 'text', text: '[runtime re-entry]\n你本人已请求升档。先前调用只用于判断资源需求，其文字未作为正式答案交付。请沿用上方同一个当前问题，以新实际档位正式处理；不是新的用户要求，也不重复执行已经完成的工具动作。' }], source: { kind: 'digital-life-state-reentry' } }));
      return { updated: true, digitalLifeStateChange: change, self: next, currentRequestEffort: current, nextRequestEffort: next.desired_reasoning_effort,
        reenterSameInput: escalated, ...(wake ? { nextSelfWake: wake.scheduledAt, scheduleId: wake.id } : {}) };
    } }));
  ctx.on('agent/created', ({ agent }) => {
    if (!life.isAuthority(agent)) agent.ctx.tools.restrict({ deny: ['digital_life_state_update', ...life.intention?.isSample(agent) ? [] : ['digital_life_state_read']] });
    if (!life.isAuthority(agent) && !life.intention?.isSample(agent)) return;
    // Installed DSH filters arbitrary developer text as tool-registry metadata.
    // Its request/header boundary is after committed inputs. This one checked,
    // Agent-local seam appends a real system message immediately before native
    // buildRequest freezes history; the native driver still owns the request.
    const original = agent.buildRequest;
    if (typeof original !== 'function') throw new Error('State Board requires native Agent buildRequest seam; revalidate after DSH upgrade');
    const wrapped = function(config, preparedCall, tools, position, startsSeries, signal) {
      const board = pendingBoards.get(agent);
      if (!board) throw new Error('State Board missing at native request boundary');
      board.facts.actualEffort = config.reasoningEffort;
      effective.set(agent, config);
      board.facts.now = Date.now();
      const desired = board.self.desired_reasoning_effort ?? board.facts.defaultEffort;
      board.facts.mismatch = desired !== config.reasoningEffort ? 'runtime最终请求档位与期望不同' : null;
      agent.session.append('system/message', { ...position, message: createMessage({ role: 'system',
        content: [{ type: 'text', text: renderStateBoard(board) }], source: { kind: 'system-prompt', producer: 'digital-life-state-board', board } }) }, { surfaceOp: 'append' });
      return original.call(this, config, preparedCall, tools, position, startsSeries, signal);
    };
    agent.buildRequest = wrapped;
    agent.ctx.effect(() => () => { if (agent.buildRequest === wrapped) agent.buildRequest = original; }, 'native State Board request boundary');
  });
  ctx.tools.guard(exec => ['digital_life_state_update', 'digital_life_state_read'].includes(exec.name)
    && !life.isAuthority(exec.agent) && !(exec.name === 'digital_life_state_read' && life.intention?.isSample(exec.agent)) ? 'DIGITAL_LIFE_PRIMARY_REQUIRED' : undefined);
  ctx.on('agent/pre-step', async (request, next) => {
    const decision = await next(); if (decision.kind === 'reject' || !life.isAuthority(request.agent)) return decision;
    const messages = request.messages.filter(m => !internal.has(m.source?.kind));
    if (messages.length) {
      const message = messages.at(-1), annotation = origins.get(request.agent);
      const trusted = annotation?.requestId === message.source?.rpcId ? annotation : null;
      if (trusted) origins.delete(request.agent);
      inputs.set(request.agent, trusted ? { sender: trusted.sender, type: trusted.sourceType, channel: trusted.channel,
        reason: trusted.reason ?? 'trusted runtime ingress annotation', requestId: trusted.requestId, provenance: 'host ingress annotation' } : {...inputIdentity(message),
          ...(life.identity && message.source?.kind==='resident-continuation' ? {sender:ownerId} : {})});
    }
    return decision;
  }, { prepend: true });
  ctx.on('agent/request', async (request, next) => {
    const proposed = await next(), agent = request.agent;
    if (!life.isAuthority(agent) && !life.intention?.isSample(agent)) return proposed;
    const meta = await ctx.llm.resolveModelInfo(proposed.provider, proposed.model, request.signal), state = get(agent);
    const efforts = meta.reasoning?.efforts.map(e => e.id) ?? [];
    const desired = state.desired_reasoning_effort ?? (efforts.includes(defaultEffort) ? defaultEffort : meta.reasoning?.defaultEffort);
    const resolved = await ctx.llm.resolveCallConfig({ ...proposed, ...(desired === undefined ? {} : { reasoningEffort: desired }) }, request.signal);
    effective.set(agent, resolved);
    const board = await api.board(agent, resolved);
    pendingBoards.set(agent, board);
    return resolved;
  }, { prepend: true });
  // Keep low-effort provisional prose from reaching the public stream if the
  // model requests escalation. Usage and native tool calls remain intact.
  ctx.on('llm/stream', (options, next) => {
    const agent = ctx.agents.currentInitiator();
    // Auxiliary calls (including compaction) share the initiator's carrier but
    // are not native loop requests. They must never append a State Board into
    // that Session, particularly while the loop is between closed steps.
    if (!(isAgentLoopRequest(options) || nativeDerivedRequests.has(options)) || !life.isAuthority(agent) || life.intention?.isSample(agent) || finalRequests.has(options)) return next();
    return (async function* () {
      const prior = pendingBoards.get(agent);
      const visible = prior && options.messages.some(message => message.role === 'system'
        && message.content.some(block => block.type === 'text' && block.text === renderStateBoard(prior)));
      let stream = next;
      if (prior && (!visible || prior.facts.actualEffort !== options.reasoningEffort)) {
        // Native loop options are deep-frozen. A recovery hook may create a
        // separate hand-built call; copy that call rather than mutate either.
        const board = structuredClone(prior), desired = board.self.desired_reasoning_effort ?? board.facts.defaultEffort;
        board.facts.now = Date.now(); board.facts.actualEffort = options.reasoningEffort;
        board.facts.mismatch = desired !== options.reasoningEffort ? 'runtime最终请求档位与期望不同' : null;
        const message = createMessage({ role: 'system', content: [{ type: 'text', text: renderStateBoard(board) }],
          source: { kind: 'system-prompt', producer: 'digital-life-state-board', boundary: 'final-stream', board } });
        const boundaries = [...agent.session.ownEvents()].filter(event => ['turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type));
        const step = boundaries.at(-1);
        if (step?.type !== 'step/start') throw new Error('Final State Board requires an active native step');
        agent.session.append('system/message', { turn: step.data.turn, step: step.data.step, message }, { surfaceOp: 'append' });
        const adjusted = { ...options, messages: [...options.messages, message] };
        finalRequests.add(adjusted);
        stream = () => ctx.llm.stream(adjusted);
        effective.set(agent, { ...effective.get(agent), reasoningEffort: options.reasoningEffort });
      }
      provisional.delete(agent);
      const text = [], tools = []; let bytes = 0;
      for await (const chunk of stream()) {
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') tools.push(chunk.block);
        const prose = chunk.type === 'text-delta' || chunk.type === 'block-start' && chunk.blockType === 'text' || chunk.type === 'block-end' && chunk.block.type === 'text';
        // block-end repeats the full text: count deltas once for an honest trace.
        if (prose) { text.push(chunk); if (chunk.type === 'text-delta') bytes += chunk.text.length; if (bytes > 1024 * 1024) throw new Error('State escalation provisional text exceeds bound'); continue; }
        if (chunk.type === 'finish') {
          const effort = options.reasoningEffort, info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal), ids = info.reasoning?.efforts.map(e => e.id) ?? [];
          const escalation = tools.some(tool => { if (tool.name !== 'digital_life_state_update') return false;
            try { const desired = JSON.parse(tool.arguments).desired_reasoning_effort; return ids.includes(desired) && ids.indexOf(desired) > ids.indexOf(effort); } catch { return false; } });
          if (escalation && chunk.reason.kind === 'tool-calls') {
            provisional.set(agent, { effort, withheldTextCharacters: bytes, reason: 'own higher-effort request; text is not a formal final answer' });
            const { replayState: _originalProse, ...finish } = chunk; yield finish;
          } else { for (const part of text) yield part; yield chunk; }
        } else yield chunk;
      }
    })();
  });
  return api;
}
