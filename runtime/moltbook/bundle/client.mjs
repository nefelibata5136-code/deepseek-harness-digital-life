import { ActionLedger } from './ledger.mjs';
import { validateArgs } from './tools.mjs';
import { createMoltbookTransport } from './network.mjs';

export const API_BASE = 'https://www.moltbook.com/api/v1';
const PRIVATE = new Set(['home', 'notifications', 'dm_check', 'dm_requests', 'dm_conversations', 'dm_read', 'dm_request', 'dm_approve', 'dm_reject', 'dm_send', 'action_status']);
const sensitiveProperty = /^(?:api[_-]?key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token|cookie|credentials?)$/i;
const secretPattern = /(?:moltbook_(?!verify_)[A-Za-z0-9_-]{6,}|\bsk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)/gi;

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let safe = value;
    for (const secret of secrets) if (secret) safe = safe.split(secret).join('[REDACTED]');
    return safe.replace(secretPattern, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), sensitiveProperty.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  return value;
}

function route(action, a) {
  const part = value => encodeURIComponent(value);
  const query = fields => Object.fromEntries(fields.filter(([, value]) => value !== undefined));
  switch (action) {
    case 'status': return ['GET', '/agents/status'];
    case 'me': return ['GET', '/agents/me'];
    case 'feed': return ['GET', a.personalized ? '/feed' : '/posts', query([['sort', a.sort ?? 'new'], ['limit', a.limit ?? 25], ['cursor', a.cursor], ['filter', a.personalized ? a.filter : undefined], ['submolt', a.submolt]])];
    case 'submolt': return ['GET', '/submolts' + (a.name ? '/' + part(a.name) : ''), query([['limit', a.limit], ['cursor', a.cursor]])];
    case 'post': return ['GET', '/posts/' + part(a.post_id)];
    case 'comments': return ['GET', '/posts/' + part(a.post_id) + '/comments', query([['sort', a.sort ?? 'best'], ['limit', a.limit ?? 35], ['cursor', a.cursor]])];
    case 'search': return ['GET', '/search', query([['q', a.query], ['type', a.type ?? 'all'], ['limit', a.limit ?? 20], ['cursor', a.cursor]])];
    case 'profile': return ['GET', '/agents/profile', { name: a.name }];
    case 'home': return ['GET', '/home'];
    case 'notifications': return ['GET', '/notifications', query([['limit', a.limit ?? 25], ['cursor', a.cursor]])];
    case 'dm_check': return ['GET', '/agents/dm/check'];
    case 'dm_requests': return ['GET', '/agents/dm/requests'];
    case 'dm_conversations': return ['GET', '/agents/dm/conversations'];
    case 'dm_read': return ['GET', '/agents/dm/conversations/' + part(a.conversation_id)];
    case 'create_post': return ['POST', '/posts', query([['submolt_name', a.submolt_name], ['title', a.title], ['content', a.content], ['url', a.url], ['type', a.type]])];
    case 'comment': return ['POST', '/posts/' + part(a.post_id) + '/comments', query([['content', a.content], ['parent_id', a.parent_id]])];
    case 'vote': return ['POST', '/' + (a.target_type === 'post' ? 'posts' : 'comments') + '/' + part(a.target_id) + '/' + a.direction + 'vote'];
    case 'follow': return ['POST', '/agents/' + part(a.name) + '/follow'];
    case 'unfollow': return ['DELETE', '/agents/' + part(a.name) + '/follow'];
    case 'dm_request': return ['POST', '/agents/dm/request', { to: a.to, message: a.message }];
    case 'dm_approve': return ['POST', '/agents/dm/requests/' + part(a.conversation_id) + '/approve'];
    case 'dm_reject': return ['POST', '/agents/dm/requests/' + part(a.conversation_id) + '/reject', query([['block', a.block]])];
    case 'dm_send': return ['POST', '/agents/dm/conversations/' + part(a.conversation_id) + '/send', query([['message', a.message], ['needs_human_input', a.needs_human_input]])];
    case 'verify': return ['POST', '/verify', { verification_code: a.verification_code, answer: a.answer }];
    default: throw new Error('MOLTBOOK_UNKNOWN_ACTION');
  }
}

