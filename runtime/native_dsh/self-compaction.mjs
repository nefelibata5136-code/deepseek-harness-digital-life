// Author-written checkpoints. Uses native event/surface persistence, never an auxiliary LLM.
import { createHash, randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { compactCheckpointSource, toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { deriveEventMessage } from '@deepseek-ai/dsh-session';

export const selfCompactionTools = ['context_compact_prepare', 'context_compact_commit', 'context_compact_status', 'context_compact_read'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const TTL = 30 * 60 * 1000;
const resultValue = event => {
  if (event.type !== 'tool/result' || event.data.message.isError) return null;
  try { return JSON.parse(event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')); }
  catch { return null; }
};
const log = session => Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq));
function receipts(session) {
  const calls = new Map(), values = [];
  const expected = { prepared: 'context_compact_prepare', queued: 'context_compact_commit', cancelled: 'context_compact_status' };
  for (const event of log(session)) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data);
    const value = resultValue(event);
    const call = value && calls.get(event.data.message.toolCallId);
    if (!value || !expected[value.selfCompaction] || call?.name !== expected[value.selfCompaction]) continue;
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
    if (value.selfCompaction === 'queued' && (args?.plan_id !== value.planId || args?.checkpoint !== value.checkpoint || hash(value.checkpoint) !== value.checkpointHash)) continue;
    values.push(value);
  }
  return values;
}
const receipt = (session, kind, id) => receipts(session).findLast(v => v.selfCompaction === kind && (!id || v.planId === id));
const ended = (session, id) => log(session).findLast(e => e.type === 'compaction/end' && e.data.compactionId === id);
const digestSpan = (session, seqs) => hash(seqs.map(seq => session.eventAt(seq)));

export function installSelfCompaction(ctx, engine, originalSeqs) {
  function validate(session, plan, checkpoint) {
    if (!plan || plan.sessionId !== String(session.id)) throw new Error('SELF_COMPACT_PLAN_NOT_FOUND: prepare in this Session first');
    if (Date.now() > plan.expiresAt) throw new Error('SELF_COMPACT_PLAN_EXPIRED: prepare again; original history retained');
    const nodes = session.surface.nodes;
    const from = nodes.indexOf(plan.selectedSeqs[0]);
    if (from < 0 ||
        hash(nodes.slice(from, from + plan.selectedSeqs.length)) !== hash(plan.selectedSeqs) ||
        digestSpan(session, plan.selectedSeqs) !== plan.sourceDigest)
      throw new Error('SELF_COMPACT_RANGE_CHANGED: original history retained; prepare again');
    if (!toolPairingBalancedBefore(session, plan.selectedSeqs[0]) || !toolPairingBalancedAfter(session, plan.selectedSeqs.at(-1)))
      throw new Error('SELF_COMPACT_UNBALANCED_RANGE');
    if (checkpoint !== undefined) {
      if (typeof checkpoint !== 'string' || !checkpoint.trim()) throw new Error('SELF_COMPACT_EMPTY_CHECKPOINT');
      if (checkpoint.length > 100000) throw new Error('SELF_COMPACT_CHECKPOINT_TOO_LARGE');
      const allowed = new Set(plan.originalSeqs);
      const invalid = [...checkpoint.matchAll(/\[seq:(\d+)\]/g)].map(m => Number(m[1])).filter(n => !allowed.has(n));
      if (invalid.length) throw new Error('SELF_COMPACT_INVALID_REFERENCES: ' + [...new Set(invalid)].join(','));
      const selected = new Set(plan.selectedSeqs);
      const tokens = ctx.tokenMeter.measure(session).nodes.filter(n => selected.has(n.seq)).reduce((s, n) => s + n.tokens, 0);
      if (ctx.tokenMeter.estimateMessage(textMessage(checkpoint)) >= tokens) throw new Error('SELF_COMPACT_NOT_SMALLER: shorten checkpoint; original history retained');
    }
    return plan;
  }
  function activePlan(session) {
    const plan = receipt(session, 'prepared');
    if (!plan || plan.expiresAt < Date.now() || ended(session, plan.planId) || receipt(session, 'cancelled', plan.planId)) return null;
    return plan;
  }
  const register = (name, description, parameters, execute) => ctx.tools.register(defineTool({ name, description, parameters,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) { if (!exec.agent) throw new Error('A live Session is required'); return execute(args, exec.agent.session); } }));
  register(selfCompactionTools[0], '准备由你本人书写的上下文压缩。返回精确来源事件集合、将替换的surface和token估算；不调整理器。用 session_event_read 核查后，在正常一轮写正文并调用 commit。保留比例可自行选择；新增尾部保留，源范围变化拒绝提交。有效30分钟。',
    { retain_ratio: { type: 'number' } }, (args, session) => {
      const retainRatio = args.retain_ratio ?? engine.config.retainRatio ?? 0.16;
      if (!Number.isFinite(retainRatio) || retainRatio < 0.05 || retainRatio > 0.8) throw new Error('retain_ratio must be between 0.05 and 0.8');
      const measurement = ctx.tokenMeter.measure(session), nodes = session.surface.nodes;
      const first = session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0;
      let keep = nodes.length - 1, tokens = 0;
      while (keep > first && tokens < measurement.totalTokens * retainRatio) tokens += measurement.nodes[keep--].tokens;
      // The current prepare tool-call stays in the tail. Never split tool groups.
      let cut = Math.min(keep + 1, nodes.length - 1);
      while (cut > first && !toolPairingBalancedBefore(session, nodes[cut])) cut--;
      if (cut <= first) throw new Error('SELF_COMPACT_NO_RANGE: not enough balanced older history');
      const selectedSeqs = nodes.slice(first, cut);
      const events = log(session);
      const plan = { selfCompaction: 'prepared', planId: randomUUID(), sessionId: String(session.id),
        preparedAt: new Date().toISOString(), expiresAt: Date.now() + TTL, retainRatio,
        generation: session.surface.replaceGeneration, selectedSeqs, originalSeqs: originalSeqs(events, selectedSeqs),
        sourceDigest: digestSpan(session, selectedSeqs),
        estimatedSourceTokens: measurement.nodes.slice(first, cut).reduce((s, n) => s + n.tokens, 0),
        retainedSeqs: nodes.slice(cut), instructions: '正文由当前正常对话中的你自己写；不必固定栏目；引用只能用 originalSeqs；commit原样提交，不调模型改写。' };
      return plan;
    });
  register(selfCompactionTools[1], '提交你本人书写的检查点正文。须传 prepare 的 plan_id 和完整 checkpoint；正文原样提交，不再摘要。此返回仅表示排队；下个安全step执行，用 status 核实 committed。失败保留原文与草稿。',
    { plan_id: { type: 'string', required: true }, checkpoint: { type: 'string', required: true } }, (args, session) => {
      if (ended(session, args.plan_id)) throw new Error('SELF_COMPACT_ALREADY_FINISHED');
      if (receipt(session, 'queued', args.plan_id)) throw new Error('SELF_COMPACT_ALREADY_QUEUED');
      const latest = activePlan(session);
      if (latest?.planId !== args.plan_id) throw new Error('SELF_COMPACT_PLAN_SUPERSEDED_OR_CANCELLED');
      validate(session, latest, args.checkpoint);
      return { selfCompaction: 'queued', planId: args.plan_id, checkpoint: args.checkpoint,
        checkpointHash: hash(args.checkpoint), executes: 'next-safe-step', committed: false };
    });
  register(selfCompactionTools[2], '核实本人书写压缩是否真正提交；可 cancel 尚未提交的准备。原文始终仍在 Session 事件日志。',
    { plan_id: { type: 'string' }, cancel: { type: 'boolean' } }, async (args, session) => {
      const plan = args.plan_id ? receipt(session, 'prepared', args.plan_id) : receipt(session, 'prepared');
      if (!plan) return { status: 'none', committed: false };
      const end = ended(session, plan.planId);
      if (end) {
        await ctx.sessions.flush(session); // Never attest success after a failed durability checkpoint.
        return { planId: plan.planId, status: end.data.error ? 'failed' : 'committed', committed: !end.data.error,
        error: end.data.error ?? null, endSeq: end.seq };
      }
      if (args.cancel) return { selfCompaction: 'cancelled', planId: plan.planId, committed: false };
      return { planId: plan.planId, status: receipt(session, 'cancelled', plan.planId) ? 'cancelled' :
        plan.expiresAt < Date.now() ? 'expired' : receipt(session, 'queued', plan.planId) ? 'queued' : 'prepared', committed: false };
    });
  register(selfCompactionTools[3], '按准备范围分页读原始模型可见内容，自己决定保留什么。序号只允许本计划 originalSeqs/selectedSeqs；不读取其他会话，不代写摘要。返回明确字符offset/next，完整原始事件另可用session_event_read查。',
    { plan_id: { type: 'string', required: true }, index: { type: 'integer' }, seq: { type: 'integer' }, offset: { type: 'integer' }, limit_chars: { type: 'integer' } },
    (args, session) => {
      const plan = receipt(session, 'prepared', args.plan_id);
      if (!plan) throw new Error('SELF_COMPACT_PLAN_NOT_FOUND');
      const index = args.index ?? 0, offset = args.offset ?? 0, limit = args.limit_chars ?? 8000;
      if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw new Error('Invalid source page bounds');
      const seq = args.seq ?? plan.originalSeqs[index];
      if (!plan.originalSeqs.includes(seq) && !plan.selectedSeqs.includes(seq)) throw new Error('SELF_COMPACT_INVALID_SOURCE');
      const event = session.eventAt(seq), message = deriveEventMessage(event);
      const body = JSON.stringify({ seq, time: event.time, type: event.type, message: message && { ...message, content: message.content.filter(b => b.type !== 'reasoning') } });
      if (offset > body.length) throw new Error('Source offset exceeds record length');
      const end = Math.min(body.length, offset + limit), sourceIndex = plan.originalSeqs.indexOf(seq);
      return { planId: plan.planId, seq, sourceHash: hash(event), offset, totalChars: body.length, text: body.slice(offset, end),
        complete: end === body.length, next: end < body.length ? { seq, offset: end } :
          sourceIndex >= 0 && sourceIndex + 1 < plan.originalSeqs.length ? { index: sourceIndex + 1, offset: 0 } : null };
    });
  async function process(agent, signal) {
    const session = agent.session, events = log(session);
    const finished = new Set(events.filter(e => e.type === 'compaction/end').map(e => e.data.compactionId));
    const queued = receipts(session).findLast(v => v.selfCompaction === 'queued' && !finished.has(v.planId));
    if (!queued) return;
    // An unfinished native lock is never bypassed. A new native seed permits crash recovery.
    const seed = events.findLast(e => e.type === 'session/end-seed')?.seq ?? -1;
    const lastStart = events.findLast(e => e.type === 'compaction/start');
    if (lastStart && lastStart.seq > seed && !ended(session, lastStart.data.compactionId)) throw new Error('SELF_COMPACT_BUSY');
    const turnStart = events.findLast(e => e.type === 'turn/start');
    const turnEnd = events.findLast(e => e.type === 'turn/end');
    if (!turnStart || (turnEnd && turnEnd.seq > turnStart.seq)) throw new Error('SELF_COMPACT_REQUIRES_SAFE_STEP');
    const lifecycle = { compactionId: queued.planId, turn: turnStart.data.turn };
    // Recover the narrow crash window after a durable surface replacement but before its end marker.
    const landed = events.findLast(e => e.type === 'user/message' && e.data.source?.compactionId === queued.planId);
    const summary = events.findLast(e => e.type === 'compaction/summary' && e.data.compactionId === queued.planId);
    const preparedPlan = receipt(session, 'prepared', queued.planId);
    if (landed && summary && preparedPlan && lastStart?.data.compactionId === queued.planId && lastStart.seq < seed &&
        landed.surfaceOp?.op === 'replace' &&
        hash(summary.data.shadowedSeqs) === hash(preparedPlan.selectedSeqs) &&
        preparedPlan.selectedSeqs.every(seq => landed.sourceEventSeqs?.includes(seq)) &&
        landed.data.content.length === 1 && landed.data.content[0].text === queued.checkpoint &&
        summary.data.summary.length === 1 && summary.data.summary[0].text === queued.checkpoint) {
      session.append('compaction/end', lifecycle);
      await ctx.sessions.flush(session);
      return;
    }
    const startEvent = session.append('compaction/start', lifecycle);
    try {
      signal?.throwIfAborted();
      const plan = validate(session, receipt(session, 'prepared', queued.planId), queued.checkpoint);
      if (receipt(session, 'prepared')?.planId !== plan.planId) throw new Error('SELF_COMPACT_PLAN_SUPERSEDED');
      if (receipt(session, 'cancelled', plan.planId)) throw new Error('SELF_COMPACT_CANCELLED');
      const summary = [{ type: 'text', text: queued.checkpoint }];
      const summaryEvent = session.append('compaction/summary', { compactionId: plan.planId, summary,
        shadowedRange: { start: plan.selectedSeqs[0], end: plan.selectedSeqs.at(-1) }, shadowedSeqs: plan.selectedSeqs,
        shadowedTokenCount: plan.estimatedSourceTokens, provider: 'self-authored', model: 'current-session-author' });
      session.append('user/message', createUserMessage({ content: summary, source: compactCheckpointSource(plan.planId) }), {
        surfaceOp: { op: 'replace', startSeq: plan.selectedSeqs[0], endSeq: plan.selectedSeqs.at(-1) },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...plan.selectedSeqs] });
      session.append('compaction/end', lifecycle);
    } catch (error) {
      session.append('compaction/end', { ...lifecycle, error: [{ name: error.name, message: error.message }] });
    }
    await ctx.sessions.flush(session);
  }
  // While authoring, automatic pressure cannot silently replace the prepared sources.
  const compact = engine.compactIfNeeded.bind(engine);
  engine.compactIfNeeded = (agent, trigger, signal) => activePlan(agent.session) ? Promise.resolve(null) : compact(agent, trigger, signal);
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => { await process(agent, signal); return next(); });
  return { validate, activePlan, process };
}
