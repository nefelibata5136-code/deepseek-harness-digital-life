// A capability of the native Persona Agent preset, mounted in its Cordis scope.
// The DSH Agent loop still owns inference, cancellation, inbox, and persistence.
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { collectAttention, renderAttention } from './attention.mjs';
import { createIntentionSampler, explanation } from './intention.mjs';
import { mountStateBoard } from './state-board.mjs';

export const inject = ['tools', 'agents', 'llm', 'subagents', 'personaLife', 'personaHost', 'personaTasks'];
const controlTools = new Set(['life_rest', 'life_configure', 'life_continue', 'life_attention',
  'digital_life_state_read', 'digital_life_state_update', 'life_sampling_configure', 'life_status', 'budget_status', 'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list']);
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
// A Host terminal ACK is a native tool, not an inferred choice from prose.
const hasTerminalAck = agent => agent.ctx.tools.schemas(agent).some(tool => tool.name === 'life_turn_ack');

export function apply(ctx, config = {}) {
  const life = ctx.personaLife, store = life.store;
  const capability = { version: 1, primaryOnly: true, preset: life.identity?.presetId ?? 'persona',
    ...(life.identity ? { lifeId: life.identity.lifeId } : {}), lifecycle: 'agent/turn-stopping' };
  life.residentCapability = capability;
  ctx.effect(() => () => { if (life.residentCapability === capability) delete life.residentCapability; }, 'Resident preset capability');
  const workspace = resolve(config.workspace);
  const sampler = config.intention === false ? null : createIntentionSampler(ctx, { workspace, ...(config.intention ?? {}) });
  const stateBoard = config.stateBoard !== false ? mountStateBoard(ctx, config.stateBoard ?? {}) : null;
  const states = new WeakMap();
  const stateFor = agent => {
    const turn = [...agent.session.ownEvents()].findLast(e => e.type === 'turn/start')?.data.turn;
    let state = states.get(agent);
    if (!state || state.turn !== turn) { state = { turn, offered: false, acted: false, resting: false, limited: false, decision: 0, seen: new Map() }; states.set(agent, state); }
    return state;
  };
  const requirePrimary = exec => { if (!life.isAuthority(exec.agent)) throw new Error('RESIDENT_PRIMARY_SESSION_REQUIRED'); };
  const collect = agent => life.attention ? life.attention(agent,{limit:config.attentionLimit??12,maxBytes:config.excerptBytes??2400}) : collectAttention({ agent, workspace, store,
    schedule: ctx.personaHost.schedule, tasks: ctx.personaTasks,
    limit: config.attentionLimit ?? 12, maxBytes: config.excerptBytes ?? 2400 });
  const register = (name, description, parameters, execute) => ctx.tools.register(defineTool({ name, description, parameters, output,
    async execute(args, exec) { requirePrimary(exec); return execute(args, exec); } }));

  register('life_attention', '按需读取真实注意力候选和来源，不创建任务、不自动处理。仅主对话可用。', {},
    (_args, exec) => collect(exec.agent));
  if(sampler) register('life_sampling_configure', '数字生命本人接受、调整或关闭八次同源独立意向展开。默认关闭。先理解下面说明，再决定；关闭随时生效。\n' + explanation,
    { enabled: { type: 'boolean', required: true }, understanding: { type: 'string', required: true } }, async (args, exec) => {
      const own = [...exec.agent.session.ownEvents()], turn = own.findLast(e => e.type === 'turn/start');
      const call = own.findLast(e => e.type === 'tool/call' && e.data.name === 'life_sampling_configure' && String(e.data.callId) === String(exec.callId));
      if (!turn || !call || call.seq < turn.seq || own.findLast(e => e.type === 'turn/end')?.seq > turn.seq)
        throw new Error('SAMPLING_REQUIRES_OWN_NATIVE_CALL');
      if (!args.understanding.trim() || args.understanding.length > 8000) throw new Error('Explain own understanding/boundaries in 1..8000 characters');
      return store.configure({ intentionSamplingEnabled: args.enabled, intentionSamplingConsent: {
        sessionId: String(exec.agent.session.id), callId: String(exec.callId), at: new Date().toISOString(), understanding: args.understanding } });
    });
  register('life_continue', '数字生命本人选择继续当前活动；用于没有工具动作的思考/文字活动。直接调用行动工具也可继续；不创建新Session，不替你选任务。',
    { intention: { type: 'string', required: true } }, (args, exec) => {
      if (!args.intention.trim() || args.intention.length > 2400) throw new Error('intention must be 1..2400 characters');
      stateFor(exec.agent).acted = true;
      exec.deferContext(createUserMessage({ content: [{ type: 'text', text: `你自己选择继续：${args.intention}\n继续这项活动；可以随时 life_rest。` }],
        source: { kind: 'resident-continuation' } }));
      return { continued: true, sessionId: String(exec.agent.session.id) };
    });
  // Scoped shadow of the existing tool; store and native schedule remain shared.
  register('life_rest', '数字生命本人主动停止当前高成本活动，不再催问。可通过原生schedule给未来的自己设nextWakeAt，reason写清为什么醒和上次停在哪。',
    { nextWakeAt: { type: 'string' }, reason: { type: 'string' } }, async (args, exec) => {
      let wake;
      if (args.nextWakeAt) {
        const time = Date.parse(args.nextWakeAt);
        if (!Number.isFinite(time) || time <= Date.now()) throw new Error('nextWakeAt must be in the future');
        if (!args.reason?.trim() || args.reason.length > 8000) throw new Error('A future self-wake needs reason (1..8000 characters)');
        wake = await ctx.personaHost.schedule.create(exec.agent.session.id, { title: 'Resident：自己安排的下次醒来',
          at: new Date(time).toISOString(), prompt: `[Resident self-wake / 自己安排的唤醒]\n这是你在同一主 Session 亲自安排的唤醒，不是用户交付的新任务。\n本人留下的原因与接续：${args.reason}\n你可以继续、改变主意或休息。` }, exec.signal);
      }
      const settings = await store.settings();
      // Keep periodic eye-opening separate from this one-shot native schedule.
      await store.saveClock({ lastRestAt: new Date().toISOString(), lastOutcome: 'rest',
        nextWakeAt: new Date(Math.max(Date.now() + settings.intervalMs,
          wake ? Date.parse(wake.scheduledAt) + settings.intervalMs : 0)).toISOString() });
      stateFor(exec.agent).resting = true;
      const ackRequired=hasTerminalAck(exec.agent);
      if(ackRequired) exec.deferContext(createUserMessage({content:[{type:'text',text:'你本人已选择休息。停止继续活动；按本 Session 的 Host 协议，最后用 life_turn_ack 明确确认本轮结果，再正常结束。不要把普通文字当作 ACK，也不要为了 ACK 发对外消息。'}],source:{kind:'resident-rest-settlement'}}));
      else exec.concludeTurn();
      return { resting: true, noActionIsSuccess: true, sessionId: String(exec.agent.session.id),
        ...(ackRequired ? {hostAckRequired:true,terminalTool:'life_turn_ack'} : {}),
        ...(wake ? { scheduleId: wake.id, nextWakeAt: wake.scheduledAt, source: 'native-schedule', reason: args.reason } : {}) };
    });
  ctx.on('agent/created', ({ agent }) => {
    if (life.isAuthority(agent)) return;
    // Permission parity never grants the primary Resident lifecycle/configuration.
    const known = new Set(agent.ctx.tools.schemas(agent).map(t => t.name));
    agent.ctx.tools.restrict({ deny: ['life_rest', 'life_configure', 'life_continue', 'life_attention', 'life_sampling_configure'].filter(n => known.has(n)) });
  });
  ctx.tools.guard(exec => {
    if (['life_rest', 'life_configure', 'life_continue', 'life_attention', 'life_sampling_configure'].includes(exec.name) && !life.isAuthority(exec.agent))
      return 'RESIDENT_PRIMARY_SESSION_REQUIRED';
  });
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    if (!result.isError && life.isAuthority(exec.agent) && exec.name === 'life_turn_ack') {
      stateFor(exec.agent).resting = true;return result;
    }
    if (!result.isError && life.isAuthority(exec.agent) && !controlTools.has(exec.name)) stateFor(exec.agent).acted = true;
    return result;
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!life.isAuthority(agent)) return;
    // A max-token finish is never a natural activity boundary. Do not evade it.
    if (frame.type === 'chunk' && frame.chunk.type === 'finish' && frame.chunk.reason?.kind === 'max-tokens')
      stateFor(agent).limited = true;
  });
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (!life.isAuthority(agent) || signal.aborted) return;
    const state = stateFor(agent);
    if (state.resting || state.limited || !(await store.settings()).residentEnabled) return;
    // A plain response to the decision is a valid quiet stop, including empty inbox.
    // Only actual chosen action (or explicit text continuation) opens a new segment.
    if (state.offered && !state.acted) return;
    if ((await ctx.personaHost.status()).stop_reason || signal.aborted) return;
    const inbox = await collect(agent);
    const intentions = await sampler?.sample(agent, inbox, signal);
    signal.throwIfAborted();
    // Re-read after asynchronous collection: cancellation/steering retains priority.
    if (agent.inbox.nextStep.length) return;
    const changed = inbox.candidates.filter(item => {
      const fingerprint = createHash('sha256').update(JSON.stringify(item)).digest('hex');
      const isNew = state.seen.get(item.id) !== fingerprint; state.seen.set(item.id, fingerprint); return isNew;
    });
    const repeat = state.offered;
    const attentionText = repeat ? '[Resident continuation decision / 同一轮活动续接]\n上一段活动已结束；这不是新的定时唤醒，也不是用户的新消息。\n'
      + (changed.length ? renderAttention({ ...inbox, candidates: changed, unchangedNotRepeated: inbox.candidates.length - changed.length })
        : '注意力候选没有新增或变化，不重复投递原文。完整清单可按需 life_attention 读取。由你决定继续自己的念头、直接休息或安排未来自己醒来；无需处理旧候选。') : renderAttention(inbox);
    state.offered = true; state.acted = false; state.decision++;
    agent.steer(createUserMessage({ content: [{ type: 'text', text: attentionText
      + (intentions ? '\n[八次独立意向展开｜思考草稿]\n' + JSON.stringify(intentions) + '\n[/八次独立意向展开]\n主线自己决定；可以全部拒绝、选少数、想到另一件事、休息或自己安排唤醒。' : '') }],
      source: { kind: 'resident-attention', rpcId: `resident-decision:${agent.session.id}:${state.turn}:${state.decision}` } }));
    // Cordis serial events stop on a non-empty return. This is NOT a terminal
    // stop: the verified native inbox has a next-step continuation. Defer other
    // turn-ending validators until the same driver reaches its actual boundary.
    return true;
  });
  return {capability,stateBoard};
}
