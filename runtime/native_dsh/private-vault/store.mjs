import { mkdir, readFile, readdir, open, rename, unlink, lstat, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrivateVaultCrypto, VaultError } from './crypto.mjs';

const MAX_BYTES = 1024 * 1024;
const validate = (namespace, path) => {
  if (typeof namespace !== 'string' || !namespace || namespace.length > 1024 ||
      typeof path !== 'string' || !path || path.length > 4096) throw new VaultError('VAULT_INVALID_ADDRESS');
};
async function regular(path) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_BYTES + 65536) throw new VaultError('VAULT_INTEGRITY_ERROR');
}
async function atomic(path, bytes) {
  const temp = path + '.' + randomUUID() + '.tmp';
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(bytes); await file.sync(); await file.close(); file = undefined;
    await rename(temp, path);
  } finally { await file?.close(); await unlink(temp).catch(() => {}); }
}

export class PrivateVaultStore {
  constructor(root) { this.root = resolve(root); this.queue = Promise.resolve(); }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new VaultError('VAULT_INVALID_ROOT');
    const keyPath = join(this.root, 'master.dpapi');
    const lockPath = join(this.root, '.initializing');
    let lock;
    try {
      // No automatic replacement of a lost key; encrypted records must survive.
      try { await regular(keyPath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        lock = await open(lockPath, 'wx', 0o600);
        const files = await readdir(this.root);
        if (files.some(name => name !== '.initializing')) throw new VaultError('VAULT_KEY_UNAVAILABLE');
        await atomic(keyPath, PrivateVaultCrypto.generate());
      }
      this.crypto = new PrivateVaultCrypto(await readFile(keyPath));
      this.crypto.withKey(() => {});
    } finally { if (lock) { await lock.close(); await unlink(lockPath); } }
    return this;
  }
  serial(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async activity() {
    await atomic(join(this.root, 'state.json'), Buffer.from(JSON.stringify({ version: 1, lastActivityAt: new Date().toISOString() })));
  }
  async write({ namespace = 'default', path, value }) {
    validate(namespace, path);
    let bytes;
    try { bytes = Buffer.from(JSON.stringify({ namespace, path, value, updatedAt: new Date().toISOString() })); }
    catch { throw new VaultError('VAULT_INVALID_VALUE'); }
    if (value === undefined || bytes.length > MAX_BYTES) { bytes.fill(0); throw new VaultError('VAULT_VALUE_TOO_LARGE'); }
    try {
      const address = this.crypto.address(namespace, path);
      const encrypted = this.crypto.encrypt(bytes, address);
      return await this.serial(async () => { await atomic(join(this.root, address + '.vault'), encrypted); await this.activity(); return { ok: true }; });
    } finally { bytes.fill(0); }
  }
  async document(address) {
    const file = join(this.root, address + '.vault');
    await regular(file);
    const plain = this.crypto.decrypt(await readFile(file), address);
    try {
      const document = JSON.parse(plain.toString('utf8'));
      validate(document.namespace, document.path);
      if (this.crypto.address(document.namespace, document.path) !== address) throw new Error();
      return document;
    } catch { throw new VaultError('VAULT_INTEGRITY_ERROR'); }
    finally { plain.fill(0); }
  }
  async read({ namespace = 'default', path }) {
    validate(namespace, path);
    try { return { ok: true, document: await this.document(this.crypto.address(namespace, path)) }; }
    catch (error) { if (error.code === 'ENOENT') throw new VaultError('VAULT_NOT_FOUND'); throw error; }
  }
  async delete({ namespace = 'default', path }) {
    validate(namespace, path);
    return this.serial(async () => {
      try { await unlink(join(this.root, this.crypto.address(namespace, path) + '.vault')); await this.activity(); return { ok: true, deleted: true }; }
      catch (error) { if (error.code === 'ENOENT') return { ok: true, deleted: false }; throw error; }
    });
  }
  async addresses() { return (await readdir(this.root)).filter(name => /^[a-f0-9]{64}\.vault$/.test(name)).sort().map(name => name.slice(0, -6)); }
  async list({ namespace, prefix = '', offset = 0, limit = 50, query } = {}) {
    if (namespace !== undefined && typeof namespace !== 'string' || typeof prefix !== 'string' ||
        !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        query !== undefined && (typeof query !== 'string' || query.length > 4096)) throw new VaultError('VAULT_INVALID_QUERY');
    const addresses = await this.addresses(); const records = []; let corruptCount = 0; let i = offset;
    for (; i < addresses.length && records.length < limit; i++) {
      let doc;
      try { doc = await this.document(addresses[i]); }
      catch (error) { if (error.code === 'VAULT_INTEGRITY_ERROR') { corruptCount++; continue; } throw error; }
      if (namespace !== undefined && doc.namespace !== namespace || !doc.path.startsWith(prefix) ||
          query !== undefined && !JSON.stringify(doc).includes(query)) continue;
      records.push(query === undefined ? { namespace: doc.namespace, path: doc.path, updatedAt: doc.updatedAt } : doc);
    }
    return { ok: true, records, nextOffset: i < addresses.length ? i : null, corruptCount };
  }
  async search(args) {
    if (typeof args.query !== 'string') throw new VaultError('VAULT_INVALID_QUERY');
    return this.list(args);
  }
  async status() {
    return this.serial(async () => {
    const addresses = await this.addresses(); let corruptCount = 0; let lastActivityAt = null;
    for (const address of addresses) {
      try { await this.document(address); }
      catch { corruptCount++; }
      const time = (await stat(join(this.root, address + '.vault'))).mtime.toISOString();
      if (!lastActivityAt || time > lastActivityAt) lastActivityAt = time;
    }
    try { lastActivityAt = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8')).lastActivityAt ?? lastActivityAt; } catch {}
    return { version: '0.1', healthy: corruptCount === 0, recordCount: addresses.length,
      corruptCount, lastActivityAt, encryption: 'AES-256-GCM', keyProtection: 'DPAPI-CurrentUser',
      integrity: corruptCount ? 'corruption' : 'verified' };
    });
  }
}
