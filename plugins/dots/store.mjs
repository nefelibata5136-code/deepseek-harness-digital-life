import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, task_id TEXT NOT NULL, observed_at TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, task_id TEXT NOT NULL, source_id TEXT NOT NULL, hash TEXT NOT NULL, value TEXT NOT NULL,
        UNIQUE(task_id,source_id,hash));
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) { const row = this.db.prepare('SELECT value FROM tasks WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; }
  byKey(key) { const row = this.db.prepare('SELECT value FROM tasks WHERE idem=?').get(key); return row ? JSON.parse(row.value) : null; }
  all() { return this.db.prepare('SELECT value FROM tasks ORDER BY rowid').all().map(row => JSON.parse(row.value)); }
  put(task) { this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
    .run(task.id, task.idempotency_key, task.request_hash, JSON.stringify(task)); }
  event(task, kind, value = {}) {
    this.db.prepare('INSERT INTO events(task_id,observed_at,kind,value) VALUES (?,?,?,?)')
      .run(task.id, new Date().toISOString(), kind, JSON.stringify(value));
  }
  record(task, message) {
    const hash = digest({ phase: message.phase, text: message.text, raw: message.raw });
    const result = this.db.prepare('INSERT OR IGNORE INTO messages(task_id,source_id,hash,value) VALUES (?,?,?,?)')
      .run(task.id, message.source_id, hash, JSON.stringify(message));
    return Number(result.changes) > 0;
  }
  messages(id) { return this.db.prepare('SELECT seq,hash,value FROM messages WHERE task_id=? ORDER BY seq').all(id)
    .map(row => ({ seq: row.seq, hash: row.hash, ...JSON.parse(row.value) })); }
  events(id, after = 0, limit = 50) {
    return this.db.prepare('SELECT * FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit)
      .map(row => ({ ...row, value: JSON.parse(row.value) }));
  }
  cache(key, value) { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  cached(key) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  close() { this.db.close(); }
}
