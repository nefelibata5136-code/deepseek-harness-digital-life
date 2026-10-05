// Public operational metadata only. Never append unknown types to native Sessions.
export const VERSION = '1.0.0';
export const phaseLabels = {
  'waiting-lock':'等待其他操作释放资源',
  'waiting-before-backup':'等待保存保护版本',
  'before-backup':'正在保存执行前的保护版本',
  executing:'正在执行工具',
  'waiting-after-backup':'工具已返回，等待保存结果版本',
  'after-backup':'正在保存执行后的保护版本',
  completed:'工具执行流程结束', failed:'操作未正常完成',
};
export function emitToolPhase(ctx, exec, phase) {
  // Reporting must never fail an operation or expose private arguments/results.
  try {
    const session = exec.agent?.session;
    if (!session || !phaseLabels[phase] || ctx.get('personaPrivateVault')?.isSensitive(session)
        || exec.name.startsWith('private_')) return;
    ctx.get('personaProgressPhases')?.record(String(session.id),String(exec.callId),phase);
  } catch { /* The native tool call/result remains the authoritative fallback. */ }
}
export function splitProgress(text) {
  const updates = [], ordinary = [];let fence=false;
  for (const line of String(text).split('\n')) {
    if(/^\s*(?:```|~~~)/.test(line)){fence=!fence;ordinary.push(line);continue;}
    const match = !fence&&/^\s*【进展】\s*(.+)$/.exec(line);
    if (match) updates.push(match[1].trim()); else ordinary.push(line);
  }
  return {updates, text:ordinary.join('\n').trim()};
}
export function projectActivity(events,phaseEvents=[]) {
  const phases = new Map(), progress = [];
  for(const e of phaseEvents) {
    if(!phaseLabels[e.phase])continue;
    const rows=phases.get(e.callId)??[];
    rows.push({id:e.id,time:e.occurredAt,phase:e.phase,label:phaseLabels[e.phase]});phases.set(e.callId,rows);
  }
  for (const e of events) {
    if(e.type === 'assistant/message') {
      const text=(e.data?.message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
      for(const [index, update] of splitProgress(text).updates.entries())
        progress.push({id:e.seq+':progress:'+index,seq:e.seq,time:e.time,turn:e.data.turn,role:'progress',author:'agent',text:update});
    }
  }
  return {phases,progress};
}
