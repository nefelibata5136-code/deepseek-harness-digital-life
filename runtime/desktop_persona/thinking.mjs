// Only provider reasoning enters this projection. No model calls or summaries.
import {createDetector} from '../key_output_guard/detector.mjs';

const publicDetector = createDetector();
export function redactThinking(value, {streaming = false, detector = publicDetector} = {}) {
  let text = String(value ?? '');
  // Hold an unfinished lexical token: a key split across deltas must not leak
  // its prefix before the complete value can be screened.
  if (streaming) text = text.replace(/[A-Za-z0-9_./+~=-]+$/, '');
  text = text.replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g, '[凭据已隐藏]');
  text = text.replace(/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)["']?\s*[:=]\s*[^\r\n]*/gi, '[凭据已隐藏]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, '[凭据已隐藏]');
  text = text.replace(/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|secret)\b["']?\s*[:=]\s*(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;}\r\n]+)/gi, '[凭据已隐藏]');
  return detector.sanitize(text);
}

export function reasoningText(message) {
  return (message?.content ?? []).filter(block => block.type === 'reasoning' && typeof block.text === 'string')
    .map(block => block.text).join('\n\n');
}

// Use Harness' public reconnect baseline. It already accumulates token/delta
// streams and atomically settles them into assistant/message; no second buffer.
export function projectThinkingSnapshot(snapshot, {running = false, detector = publicDetector} = {}) {
  const events = (snapshot.records ?? []).map(record => record.event).filter(Boolean);
  const active = snapshot.assistantStream?.activeAttempt;
  const turn = active?.turn ?? events.findLast(e => e.type === 'turn/start')?.data.turn
    ?? events.findLast(e => e.type === 'assistant/message')?.data.turn ?? 0;
  const pieces = [];
  let currentTurn = events[0]?.data?.turn ?? turn;
  const pending = new Set();
  for (const event of events) {
    if (event.type === 'turn/start') currentTurn = event.data.turn;
    if ((event.data?.turn ?? currentTurn) !== turn) continue;
    if (event.type === 'assistant/message') {
      const text = reasoningText(event.data.message);
      if (text) pieces.push(redactThinking(text, {detector}));
    }
    if (event.type === 'tool/call') pending.add(event.data.callId);
    if (event.type === 'tool/result') pending.delete(event.data.message?.toolCallId);
  }
  if (active) {
    // reasoning-chunks is Harness' compact, lossless form of reasoning-delta.
    const text = active.stream.filter(record => record.type === 'reasoning-chunks')
      .flatMap(record => record.texts).join('');
    if (text) pieces.push(redactThinking(text, {streaming: true, detector}));
  }
  return {turn, text: pieces.join('\n\n'), state: !running ? 'completed' : pending.size ? 'tools' : 'thinking',
    cursor: snapshot.cursor, revision: snapshot.assistantStream?.revision ?? 0};
}

export async function readThinking(ctx, sessionId, knownSecrets = []) {
  const cancellation = new AbortController();
  const follower = ctx.sessionController.follow({address: {kind: 'session', sessionId}, assistantStream: true,
    maxMessages: Number.MAX_SAFE_INTEGER, turnWindow: {minMessages: 1, minTurns: 1}}, cancellation.signal);
  try {
    const {value} = await follower.next();
    if (value?.type !== 'snapshot') throw new Error('Harness thinking baseline unavailable');
    return {sessionId, ...projectThinkingSnapshot(value, {running: ctx.personaTasks.running().includes(sessionId),
      detector: createDetector(knownSecrets)})};
  } finally {
    cancellation.abort();
    await follower.return(); // removes official listeners; never submits a turn
  }
}
