// Pressure requests authorship in the normal Agent loop. No auxiliary summary call.
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { inheritStateBoardRequest } from './digital-life/state-board.mjs';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createHash } from 'node:crypto';
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';

export const pressureDefaults = { triggerRatio: 0.70, authorMaxTokens: 8192, marginTokens: 8192, maxAuthorSteps: 16, viewBytes: 180000 };
// A projected request's usage calibrates the small view, not the untouched full
// surface. Keep this transaction's view sticky, including across Host restarts.
export function needsAuthorCapacityView(session, pending, generation, fits) {
  if (!pending) return false;
  return !fits || [...session.ownEvents()].some(e => e.seq > generation && e.type === 'user/message'
    && e.data.source?.kind === 'self-compaction-view-manifest');
}
const eventsOf = session => [...session.ownEvents()];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const user = (text, source) => createUserMessage({ content: [{ type: 'text', text }], source });

// Retain provider calibration even when the temporary author output cap changes the header.
export function calibratedPressure(ctx, session) {
  let header, usageHeader;
  for (const e of session.ownEvents()) {
    if (e.type === 'request/header') header = e.data.header;
    if (e.type === 'assistant/message' && e.data.usage) usageHeader = header;
  }
  const current = ctx.tokenMeter.measure(session);
  const calibrated = usageHeader ? ctx.tokenMeter.measure(session, usageHeader) : current;
  return calibrated.totalTokens > current.totalTokens ? calibrated : current;
}

