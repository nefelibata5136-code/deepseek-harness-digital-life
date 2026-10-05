import { randomUUID } from 'node:crypto';
import { Store, digest } from './store.mjs';
import { assertPublic, TRUST, marker, requestText, redact } from './protocol.mjs';

const active = new Set(['prepared', 'submitted', 'accepted', 'running', 'unknown']);
export class Bridge {
  constructor({ path, policy, transport, clock = () => Date.now() }) {
    this.store = new Store(path); this.policy = policy; this.transport = transport; this.clock = clock;
    // A persisted prepared record is an in-flight or interrupted submission.
    // Reads report unknown; neither a second process nor a retry automatically resends it.
  }
  now() { return new Date(this.clock()).toISOString(); }
  safe(value) { return this.transport.safe ? this.transport.safe(value) : redact(value); }
  get(id) { const task = this.store.get(id); if (!task) throw new Error('DOTS_TASK_NOT_FOUND'); return task; }
  summary(task) {
    return { task_id: task.id, correlation_id: task.correlation_id, parent_task_id: task.parent_id,
      status: task.status === 'prepared' ? 'unknown' : task.status,
      provider: task.provider, reason: task.request.reason, submitted_at: task.submitted_at ?? null,
      deadline: task.deadline, completed_at: task.completed_at ?? null,
      error: task.error ?? (task.status === 'prepared' ? 'INFLIGHT_OR_INTERRUPTED_DO_NOT_RESEND' : null),
      receipt: task.receipt ?? null, followups_used: this.get(task.correlation_id).followups,
      maximum_followups: this.policy.maxFollowups, first_read_at: task.first_read_at ?? null,
      result_version: task.result_version ?? null, next_check_at: task.next_check_at ?? null,
      configured: !!this.transport.configured(), external: TRUST };
  }
  async health(signal) {
    try { return { provider: this.transport.kind, ...await this.transport.health(signal), external: TRUST }; }
    catch (error) { return { provider: this.transport.kind, ready: false, code: error.code ?? 'DOTS_TRANSPORT_UNAVAILABLE', external: TRUST }; }
  }
  validate(input) {
    const fields = ['goal', 'reason', 'context', 'output'];
    const request = Object.fromEntries(fields.map(k => [k, input[k] ?? (k === 'context' ? '' : null)]));
    if (fields.some(k => typeof request[k] !== 'string') || !request.goal.trim() || !request.reason.trim() || !request.output.trim()
      || input.public_context !== true || !/^[A-Za-z0-9._:-]{1,120}$/.test(input.idempotency_key ?? ''))
      throw new Error('PUBLIC_REQUEST_AND_STABLE_IDEMPOTENCY_KEY_REQUIRED');
    request.require_sources = input.require_sources !== false; request.allow_search_expansion = input.allow_search_expansion !== false;
    const body = JSON.stringify(request);
    if (body.length > this.policy.maxRequestChars) throw new Error('REQUEST_TOO_LARGE_USE_PUBLIC_SUMMARY');
    assertPublic(body); return request;
  }
  expire() {
    for (const task of this.store.all().filter(t => active.has(t.status) && Date.parse(t.deadline) <= this.clock())) {
      task.status = 'timeout'; task.error = 'DOTS_DEADLINE_EXCEEDED'; this.store.put(task); this.store.event(task, 'timeout');
    }
  }
  async delegate(input, caller, signal, parentId = null) {
    const request = this.validate(input);
    const hash = digest({ request, parentId });
    let created = false;
    const task = this.store.transaction(() => {
      this.expire();
      const existing = this.store.byKey(input.idempotency_key);
      if (existing) { if (existing.request_hash !== hash) throw new Error('IDEMPOTENCY_CONTENT_CONFLICT'); return existing; }
      const parent = parentId ? this.get(parentId) : null;
      const root = parent ? this.get(parent.correlation_id) : null;
      if (parent && parent.status !== 'completed') throw new Error('READ_COMPLETED_PARENT_BEFORE_FOLLOWUP');
      if (parent && !parent.first_read_at) throw new Error('READ_PARENT_RESULT_BEFORE_FOLLOWUP');
      if (parent && (!this.transport.matches(parent) || parent.provider !== this.transport.kind))
        throw new Error('PARENT_TRANSPORT_CHANGED_USE_NEW_PUBLIC_TASK');
      if (root && root.followups >= this.policy.maxFollowups) throw new Error('DOTS_MAXIMUM_ROUND_TRIPS_REACHED');
      const all = this.store.all();
      const day = new Date(this.clock() + 8 * 3600000).toISOString().slice(0, 10);
      if (all.filter(t => t.local_day === day).length >= this.policy.maxTasksPerDay) throw new Error('DOTS_DAILY_TASK_LIMIT');
      if (all.filter(t => active.has(t.status)).length >= this.policy.maxOpenTasks) throw new Error('DOTS_OPEN_TASK_LIMIT');
      const id = 'dot-' + randomUUID();
      const task = { id, idempotency_key: input.idempotency_key, request_hash: hash, request,
        correlation_id: root?.id ?? id, parent_id: parent?.id ?? null, followups: 0, local_day: day,
        provider: this.transport.kind, status: 'prepared', created_at: this.now(),
        deadline: new Date(this.clock() + this.policy.timeoutSeconds * 1000).toISOString(),
        initiated_by: caller, thread: parent?.thread ?? null,
        team_id: this.transport.connection?.team_id ?? null, dot_user_id: this.transport.connection?.dot_user_id ?? null,
        dot_bot_id: this.transport.connection?.dot_bot_id ?? null };
      // Carry the COMPLETE prior result. If it cannot fit, fail rather than silently truncate.
      const parentText = parent ? parent.result_text : '';
      task.wire_text = requestText(task, parentText);
      if (task.wire_text.length > 35000) throw new Error('FOLLOWUP_CONTEXT_TOO_LARGE_USE_NEW_PUBLIC_SUMMARY');
      assertPublic(task.wire_text);
      this.store.put(task); this.store.event(task, 'created', { request, caller, parent_id: task.parent_id });
      if (root) { root.followups++; this.store.put(root); this.store.event(root, 'followup_created', { task_id: id }); }
      created = true; return task;
    });
    if (!created) return { ...this.summary(task), duplicate: true };
    try {
      const health = await this.health(signal);
      if (!health.ready) {
        task.status = 'failed'; task.error = health.code ?? 'DOTS_NOT_CONFIGURED';
        this.store.put(task); this.store.event(task, 'failed', { code: task.error });
        return { ...this.summary(task), manual_handoff_available: true };
      }
      const receipt = await this.transport.send(task, task.wire_text, signal);
      const current = this.get(task.id);
      if (current.status === 'cancelled') {
        current.receipt = receipt; current.thread = receipt.thread;
        this.store.put(current); this.store.event(current, 'submitted_after_local_cancel', { receipt });
        return this.summary(current);
      }
      task.receipt = receipt; task.thread = receipt.thread; task.status = 'submitted'; task.submitted_at = this.now();
      this.store.put(task); this.store.event(task, 'submitted', { receipt });
    } catch (error) {
      task.status = error.uncertain ? 'unknown' : 'failed'; task.error = error.code ?? 'DOTS_SUBMISSION_FAILED';
      this.store.put(task); this.store.event(task, task.status, { code: task.error });
    }
    return this.summary(task);
  }
  ingest(task, message) {
    if (!this.transport.accepts(message, task)) return false;
    const parsed = marker(message.text);
    if (!parsed || parsed[2] !== task.id || !/^\d+\.\d+$/.test(message.ts ?? '')) return false;
    if (Buffer.byteLength(JSON.stringify(message)) > this.policy.maxMessageBytes) throw new Error('DOTS_MESSAGE_TOO_LARGE');
    const safeMessage = JSON.parse(this.safe(JSON.stringify(message)));
    const added = this.store.record(task, { source_id: message.ts, source_time: new Date(Number(message.ts) * 1000).toISOString(),
      observed_at: this.now(), phase: parsed[1], text: safeMessage.text, raw: safeMessage });
    if (!added) return false;
    this.store.event(task, 'external_message', { source_id: message.ts, phase: parsed[1] });
    const all = this.store.messages(task.id);
    if (all.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0) > this.policy.maxResultBytes) {
      task.status = 'failed'; task.error = 'DOTS_RESULT_SIZE_LIMIT'; this.store.put(task); return true;
    }
    // Latest version per Slack ts; edits retained as evidence, not overwritten.
    const latest = [...new Map(all.map(m => [m.source_id, m])).values()].sort((a,b) => Number(a.source_id) - Number(b.source_id));
    const results = latest.filter(m => m.phase === 'RESULT');
    const done = latest.findLast(m => m.phase === 'DONE');
    const failed = latest.findLast(m => m.phase === 'FAILED');
    if (failed && (!done || Number(failed.source_id) > Number(done.source_id))) {
      task.status = 'failed'; task.error = 'DOT_REPORTED_FAILURE';
    } else if (done && results.length && results.every(m => Number(m.source_id) < Number(done.source_id))) {
      const text = results.map(m => m.text).join('\n\n');
      task.result_text = text; task.result_version = digest(text); task.completed_at = done.source_time;
      task.completed_observed_at = this.now(); task.late_result = this.clock() > Date.parse(task.deadline);
      task.status = 'running'; task.error = null;
    } else if (task.status !== 'completed' && task.status !== 'timeout') task.status = results.length ? 'running' : 'accepted';
    this.store.put(task); return true;
  }
  async check(id, signal) {
    let task = this.get(id);
    this.store.transaction(() => this.expire()); task = this.get(id);
    if (!task.receipt || task.status === 'cancelled' || task.error === 'DOTS_RESULT_SIZE_LIMIT') return this.summary(task);
    if (!this.transport.matches(task)) return { ...this.summary(task), poll_error: 'TRANSPORT_CONNECTION_CHANGED' };
    if (Date.parse(task.next_check_at ?? 0) > this.clock()) return this.summary(task);
    try {
      // One page per check keeps the capability call within the Host's 30 second deadline.
      const data = await this.transport.poll(task, task.poll_cursor, signal);
      this.store.transaction(() => {
        task = this.get(id);
        // Another caller may have cancelled while HTTP was in flight.
        if (task.status === 'cancelled') return;
        const cursor = data.response_metadata?.next_cursor ?? '';
        for (const message of data.messages ?? []) this.ingest(task, message);
        task = this.get(id); task.poll_cursor = cursor;
        task.next_check_at = new Date(this.clock() + this.policy.pollIntervalSeconds * 1000).toISOString();
        // A final page is required; DONE seen on an earlier page is not full retrieval proof.
        if (cursor && task.status === 'completed') task.status = 'running';
        if (!cursor) {
          const latest = this.store.messages(id).at(-1);
          if (latest) this.reconcile(task);
        }
        task.poll_error = null; this.store.put(task);
      });
    } catch (error) {
      task = this.get(id); task.poll_error = error.code ?? 'DOTS_POLL_FAILED';
      task.next_check_at = new Date(this.clock() + Math.max(this.policy.pollIntervalSeconds, error.retryAfter ?? 0) * 1000).toISOString();
      this.store.put(task); this.store.event(task, 'poll_error', { code: task.poll_error });
    }
    task = this.get(id); return { ...this.summary(task), poll_error: task.poll_error ?? null,
      more_transport_pages: !!task.poll_cursor };
  }
  reconcile(task) {
    const all = this.store.messages(task.id);
    const latest = [...new Map(all.map(m => [m.source_id,m])).values()];
    const done = latest.findLast(m => m.phase === 'DONE');
    const result = latest.filter(m => m.phase === 'RESULT');
    if (task.error === 'DOTS_RESULT_SIZE_LIMIT') return;
    const failed = latest.filter(m => m.phase === 'FAILED').sort((a,b) => Number(a.source_id)-Number(b.source_id)).at(-1);
    if (done && result.length && result.every(m => Number(m.source_id) < Number(done.source_id))
      && (!failed || Number(failed.source_id) < Number(done.source_id))) {
      const text = result.sort((a,b) => Number(a.source_id)-Number(b.source_id)).map(m => m.text).join('\n\n');
      const changed = task.status !== 'completed' || task.result_version !== digest(text);
      task.result_text = text; task.result_version = digest(text); task.status = 'completed';
      task.completed_at = done.source_time; task.completed_observed_at = this.now(); task.error = null;
      if (changed) this.store.event(task, 'completed', { result_version: task.result_version, completed_at: task.completed_at });
    }
  }
  read(id, { offset = 0, limit = this.policy.resultPageChars, version = null, reader = {} } = {}) {
    const task = this.get(id);
    if (task.status !== 'completed') return { ...this.summary(task), available: false };
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 32000) throw new Error('INVALID_RESULT_PAGE');
    if (version && version !== task.result_version) throw new Error('RESULT_VERSION_CHANGED_RESTART_AT_ZERO');
    if (offset > 0 && !version) throw new Error('RESULT_VERSION_REQUIRED_FOR_CONTINUATION');
    if (offset > task.result_text.length) throw new Error('RESULT_OFFSET_OUT_OF_RANGE');
    const text = task.result_text.slice(offset, offset + limit);
    task.first_read_at ??= this.now(); task.last_read_at = this.now(); this.store.put(task);
    this.store.event(task, 'result_read', { reader, offset, limit, result_version: task.result_version,
      complete_page: offset + text.length >= task.result_text.length });
    return { ...this.summary(task), available: true, text, offset, total_chars: task.result_text.length,
      next_offset: offset + text.length < task.result_text.length ? offset + text.length : null,
      source_links: [...new Set(task.result_text.match(/https?:\/\/[^\s<>\]"）)]+/g) ?? [])],
      late_result: !!task.late_result, external: TRUST };
  }
  history(id, after = 0, limit = 50) {
    const task = this.get(id); const events = this.store.events(id, after, limit);
    return { ...this.summary(task), events, next_after: events.length === limit ? events.at(-1).seq : null };
  }
  cancel(id) {
    return this.store.transaction(() => {
      const task = this.get(id); if (task.status === 'completed') throw new Error('COMPLETED_TASK_CANNOT_BE_CANCELLED');
      task.status = 'cancelled'; task.error = 'LOCAL_CANCEL_DOT_MAY_STILL_BE_WORKING';
      this.store.put(task); this.store.event(task, 'cancelled'); return this.summary(task);
    });
  }
  handoff(id) { const task = this.get(id); return { task_id: id, status: task.status, text: task.wire_text,
    automated_delivery: false, explanation: '请从正式 Dots/Slack 入口人工转交；不能把人工转交当自动接通。' }; }
  async close() { this.store.close(); await this.transport.close?.(); }
}
