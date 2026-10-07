import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULTS = Object.freeze({ residentEnabled: false, intervalMs: 7200000, directive: '', version: 0,
  intentionSamplingEnabled: false, intentionSamplingConsent: null });
const CLOCK_DEFAULTS = Object.freeze({ lastWakeAt: null, nextWakeAt: null, lastRestAt: null, lastOutcome: null });
const clone = (value) => structuredClone(value);
// These exact host-generated IDs belonged to the removed native-output mirror.
// Mark the read projection only; original records and Agent decisions stay intact.
const legacyGenerated = record => record.id === `session:${record.sourceSessionId}:turn:${record.turn}`
  || (typeof record.id === 'string' && record.id.startsWith(`codex:${record.sourceSessionId}:`));
const nonempty = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
};
const timestamp = (value, label, nullable = true) => {
  if (nullable && value == null) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid timestamp`);
  return new Date(time).toISOString();
};

/** One Host owns this store. The plugin authenticates the consciousness seat;
 * sessionId/callId here preserve provenance and do not themselves grant authority.
 * Working state stays in the existing continuity source, never duplicated here.
 */
export class DigitalLifeStore {
  constructor(root, { now = () => Date.now() } = {}) {
    this.root = path.resolve(root);
    this.now = now;
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  _serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async _read(name, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return clone(fallback); throw error; }
  }

  async _journal(name) {
    let content;
    try { content = await fs.readFile(path.join(this.root, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (content && !content.endsWith('\n')) throw new Error(`${name}: incomplete journal tail; original retained`);
    return content.split('\n').filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`${name}: corrupt journal record ${index + 1}; original retained`); }
    });
  }

  async _atomic(name, value) {
    const target = path.join(this.root, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, target);
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async _append(name, record) {
    const handle = await fs.open(path.join(this.root, name), 'a', 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  }

  async init() {
    return this._serial(async () => {
      if (this.initialized) return this;
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      this.clock = { ...CLOCK_DEFAULTS, ...await this._read('clock.json', CLOCK_DEFAULTS) };
      this.mental = await this._read('mental.json', null);
      this.pending = await this._journal('pending.jsonl');
      this.decisions = await this._journal('decisions.jsonl');
      const history = await this._journal('settings-history.jsonl');
      this.config = { ...DEFAULTS, ...(history.length ? history.at(-1).settings : {}) };
      if (new Set(this.pending.map((item) => item.id)).size !== this.pending.length) throw new Error('Duplicate pending record IDs');
      if (this.decisions.some((item) => !this.pending.some((record) => record.id === item.id))) throw new Error('Decision references an unknown pending record');
      this.initialized = true;
      return this;
    });
  }

  _ready() { if (!this.initialized) throw new Error('Call init() before using DigitalLifeStore'); }
  state() { return this._serial(() => { this._ready(); return clone({ identity: 'persona', clock: this.clock, settings: this.config }); }); }
  settings() { return this._serial(() => { this._ready(); return clone(this.config); }); }

  configure(patch) {
    return this._serial(async () => {
      this._ready();
      for (const key of Object.keys(patch)) if (!['residentEnabled', 'intervalMs', 'directive', 'intentionSamplingEnabled', 'intentionSamplingConsent'].includes(key)) throw new Error(`Unknown setting: ${key}`);
      const next = { ...this.config, ...patch, version: this.config.version + 1 };
      if (typeof next.residentEnabled !== 'boolean') throw new Error('residentEnabled must be boolean');
      if (typeof next.intentionSamplingEnabled !== 'boolean') throw new Error('intentionSamplingEnabled must be boolean');
      if (next.intentionSamplingEnabled && (!next.intentionSamplingConsent?.sessionId || !next.intentionSamplingConsent?.callId
          || !next.intentionSamplingConsent?.understanding)) throw new Error('Sampling requires explicit own-call consent provenance');
      if (!Number.isSafeInteger(next.intervalMs) || next.intervalMs < 60000 || next.intervalMs > 2592000000) throw new Error('intervalMs must be between 60000 and 2592000000');
      if (typeof next.directive !== 'string' || next.directive.length > 16000) throw new Error('directive must be a string of at most 16000 characters');
      await this._append('settings-history.jsonl', { observedAt: timestamp(this.now(), 'now', false), settings: next });
      this.config = next;
      return clone(next);
    });
  }

  saveClock(patch) {
    return this._serial(async () => {
      this._ready();
      const next = { ...this.clock };
      for (const [key, value] of Object.entries(patch)) {
        if (['lastWakeAt', 'nextWakeAt', 'lastRestAt'].includes(key)) next[key] = timestamp(value, key);
        else if (key === 'lastOutcome' && (value == null || ['rest', 'completed', 'interrupted'].includes(value))) next[key] = value;
        else throw new Error(`Unknown or invalid clock field: ${key}`);
      }
      await this._atomic('clock.json', next);
      this.clock = next;
      return clone(next);
    });
  }

  readMental(now = this.now()) {
    return this._serial(() => {
      this._ready();
      if (!this.mental?.text || (this.mental.expiresAt && new Date(this.mental.expiresAt).getTime() <= new Date(now).getTime())) return null;
      return clone(this.mental);
    });
  }

  writeMental({ text, expiresAt = null, sessionId, callId }) {
    return this._serial(async () => {
      this._ready();
      nonempty(sessionId, 'sessionId'); nonempty(callId, 'callId');
      if (typeof text !== 'string' || text.length > 8000) throw new Error('Mental text must be a string of at most 8000 characters');
      const record = text.trim() ? { text, expiresAt: timestamp(expiresAt, 'expiresAt'), sessionId, callId, writtenAt: timestamp(this.now(), 'now', false) } : null;
      await this._atomic('mental.json', record);
      this.mental = record;
      return clone(record);
    });
  }

  appendPending(input) {
    return this._serial(async () => {
      this._ready();
      const id = input.id ?? randomUUID();
      nonempty(id, 'id'); nonempty(input.sourceSessionId, 'sourceSessionId'); nonempty(input.text, 'text');
      if (!['activity', 'subagent'].includes(input.kind)) throw new Error('kind must be activity or subagent');
      const record = { id, kind: input.kind, sourceSessionId: input.sourceSessionId, turn: input.turn ?? null, seq: input.seq ?? null, text: input.text,
        occurredAt: timestamp(input.occurredAt, 'occurredAt'), observedAt: timestamp(input.observedAt ?? this.now(), 'observedAt', false) };
      const existing = this.pending.find((item) => item.id === id);
      if (existing) {
        const comparable = ({ observedAt, ...rest }) => JSON.stringify(rest);
        if (comparable(existing) !== comparable(record)) throw new Error(`Pending ID conflict: ${id}`);
        return clone(existing);
      }
      await this._append('pending.jsonl', record);
      this.pending.push(record);
      return clone(record);
    });
  }

  _pendingRecords(includeResolved = false, includeLegacy = false) {
    const latest = new Map(this.decisions.map((decision) => [decision.id, decision]));
    return this.pending.filter(record => includeLegacy || !legacyGenerated(record))
      .map((record) => ({ ...record, resolution: latest.get(record.id) ?? null,
        ...(legacyGenerated(record) ? { legacy_generated: true, sourceUnverified: true } : {}) }))
      .filter((record) => includeResolved || !record.resolution || record.resolution.decision === 'deferred');
  }

  listPending({ offset = 0, limit = 100, includeResolved = false, includeLegacy = false } = {}) {
    return this._serial(() => {
      this._ready();
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('offset must be nonnegative and limit must be positive integers');
      const records = this._pendingRecords(includeResolved, includeLegacy);
      return clone({ items: records.slice(offset, offset + limit), total: records.length, offset, limit, hasMore: offset + limit < records.length });
    });
  }

  resolvePending({ id, decision, note = '', sessionId, callId }) {
    return this._serial(async () => {
      this._ready();
      nonempty(sessionId, 'sessionId'); nonempty(callId, 'callId');
      const canonical = { accept: 'accepted', reject: 'rejected', discard: 'rejected', defer: 'deferred' }[decision] ?? decision;
      if (!['accepted', 'rejected', 'deferred'].includes(canonical)) throw new Error('decision must be accepted, rejected or deferred');
      if (typeof note !== 'string') throw new Error('note must be a string');
      if (!this.pending.some((record) => record.id === id)) throw new Error(`Unknown pending ID: ${id}`);
      const repeated = this.decisions.find((record) => record.id === id && record.sessionId === sessionId && record.callId === callId);
      if (repeated) {
        if (repeated.decision !== canonical || repeated.note !== note) throw new Error('Decision callId conflict');
        return clone(repeated);
      }
      const record = { id, decision: canonical, note, sessionId, callId, observedAt: timestamp(this.now(), 'now', false) };
      await this._append('decisions.jsonl', record);
      this.decisions.push(record);
      return clone(record);
    });
  }

  status() {
    return this._serial(() => {
      this._ready();
      const mentalActive = !!this.mental?.text && (!this.mental.expiresAt || new Date(this.mental.expiresAt).getTime() > this.now());
      return clone({ identity: 'persona', clock: this.clock, settings: this.config, pendingCount: this._pendingRecords().length,
        totalExperiences: this.pending.length, legacyGeneratedCount: this.pending.filter(legacyGenerated).length, decisionsCount: this.decisions.length,
        mental: { present: mentalActive, writtenAt: this.mental?.writtenAt ?? null, expiresAt: this.mental?.expiresAt ?? null } });
    });
  }
}
