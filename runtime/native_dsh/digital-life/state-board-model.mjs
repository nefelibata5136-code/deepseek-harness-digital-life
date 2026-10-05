// Pure display/source interpretation. Runs in a source snapshot with Node alone;
// native request ownership, mutation and persistence stay in state-board.mjs.
export function inputIdentity(message) {
  const source = message?.source ?? {}, kind = source.kind ?? 'unknown';
  if (kind === 'user' && String(source.rpcId).startsWith('resident:')) return { sender: 'system', type: 'resident_wake', channel: 'native timer', reason: 'periodic self-wake' };
  if (kind === 'user') return { sender: 'unknown', type: 'user_message', channel: 'native ingress', reason: 'new message' };
  if (kind === 'schedule') return { sender: 'system', type: 'schedule_wake', channel: 'native schedule', reason: 'scheduled delivery' };
  if (kind === 'resident-attention') return { sender: 'system', type: 'resident_decision', channel: 'native preset', reason: 'activity naturally ended' };
  if (kind === 'resident-continuation') return { sender: 'persona', type: 'self_continuation', channel: 'native preset', reason: 'own chosen continuation' };
  if (kind === 'subagent-settled') return { sender: 'child_agent', type: 'child_result', channel: 'native child', reason: 'child settlement notice', senderSessionId: source.senderSessionId ?? 'unknown' };
  // A relay can originate from a parent or another adjacent Agent. Do not infer
  // a child relationship from its name, closing text, or sender's display name.
  if (kind === 'agent-message') return { sender: 'agent', type: 'agent_message', channel: 'native relay', reason: 'adjacent Agent message', senderSessionId: source.senderSessionId ?? 'unknown' };
  if (['system-prompt', 'model-selection', 'cordis-host-runner'].includes(kind)) return { sender: 'system', type: 'system_event', channel: 'native runtime', reason: kind };
  if (kind === 'user-question-reply') return { sender: 'unknown', type: 'user_reply', channel: 'native ingress', reason: 'answer to tool question' };
  return { sender: 'unknown', type: kind, channel: 'unknown', reason: 'unknown' };
}
const localTime = now => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now) + ' +08:00';
// Keep explanations and tool instructions in their stable definitions, not in
// every dynamic board. Complete values/provenance remain available through read.
export function renderStateBoard(board) {
  const f = board.facts, s = board.self;
  const role = f.role.startsWith('parallel intention branch') ? 'parallel intention branch（同源草稿，无主线行动权）' : f.role === 'primary continuous line' ? '主线' : f.role;
  const phase = f.phase.startsWith('model request') ? '模型请求' : f.phase;
  return `[DIGITAL_LIFE_STATE]\n运行事实与本人选择；末块为当前值。\n[系统事实｜只读]\n时间：${localTime(f.now)}；Asia/Shanghai\nDigital Life；角色：${role}；阶段：${phase}\n输入：${f.input.sender}/${f.input.type}/${f.input.channel}${f.input.senderSessionId ? '；Session=' + f.input.senderSessionId : ''}\n唤醒：${f.input.reason}；睁眼间隔：${f.wakeGapMs === null ? 'unknown' : Math.floor(f.wakeGapMs / 1000) + '秒'}\n实际档位：${f.actualEffort ?? 'unsupported'}；支持：${f.supportedEfforts.join('/')}\n活动变更于：${s.activityStartedAt ?? 'unknown'}\n下次已安排唤醒：${f.nextSelfWake ?? 'none'}（${f.nextWakeSource ?? '未安排'}）\n[人格自定｜可修改]\n当前活动：${s.activity === null ? '未设置' : JSON.stringify(s.activity)}\n期望档位：${s.desired_reasoning_effort ?? f.defaultEffort + '（初始默认，尚未本人选择）'}\nResident自定：${s.resident_state ?? '未设置'}\n${f.mismatch ? '不一致原因：' + f.mismatch + '\n' : ''}[/DIGITAL_LIFE_STATE]`;
}