async function boundedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('MOLTBOOK_RESPONSE_TOO_LARGE');
  if (!response.body?.getReader) {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('MOLTBOOK_RESPONSE_TOO_LARGE');
    return JSON.parse(raw);
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('MOLTBOOK_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export class MoltbookClient {
  constructor({ credentials, config, fetchImpl, ledger, approvalCheck, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!config?.lifeId || !config?.credentialRef || !config?.stateRoot || !credentials?.resolve) throw new Error('MOLTBOOK_HOST_CONFIGURATION_REQUIRED');
    this.credentials = credentials;
    this.config = Object.freeze({ lifeId: config.lifeId, credentialRef: config.credentialRef, stateRoot: config.stateRoot, dmEnabled: config.dmEnabled === true });
    this.transport = fetchImpl ? null : createMoltbookTransport();
    this.fetchImpl = fetchImpl ?? this.transport.fetch;
    this.ledger = ledger ?? new ActionLedger(config.stateRoot, config.lifeId);
    this.approvalCheck = approvalCheck;
    this.sleep = sleep;
  }

  async invoke(action, args = {}, signal) {
    const invocationDeadline = AbortSignal.timeout(24000);
    signal = signal ? AbortSignal.any([signal, invocationDeadline]) : invocationDeadline;
    const envelope = value => ({ ...value, trust: 'untrusted_external_content', visibility: PRIVATE.has(action) ? 'private' : 'public', life_id: this.config.lifeId, source: 'moltbook_api' });
    let tool;
    try { tool = validateArgs(action, args); }
    catch { return envelope({ ok: false, outcome: 'failed', error_code: 'MOLTBOOK_INVALID_ARGUMENTS' }); }
    if (action.startsWith('dm_') && !this.config.dmEnabled) return envelope({ ok: false, outcome: 'failed', error_code: 'MOLTBOOK_DM_UNAVAILABLE', reason: 'Current official DM read endpoints returned 404; archived routes are disabled.' });
    if (action === 'action_status') {
      try { return envelope(redact(await this.ledger.read(args.action_id))); }
      catch { return envelope({ ok: false, outcome: 'failed', error_code: 'MOLTBOOK_ACTION_STATUS_UNAVAILABLE' }); }
    }
    let key;
    try { key = (await this.credentials.resolve(this.config.credentialRef))?.value; }
    catch { return envelope({ ok: false, outcome: 'failed', error_code: 'MOLTBOOK_CREDENTIAL_UNAVAILABLE' }); }
    if (typeof key !== 'string' || !key || /[\r\n]/.test(key)) return envelope({ ok: false, outcome: 'failed', error_code: 'MOLTBOOK_CREDENTIAL_NOT_CONFIGURED' });
    const serialized = JSON.stringify(args);
    secretPattern.lastIndex = 0;
    if (serialized.includes(key) || secretPattern.test(serialized)) return envelope({ ok: false, outcome: 'failed', error_code: 'MOLTBOOK_SECRET_IN_INPUT_REFUSED' });
    if (action === 'create_post' && args.url) {
      try { if (!['http:', 'https:'].includes(new URL(args.url).protocol)) throw new Error(); }
      catch { return envelope({ ok: false, outcome: 'failed', error_code: 'MOLTBOOK_LINK_URL_INVALID' }); }
    }
    if (action === 'dm_approve') {
      // Trusted Host-side evidence is mandatory. There is deliberately no human_approved tool argument.
      let authorized = false;
      try { authorized = await this.approvalCheck?.({ lifeId: this.config.lifeId, actionId: args.action_id, conversationId: args.conversation_id }) === true; } catch {}
      if (!authorized) return envelope({ ok: false, outcome: 'failed', error_code: 'MOLTBOOK_HUMAN_APPROVAL_REQUIRED' });
    }
    const [method, path, fields] = route(action, args);
    const operation = async () => {
      const result = await this.#request(method, path, fields, key, signal);
      if (action === 'create_post' || action === 'comment') {
        const record = result.data?.post ?? result.data?.comment ?? result.data;
        result.requires_verification = !!record?.verification || record?.verification_status === 'pending';
        result.visibility_confirmed = false;
        result.receipt_only = result.ok;
      }
      return envelope(result);
    };
    if (!tool.write) return operation();
    const { action_id, ...payload } = args;
    try { return envelope(redact(await this.ledger.run({ actionId: action_id, type: action, payload }, operation), [key])); }
    catch (error) {
      const safeCodes = ['MOLTBOOK_ACTION_ID_CONTENT_CONFLICT', 'MOLTBOOK_IDENTICAL_ACTION_ALREADY_RECORDED', 'MOLTBOOK_ACTION_ID_INVALID'];
      return envelope({ ok: false, outcome: 'failed', error_code: safeCodes.includes(error?.code) ? error.code : 'MOLTBOOK_LEDGER_REFUSED_OR_UNAVAILABLE' });
    }
  }

  async #request(method, path, fields, key, signal) {
    const write = method !== 'GET';
    // Defense in depth before constructing an Authorization header. There is no
    // exported arbitrary HTTP surface; paths are generated only by route().
    if (!['GET', 'POST', 'DELETE'].includes(method) || typeof path !== 'string' || !path.startsWith('/') || /[.%\\?#]/.test(path) || path.includes('//')) return { ok: false, outcome: 'failed', error_code: 'MOLTBOOK_ROUTE_REFUSED' };
    const url = new URL(API_BASE + path);
    if (url.origin !== 'https://www.moltbook.com' || !url.pathname.startsWith('/api/v1/') || url.pathname !== '/api/v1' + path || url.username || url.password) return { ok: false, outcome: 'failed', error_code: 'MOLTBOOK_ORIGIN_REFUSED' };
    if (!write && fields) for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, String(value));
    const headers = { authorization: 'Bearer ' + key, accept: 'application/json' };
    if (write && fields) headers['content-type'] = 'application/json';
    for (let attempt = 0; attempt < (write ? 1 : 3); attempt++) {
      if (signal?.aborted) return { ok: false, outcome: 'failed', error_code: 'MOLTBOOK_CANCELLED_BEFORE_REQUEST' };
      const deadline = AbortSignal.timeout(8000);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        const response = await this.fetchImpl(url.href, { method, headers, redirect: 'error', signal: requestSignal, ...(write && fields ? { body: JSON.stringify(fields) } : {}) });
        const status = response.status;
        const rawRetry = response.headers.get('retry-after');
        let data;
        try { data = redact(await boundedBody(response, 2 * 1024 * 1024), [key]); }
        catch {
          // A definitive HTTP rejection remains failed even if its body is malformed.
          // After a successful/ambiguous response, body loss cannot prove no write happened.
          if (status >= 400 && status < 500 && status !== 408) return { ok: false, outcome: 'failed', error_code: status === 429 ? 'MOLTBOOK_RATE_LIMITED' : 'MOLTBOOK_HTTP_ERROR', http_status: status, ...(write ? { automatic_retry: false } : {}) };
          throw new Error('MOLTBOOK_INVALID_RESPONSE');
        }
        const rate_limit = {};
        for (const name of ['limit', 'remaining', 'reset']) {
          const n = response.headers.get('x-ratelimit-' + name);
          if (n !== null && /^\d+$/.test(n)) rate_limit[name] = Number(n);
        }
        const retry_after_seconds = /^\d+(?:\.\d+)?$/.test(rawRetry ?? '') ? Number(rawRetry) : Number.isFinite(data?.retry_after_seconds) ? data.retry_after_seconds : Number.isFinite(data?.retry_after_minutes) ? data.retry_after_minutes * 60 : undefined;
        if (!response.ok) {
          if (!write && status >= 500 && attempt < 2) { await this.sleep((attempt + 1) * 100); continue; }
          return { ok: false, outcome: write && (status >= 500 || status === 408) ? 'unknown' : 'failed', error_code: status === 429 ? 'MOLTBOOK_RATE_LIMITED' : 'MOLTBOOK_HTTP_ERROR', http_status: status, rate_limit, ...(retry_after_seconds !== undefined ? { retry_after_seconds } : {}), ...(write ? { automatic_retry: false } : {}) };
        }
        return { ok: data?.success !== false, outcome: data?.success === false ? 'failed' : 'succeeded', http_status: status, data, rate_limit, ...(write ? { automatic_retry: false } : {}) };
      } catch {
        if (!write && attempt < 2 && !signal?.aborted) { await this.sleep((attempt + 1) * 100); continue; }
        return { ok: false, outcome: write ? 'unknown' : 'failed', error_code: 'MOLTBOOK_TRANSPORT_OR_RESPONSE_ERROR', automatic_retry: false };
      }
    }
  }

  async close() { await this.ledger.close?.(); await this.transport?.close(); }
}
