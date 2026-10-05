import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PrivateVaultStore } from './store.mjs';
import { bootNative, here } from '../boot-native.mjs';

const run = resolve(here, '../../reports/private-vault/runs/' + randomUUID());
await mkdir(run, { recursive: true });
const checks = [];
const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); console.log('PASS ' + name); };
const secret = 'PRIVATE-' + randomBytes(32).toString('hex') + '-仅在运行时生成';
const privatePath = 'path-' + randomBytes(16).toString('hex');
const namespace = 'namespace-' + randomBytes(16).toString('hex');
async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Unexpected test symlink');
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}
async function noPlaintext(root, values) {
  for (const path of await files(root)) {
    const bytes = await readFile(path);
    for (const value of values) {
      if (bytes.includes(Buffer.isBuffer(value) ? value : Buffer.from(value)) ||
          typeof value === 'string' && bytes.includes(Buffer.from(value, 'utf16le'))) throw new Error('PLAINTEXT_SCAN_FAILED');
    }
  }
}

try {
  const root = join(run, 'store');
  const store = await new PrivateVaultStore(root).init();
  check('Windows DPAPI CurrentUser initialization', (await readFile(join(root, 'master.dpapi'))).length > 32);
  await store.write({ namespace, path: privatePath, value: secret });
  check('AES-GCM write/read roundtrip', (await store.read({ namespace, path: privatePath })).document.value === secret);
  // Fresh OS process, not a cached key or cached store object.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {PrivateVaultStore} from './private-vault/store.mjs';let s='';for await(const b of process.stdin)s+=b;const x=JSON.parse(s);const v=await new PrivateVaultStore(x.root).init();if((await v.read(x)).document.value!==x.expected)process.exit(1);console.log('cold-read-ok');"],
    { cwd: here, input: JSON.stringify({ root, namespace, path: privatePath, expected: secret }), encoding: 'utf8', windowsHide: true });
  check('fresh process restart reads existing Vault', child.status === 0 && child.stdout.trim() === 'cold-read-ok');
  const address = store.crypto.address(namespace, privatePath);
  const path = join(root, address + '.vault'); const original = await readFile(path);
  const tampered = Buffer.from(original); tampered[20] ^= 1; await writeFile(path, tampered);
  await assert.rejects(store.read({ namespace, path: privatePath }), { code: 'VAULT_INTEGRITY_ERROR' });
  check('tampered ciphertext rejected', true);
  const reopened = await new PrivateVaultStore(root).init();
  await reopened.write({ path: 'healthy', value: 'safe fixture' });
  check('one damaged document does not stop startup/read', (await reopened.read({ path: 'healthy' })).ok && !(await reopened.status()).healthy);
  check('listing reports corruption without leaking contents', (await reopened.list()).corruptCount === 1);
  // Authentication also binds ciphertext to its opaque document address.
  await writeFile(join(root, reopened.crypto.address('default', 'healthy') + '.vault'), original);
  await assert.rejects(reopened.read({ path: 'healthy' }), { code: 'VAULT_INTEGRITY_ERROR' });
  check('cross-document ciphertext substitution rejected', true);
  await store.write({ namespace, path: privatePath, value: secret });
  await store.write({ namespace, path: privatePath, value: secret + '-updated' });
  check('atomic overwrite readable', (await store.read({ namespace, path: privatePath })).document.value === secret + '-updated');
  check('private search works', (await store.search({ query: secret, namespace })).records.length === 1);
  check('delete and repeated delete work', (await store.delete({ namespace, path: privatePath })).deleted && !(await store.delete({ namespace, path: privatePath })).deleted);
  await store.write({ namespace, path: privatePath, value: secret });
  await store.write({ path: '../../escape', value: 'opaque addresses only' });
  check('paths are logical addresses, never filesystem paths', (await store.read({ path: '../../escape' })).ok);
  check('Vault contains only protected key, ciphertext, and nonsensitive status', (await readdir(root)).every(name => ['master.dpapi', 'state.json'].includes(name) || /^[a-f0-9]{64}\.vault$/.test(name)));
  // Crash residue is already encrypted; it cannot replace the committed document.
  await writeFile(join(root, address + '.vault.interrupted.tmp'), original.subarray(0, 20));
  check('interrupted atomic-write residue does not damage committed documents', (await (await new PrivateVaultStore(root).init()).read({ namespace, path: privatePath })).document.value === secret);
  const key = store.crypto.withKey(key => Buffer.from(key));
  try { await noPlaintext(run, [secret, namespace, privatePath, key, key.toString('hex'), key.toString('base64')]); }
  finally { key.fill(0); }
  check('recursive byte scan: no plaintext, address metadata, or master key', true);

  console.log(JSON.stringify({passed:true,checks:checks.length,scope:'Windows DPAPI/AES-GCM storage only',paidModelCalls:0}));
} catch(error) { console.error('Vault storage verification failed: '+error.name); process.exitCode=1; }
