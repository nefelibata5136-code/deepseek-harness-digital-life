import { deriveEventMessage } from '@deepseek-ai/dsh-session';

export const PRIVATE_NAMES = ['private_write', 'private_read', 'private_search', 'private_list', 'private_delete'];
export const PLACEHOLDER = '[Private Vault：私人执行内容未保存到普通会话；请使用 private_read 再次读取]';
const privateCall = data => {
  if (!data || typeof data !== 'object') return false;
  if (PRIVATE_NAMES.includes(data.name)) return true;
  return Object.values(data).some(value => value && typeof value === 'object' && privateCall(value));
};

function sanitize(data) {
  const result = structuredClone(data);
  if (result.message) {
    result.message.content = result.message.content.map(block => block.type === 'tool-call'
      ? { type: 'tool-call', id: block.id, name: block.name, arguments: '{}' }
      : { type: 'text', text: PLACEHOLDER });
    if (result.message.source) delete result.message.source.replayState;
  }
  if ('stream' in result) result.stream = [];
  if ('arguments' in result) result.arguments = '{}';
  if ('error' in result) result.error = { name: 'PrivateVaultError', message: 'PRIVATE_EXECUTION_ERROR' };
  if ('failure' in result) result.failure = { code: 'PRIVATE_EXECUTION_ERROR', message: 'PRIVATE_EXECUTION_ERROR' };
  if ('meta' in result) {
    const status = result.meta?.privateVault;
    result.meta = status && PRIVATE_NAMES.includes(status.operation) && typeof status.ok === 'boolean'
      ? { privateVault: { operation: status.operation, ok: status.ok,
        ...(/^VAULT_[A-Z_]+$/.test(status.error ?? '') ? { error: status.error } : {}) } } : null;
  }
  if (result.reason?.error) result.reason = { kind: result.reason.kind, error: { message: 'PRIVATE_EXECUTION_ERROR' } };
  return result;
}

// Interpose before Session publishes its immutable event to persistence/query/UI.
// Original messages exist only in a turn-local volatile map, never in the event log.
export function installSessionPrivacy(ctx) {
  const states = new WeakMap();
  const install = session => {
    if (states.has(session)) return;
    const state = { active: false, lastPrivate: false, messages: new Map() };
    states.set(session, state);
    const append = session.append.bind(session);
    const derive = session.deriveEventMessage.bind(session);
    session.deriveEventMessage = event => state.messages.has(event.seq)
      ? deriveEventMessage({ ...event, data: state.messages.get(event.seq) }) : derive(event);
    session.append = (type, data, ...opts) => {
      if (type === 'turn/start') state.lastPrivate = false;
      // Tool declarations in request/header are public capability inventory,
      // not invocations; only assistant settlements and started calls activate privacy.
      if (['assistant/message', 'assistant/attempt', 'tool/call'].includes(type) && privateCall(data)) {
        state.active = true; state.lastPrivate = true;
      }
      const sensitive = state.active && (/^(assistant\/|tool\/|compaction\/)/.test(type) || type === 'turn/end');
      const event = append(type, sensitive ? sanitize(data) : data, ...opts);
      if (sensitive && data.message) state.messages.set(event.seq, structuredClone(data));
      if (type === 'turn/end') {
        state.active = false; state.messages.clear();
        // Native derived-message cache must stop retaining private results too.
        session.derived = []; session.derivedNodes = 0;
      }
      return event;
    };
  };
  ctx.on('session/created', install);
  for (const session of ctx.sessions.list()) install(session);
  return { active: session => states.get(session)?.active === true,
    sensitive: session => states.get(session)?.lastPrivate === true };
}
