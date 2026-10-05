// Native Messages wire boundary. No keys in RPC, logs, or the ledger.
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {recordIncident, errorChain, clean, isContextWindowExceeded} from '../native_dsh/recovery/diagnostics.mjs';
import {normalizeToolProtocol,protocolMetadata} from '../native_dsh/recovery/tool-protocol.mjs';

export class BudgetStop extends Error {
  constructor(reason) { super('BUDGET_STOP: ' + reason); this.reason = reason; this.code = 'DL_BUDGET_STOP'; this.retryable = false; }
}
export class ContextWindowExceeded extends Error {
  constructor(providerError, status) {
    super('CONTEXT_WINDOW_EXCEEDED: ' + clean(providerError?.message ?? 'Provider rejected the request context size'));
    this.name='ContextWindowExceeded'; this.code='CONTEXT_WINDOW_EXCEEDED'; this.retryable=false;
    this.status=status; this.providerError=providerError;
  }
}

export function pythonAuthority({ python, db } = {}) {
  if (!python) throw new BudgetStop('explicit_protected_python_required');
  const script = fileURLToPath(new URL('./authority.py', import.meta.url));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    ['DL_PYTHON', 'DL_WORKSPACE', 'DL_DATA', 'DSH_HOME', 'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(k.toUpperCase())));
  clean.PYTHONIOENCODING = 'utf-8'; clean.PYTHONDONTWRITEBYTECODE = '1';
  return (operation, args = {}) => new Promise((resolve, reject) => {
    const child = spawn(python, [script, operation, ...(db ? ['--db', db] : [])],
      { env: clean, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { output += data; if (output.length > 65536) child.kill(); });
    child.stderr.resume();
    child.on('error', () => reject(new BudgetStop('authority_unavailable')));
    child.on('close', code => {
      try {
        const answer = JSON.parse(output);
        if (code || answer.error || !answer.result) throw new BudgetStop(answer.error ?? 'authority_failed');
        resolve(answer.result);
      } catch (error) { reject(error instanceof BudgetStop ? error : new BudgetStop('invalid_authority_reply')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(args));
  });
}

// No byte/token heuristic: every accepted request reserves published full input
// capacity (rounded upward) at cache-miss peak pricing. Unknown endpoints fail.
export function createBudgetGate({ rpc, transport, screenRequest, stopOnUnknownUsage = true, diagnostic = recordIncident }) {
  const scope = new AsyncLocalStorage();
  let uncertain = false;
  const normalizedPayloads=new Set();
  const work = new Set();
  const track = promise => {
    work.add(promise); promise.then(() => work.delete(promise), () => work.delete(promise));
    return promise;
  };
  const retained = async id => { await rpc('unknown', { attempt_id: id, reason: 'transport_or_usage_ambiguous' }); };
  const guardedFetch = async (input, init = {}) => {
    if (uncertain && stopOnUnknownUsage) throw new BudgetStop('process_has_ambiguous_attempt');
    // A Request with a prebuilt body could hide bytes/options. Only the native
    // adapter's string URL + init JSON envelope is enabled in this composition.
    if (typeof input !== 'string' && !(input instanceof URL)) throw new BudgetStop('unsupported_Request_envelope');
    const url = new URL(input);
    if (url.href !== 'https://api.deepseek.com/anthropic/v1/messages')
      throw new BudgetStop('unprotected_endpoint');
    const context = scope.getStore();
    if (!context || context.provider !== 'deepseek-official' || context.model !== 'deepseek-flash')
      throw new BudgetStop('unprotected_call_context');
    if (String(init.method).toUpperCase() !== 'POST' || typeof init.body !== 'string')
      throw new BudgetStop('unsupported_wire_envelope');
    let body;
    try { body = JSON.parse(init.body); } catch { throw new BudgetStop('invalid_json'); }
    if (body.model !== 'deepseek-flash' || body.stream !== true || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)
      throw new BudgetStop('unpriced_model_or_unsupported_stream');
    // Audited native serializer + the two current Harness metadata extensions.
    // New wire capabilities require budget review rather than silent admission.
    const fields = new Set(['model','stream','messages','max_tokens','thinking','output_config',
      'system','temperature','stop_sequences','tools','dsh_session_log','dsh_plugin_packages']);
    if (Object.keys(body).some(key => !fields.has(key))) throw new BudgetStop('unaudited_wire_extension');
    if (body.tools?.some(tool => tool.type !== undefined)) throw new BudgetStop('unaudited_server_side_tool');
    // Local output screening must reject before reserving a paid attempt.
    // A rejection here never reached the provider and is not an ambiguous bill.
    await screenRequest?.(input, init);
    if(context.purpose==='recovery-adjusted:wire-preview') {
      await diagnostic({stage:'wire-preview',sessionId:context.sessionId,requestId:context.requestId,paidCalls:0,
        requestBytes:Buffer.byteLength(init.body),messageCount:body.messages.length,protocol:protocolMetadata(body.messages)});
      const events=[{type:'message_start',message:{id:'local-wire-preview',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
        {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:0}},{type:'message_stop'}];
      return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
    }
    const normalized=normalizeToolProtocol(body.messages);
    body.messages=normalized.messages;
    if(normalized.repairs.length){const fingerprint=createHash('sha256').update(JSON.stringify(normalized.repairs)).digest('hex');
      if(!normalizedPayloads.has(fingerprint)){normalizedPayloads.add(fingerprint);await diagnostic({stage:'tool-protocol-normalized',sessionId:context.sessionId,
        requestId:context.requestId,repairs:normalized.repairs,originalHistoryPreserved:true,replayedTools:0});}}
    const id = randomUUID();
    const admitted = await rpc('reserve', {
      attempt_id: id, request_id: context.requestId, session_id: context.sessionId,
      purpose: context.purpose, provider: context.provider, model: body.model,
      owner_pid: process.pid,
      max_tokens: body.max_tokens, payload_hash: createHash('sha256').update(init.body).digest('hex'),
    });
    if (admitted.allowed !== true || !Number.isSafeInteger(admitted.max_tokens) || admitted.max_tokens < 1)
      throw new BudgetStop('invalid_admission');
    // The admitted cap is written into actual transport bytes, after extension
    // serialization; requests cannot change it between reservation and send.
    // The observed official terminal usage can count one token beyond the
    // requested generation cap. Keep the reserved/accounting bound unchanged
    // and send one fewer token; genuine accounting-bound violations still halt.
    body.max_tokens = admitted.max_tokens - 1;
    if (body.max_tokens < 1) throw new BudgetStop('output_headroom_unavailable');
    const outgoingBody = JSON.stringify(body);
    const report = async (stage,error,extra={}) => {
      const record=await diagnostic({stage,sessionId:context.sessionId,requestId:context.requestId,
        attemptId:id,purpose:context.purpose,requestBytes:Buffer.byteLength(outgoingBody),messageCount:body.messages?.length??0,
        payloadHash:createHash('sha256').update(outgoingBody).digest('hex'),causes:errorChain(error),protocol:protocolMetadata(body.messages),...extra});
      return record;
    };
    let response;
    try {
      const bound = await rpc('bind', { attempt_id: id, max_tokens: body.max_tokens, output_headroom_tokens: 1,
        wire_hash: createHash('sha256').update(outgoingBody).digest('hex') });
      if (bound.bound !== true) throw new BudgetStop('wire_not_bound');
      response = await transport(input, { ...init, body: outgoingBody, redirect: 'error' });
      if (!response.ok || !response.body) {
        let providerError;
        // Keep only the explicit provider error fields, never a raw response/request or authentication headers.
        try { const parsed=await response.json(); const e=parsed.error??parsed;
          providerError={type:clean(e.type??e.code??'unknown'),message:clean(e.message??'Provider supplied no error message')};
        }catch{providerError={type:'unreadable_error',message:'Provider error body is not JSON'};}
        const error=isContextWindowExceeded({providerError})
          ?new ContextWindowExceeded(providerError,response.status):new BudgetStop('http_error_or_empty_body');
        error.diagnostic=await report('http-response',error,{httpStatus:response.status,providerError,
          providerRequestId:response.headers.get('request-id')??response.headers.get('x-request-id')??response.headers.get('x-deepseek-request-id')??providerError.message.match(/request_id:\s*([A-Za-z0-9-]+)/)?.[1]??null});
        throw error;
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new BudgetStop('unexpected_response_format');
    } catch (cause) {
      uncertain = true;
      await retained(id);
      // Accounting remains conservative, but an explicit context rejection is
      // not a budget failure. Preserve its identity through the native adapter.
      if(cause.code==='CONTEXT_WINDOW_EXCEEDED'){context.contextRejection=cause;throw cause;}
      const error=new BudgetStop('ambiguous_attempt_reservation_retained');
      error.cause=cause;error.diagnostic=cause.diagnostic??await report('request-transport',cause);
      throw error;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = ''; let complete = false; let finalOutput = false; let started = false; let providerId;
    const usage = {};
    const update = value => {
      if (!value || typeof value !== 'object') return;
      for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        if (value[key] === undefined) continue;
        if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new BudgetStop('invalid_usage');
        usage[key] = value[key];
      }
    };
    const frame = async block => {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      let event;
      try { event = JSON.parse(data); } catch { throw new BudgetStop('malformed_sse'); }
      if (complete) throw new BudgetStop('data_after_terminal');
      if (event.type === 'error') {
        const providerError={type:clean(event.error?.type),message:clean(event.error?.message)};
        const error=isContextWindowExceeded({providerError})
          ?new ContextWindowExceeded(providerError):new BudgetStop('provider_stream_error');
        error.diagnostic=await report('provider-stream',error,{providerError});
        throw error;
      }
      if (event.type === 'message_start') {
        if (started) throw new BudgetStop('duplicate_message_start');
        started = true; providerId = event.message?.id; update(event.message?.usage);
      }
      if (event.type === 'message_delta') {
        update(event.usage);
        if (event.usage?.output_tokens !== undefined) finalOutput = true;
      }
      if (event.type === 'message_stop') {
        if (!started || !finalOutput || ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].some(k => usage[k] === undefined))
          throw new BudgetStop('incomplete_authoritative_usage');
        await rpc('settle', { attempt_id: id, usage,
          provider_request_id: response.headers.get('request-id') ?? response.headers.get('x-request-id') ?? providerId });
        complete = true;
      }
    };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (!complete || buffer.trim()) throw new BudgetStop('missing_terminal_usage');
            controller.close(); return;
          }
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          // Native frames are much smaller. Bounds prevent unbounded SSE buffer.
          if (buffer.length > 2 * 1024 * 1024) throw new BudgetStop('sse_frame_limit');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0,end); buffer = buffer.slice(end+2);
            await frame(block);
            if (complete) { buffer = ''; break; }
          }
          // Settlement commits before final bytes reach the Harness parser.
          controller.enqueue(value);
          // message_stop plus committed authoritative usage closes this request.
          // Native parser cleanup can abort the socket afterwards; that is not
          // an ambiguous bill and must not poison the next tool-loop step.
          if (complete) {
            controller.close();
            await reader.cancel().catch(() => {});
          }
        } catch (cause) {
          uncertain = true;
          try { await retained(id); } finally {
            await reader.cancel().catch(() => {});
            if(cause.code==='CONTEXT_WINDOW_EXCEEDED'){context.contextRejection=cause;controller.error(cause);return;}
            const error=new BudgetStop('stream_or_usage_ambiguous_reservation_retained');
            error.cause=cause;error.diagnostic=cause.diagnostic??await report('stream-or-accounting',cause);
            controller.error(error);
          }
        }
      },
      async cancel() {
        if (!complete) {
          uncertain = true;
          await track(retained(id));
        }
        await reader.cancel();
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return {
    fetch: guardedFetch,
    async within(context, fn) { return scope.run(context, fn); },
    async drain() { await Promise.all([...work]); },
  };
}

export function mountBudgetGuard(ctx, gate) {
  ctx.on('llm/stream', (options, next) => (async function* () {
    if (options.provider !== 'deepseek-official' || options.model !== 'deepseek-flash')
      throw new BudgetStop('unpriced_provider_or_model');
    const context = { provider: options.provider, model: options.model,
      sessionId: String(options.sessionId ?? 'native-unattributed'),
      requestId: String(options.requestId ?? randomUUID()),
      purpose: String(options.purpose ?? 'agent-loop') };
    const iterator = await gate.within(context, () => next()[Symbol.asyncIterator]());
    try {
      while (true) {
        const item = await gate.within(context, () => iterator.next());
        if (item.done) break;
        // LlmRuntime can serialize adapter errors to a finish chunk before the
        // middleware sees an exception. Link that same call's wire rejection
        // back to its semantic code; no global/session error cache is used.
        if(context.contextRejection&&item.value?.type==='finish'&&item.value.reason?.kind==='error'){
          yield {...item.value,reason:{...item.value.reason,failure:{...item.value.reason.failure,
            code:'CONTEXT_WINDOW_EXCEEDED',message:context.contextRejection.message}}};
          continue;
        }
        yield item.value;
      }
    } catch(error) {
      // The official adapter wraps errors thrown by fetch as TRANSPORT.
      // Recover only our explicit semantic rejection, preserving all other
      // adapter errors and their accounting behavior.
      const seen=new Set();
      for(let cause=error;cause&&!seen.has(cause);cause=cause.cause){
        seen.add(cause);if(cause.code==='CONTEXT_WINDOW_EXCEEDED')throw cause;
      }
      throw error;
    } finally { if (iterator.return) await gate.within(context, () => iterator.return()); }
  })());
  ctx.effect(() => () => gate.drain(), 'persona.budget.drain');
}

export const inject = [];
export function apply(ctx, config) {
  const policy=JSON.parse(readFileSync(new URL('./config.json',import.meta.url),'utf8'));
  const gate = createBudgetGate({ rpc: pythonAuthority(config), transport: globalThis.fetch.bind(globalThis),
    screenRequest: globalThis.fetch.keyOutputPreflight,
    stopOnUnknownUsage: policy.stop_on_unknown_usage !== false });
  // Prevent ordinary plugin replacement from silently removing the gate. This
  // is not an OS egress sandbox: raw sockets/undici/pre-captured fetch remain an
  // explicitly reported boundary requiring A's composition/credentials controls.
  Object.defineProperty(globalThis, 'fetch', { value: gate.fetch, configurable: false, writable: false });
  mountBudgetGuard(ctx, gate);
}