export function installAuthorPressure(ctx, engine, self, configuration = {}) {
  const config = { ...pressureDefaults, ...configuration };
  if (!(config.triggerRatio > 0 && config.triggerRatio < 1)) throw new Error('Invalid author pressure trigger');
  for (const key of ['authorMaxTokens', 'marginTokens', 'maxAuthorSteps', 'viewBytes'])
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error('Invalid author pressure bound: ' + key);
  const states = new WeakMap(), projected = new WeakSet();
  function state(agent) {
    if (!states.has(agent)) {
      const events = eventsOf(agent.session);
      const demand = events.findLast(e => e.type === 'user/message' && e.data.source?.kind === 'self-compaction-pressure');
      const summary = events.findLast(e => e.type === 'compaction/summary' && e.data.provider === 'self-authored');
      states.set(agent, { pending: !!demand && (!summary || demand.seq > summary.seq), steps: 0,
        generation: summary?.seq ?? -1, originalMaxTokens: demand?.data.source.originalMaxTokens,
        lastForced: demand?.data.source.forceSeq ?? -1 });
    }
    return states.get(agent);
  }
  function sync(agent) {
    const s = state(agent), summary = eventsOf(agent.session).findLast(e => e.type === 'compaction/summary' && e.data.provider === 'self-authored');
    if (summary && summary.seq > s.generation) { s.pending = false; s.steps = 0; s.generation = summary.seq; }
    return s;
  }
  async function metadata(agent, signal) {
    const route = agent.session.requestHeader()?.config ?? agent.options;
    if (!route.provider || !route.model) return null;
    const model = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
    const capacity = model.context?.contextWindow;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new LlmError('Unknown model context capacity; request withheld', 'CONTEXT_CAPACITY_UNKNOWN');
    return { capacity, output: route.maxTokens ?? model.defaultMaxTokens ?? 0 };
  }
  ctx.on('agent/pre-step', async (request, next) => {
    // Other providers assemble/retire their current snapshots inside next(); never append system at a closed step.
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const agent = request.agent, s = sync(agent), meta = await metadata(agent, request.signal);
    if (!meta) return decision;
    const measurement = calibratedPressure(ctx, agent.session);
    const forced = eventsOf(agent.session).findLast(e => e.type === 'tool/call' && e.data.name === 'context_compact');
    const force = forced && forced.seq > s.lastForced && forced.seq > s.generation;
    const pressure = measurement.totalTokens + meta.output + config.marginTokens >= meta.capacity * config.triggerRatio;
    if (!s.pending && (pressure || force)) {
      s.pending = true; s.steps = 0; s.originalMaxTokens = meta.output; s.lastForced = forced?.seq ?? s.lastForced;
      const text = `上下文需要由你本人整理。当前估算输入 ${measurement.totalTokens}，模型容量 ${meta.capacity}，常规输出预留 ${meta.output}。Host不会另请整理器代写。\n请暂停旧任务及外部操作，先 context_compact_prepare；保留比例和正文内容由你决定。根据你实际看到的原文自己取舍、书写 checkpoint，再 context_compact_commit，并用 context_compact_status确认 committed 后继续原任务。引用必须在prepare的来源集合内，计划变更需重新prepare。若当前处于容量恢复视图/轻量模式，你没有看到全部旧历史：先用 context_compact_read 或 session_event_read 查需要的旧检查点、决定与未完事项，不把未读到说成不存在。可以明确保留不确定和回查入口。不要重放已完成的工具。`;
      return { ...decision, messages: [...decision.messages, user(text, { kind: 'self-compaction-pressure', originalMaxTokens: meta.output, forceSeq: s.lastForced })] };
    }
    if (s.pending && ++s.steps > config.maxAuthorSteps)
      throw new LlmError('Author checkpoint was not committed within the reserved steps; original history retained. Resume authorship before continuing work.', 'SELF_COMPACTION_REQUIRED');
    return decision;
  });
  ctx.on('agent/request', async (request, next) => {
    const proposed = await next(), s = sync(request.agent);
    if (s.pending) return { ...proposed, maxTokens: Math.min(proposed.maxTokens ?? config.authorMaxTokens, config.authorMaxTokens) };
    if (s.originalMaxTokens) return { ...proposed, maxTokens: s.originalMaxTokens };
    return proposed;
  }, { prepend: true });
  const allowed = new Set(['context_compact_prepare', 'context_compact_commit', 'context_compact_status', 'context_compact_read',
    'session_event_read', 'session_event_trace', 'session_event_search', 'session_search', 'read', 'read_source', 'budget_status', 'recovery_diagnostics']);
  ctx.tools.guard(exec => exec.agent && sync(exec.agent).pending && !allowed.has(exec.name)
    ? 'SELF_COMPACTION_REQUIRED: write and commit your checkpoint before resuming other tools; do not replay completed actions' : undefined);

  async function authorView(agent, options, capacity) {
    const session = agent.session, events = eventsOf(session);
    const system = renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(agent, options.signal)));
    const limit = Math.min(config.viewBytes, Math.max(0, capacity - (options.maxTokens ?? 0) - config.marginTokens));
    const systemMessage = { role: 'system', content: [{ type: 'text', text: system }] };
    const baseCost = bytes(systemMessage) + bytes(options.tools ?? []);
    const noticeReserve = Math.min(4096, Math.floor(limit * 0.15));
    const nodes = session.surface.nodes, turn = events.findLast(e => e.type === 'turn/start')?.seq ?? 0;
    let from = nodes.findIndex(seq => seq >= turn);
    if (from < 0) from = nodes.length;
    // Keep only a balanced suffix that fits; excluded text remains searchable and is explicitly disclosed.
    let chosen = [], chosenSeqs = [];
    for (let index = nodes.length - 1; index >= from; index--) {
      const event = session.eventAt(nodes[index]), message = session.deriveEventMessage(event);
      if (!message || message.role === 'system') continue;
      if (baseCost + bytes([message, ...chosen]) > limit - noticeReserve) break;
      chosen.unshift(message); chosenSeqs.unshift(nodes[index]);
    }
    while (chosenSeqs.length && !toolPairingBalancedBefore(session, chosenSeqs[0])) { chosen.shift(); chosenSeqs.shift(); }
    const latestCheckpoint = nodes.map(seq => session.eventAt(seq)).findLast(e => e.type === 'user/message' && e.data.source?.kind === 'compact-checkpoint');
    const prior = latestCheckpoint && session.deriveEventMessage(latestCheckpoint);
    if (prior && baseCost + bytes([prior, ...chosen]) < limit - noticeReserve) { chosen.unshift(prior); chosenSeqs.unshift(latestCheckpoint.seq); }
    const notice = user('这是当前同一Agent、同一Session的容量恢复阅读视图，不是另一个整理器。旧上下文尚未被替换；你本轮没有看到全部旧历史。可见seq：' + chosenSeqs.join(',') +
      '。请先prepare，再按其来源页查旧检查点、决定与未完事项，自行决定保留内容并书写正文提交；不能凭当前视图宣称已读全部来源。其他工作暂停，已完成工具不要重放。', { kind: 'self-compaction-view' });
    const messages = [systemMessage, notice, ...chosen];
    if (bytes(messages) + bytes(options.tools ?? []) + (options.maxTokens ?? 0) + config.marginTokens >= capacity)
      throw new LlmError('Even the author recovery view cannot fit; no provider request sent and no history replaced', 'CONTEXT_WINDOW_EXCEEDED');
    session.append('user/message', user(JSON.stringify({ kind: 'author-capacity-view', visibleSeqs: chosenSeqs,
      omittedSurfaceNodes: nodes.length - chosenSeqs.length, inputHash: digest(messages), originalHistoryPreserved: true }), { kind: 'self-compaction-view-manifest' }), { surfaceOp: 'append' });
    await ctx.sessions.flush(session);
    const adjusted = { ...options, messages, toolHistory: undefined, purpose: 'self-author-capacity-view' };
    inheritStateBoardRequest(adjusted, options);
    return adjusted;
  }
  ctx.on('llm/stream', (options, next) => (async function* () {
    // Downstream middleware may clone options (e.g. state-board); object identity
    // alone cannot mark the nested, already projected request.
    if (options.purpose === 'self-author-capacity-view' || projected.has(options)) { yield* next(); return; }
    const agent = options.sessionId && ctx.agents.get(options.sessionId);
    if (!agent) { yield* next(); return; }
    if (options.purpose === 'compaction') throw new LlmError('Auxiliary compaction is disabled: author must write the checkpoint', 'SELF_COMPACTION_REQUIRED');
    const s = sync(agent), info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
    const capacity = info.context?.contextWindow;
    if (!Number.isSafeInteger(capacity)) throw new LlmError('Unknown model context capacity; no request sent', 'CONTEXT_CAPACITY_UNKNOWN');
    const output = options.maxTokens ?? info.defaultMaxTokens ?? 0;
    const conservativeBytes = bytes(options.messages) + bytes(options.tools ?? []);
    const estimate = calibratedPressure(ctx, agent.session).totalTokens;
    const fits = conservativeBytes + output + config.marginTokens < capacity || estimate + output + config.marginTokens < capacity;
    if (fits && !needsAuthorCapacityView(agent.session, s.pending, s.generation, fits)) { yield* next(); return; }
    if (!s.pending) throw new LlmError(`CONTEXT_WINDOW_EXCEEDED: input estimate ${estimate} + output ${output} + headroom ${config.marginTokens} cannot fit ${capacity}; request withheld`, 'CONTEXT_WINDOW_EXCEEDED');
    const adjusted = await authorView(agent, options, capacity);
    projected.add(adjusted);
    yield* ctx.llm.stream(adjusted);
  })(), { prepend: true });
  return { config, state: agent => ({ ...sync(agent) }), calibratedPressure: session => calibratedPressure(ctx, session) };
}
