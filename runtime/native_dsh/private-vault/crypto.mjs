import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import koffi from 'koffi';

export class VaultError extends Error {
  constructor(code) { super(code); this.name = 'VaultError'; this.code = code; }
}

// Native DPAPI: no shell, environment variable, helper file, or secret IPC.
function dpapi(bytes, protect) {
  if (process.platform !== 'win32') throw new VaultError('VAULT_WINDOWS_REQUIRED');
  const blob = koffi.struct({ cbData: 'uint32', pbData: 'void *' });
  const crypt = koffi.load('crypt32.dll');
  const kernel = koffi.load('kernel32.dll');
  const free = kernel.func('void * __stdcall LocalFree(void *)');
  const operation = protect
    ? crypt.func('CryptProtectData', 'bool', [koffi.pointer(blob), 'void *', 'void *', 'void *', 'void *', 'uint32', koffi.out(koffi.pointer(blob))])
    : crypt.func('CryptUnprotectData', 'bool', [koffi.pointer(blob), 'void *', 'void *', 'void *', 'void *', 'uint32', koffi.out(koffi.pointer(blob))]);
  const output = {};
  // CRYPTPROTECT_UI_FORBIDDEN only; deliberately no LOCAL_MACHINE flag.
  if (!operation({ cbData: bytes.length, pbData: bytes }, null, null, null, null, 1, output))
    throw new VaultError('VAULT_KEY_UNAVAILABLE');
  try {
    const view = Buffer.from(koffi.view(output.pbData, output.cbData));
    const result = Buffer.from(view);
    view.fill(0);
    return result;
  } finally { free(output.pbData); }
}

export class PrivateVaultCrypto {
  constructor(protectedKey) { this.protectedKey = protectedKey; }
  static generate() {
    const key = randomBytes(32);
    try { return dpapi(key, true); } finally { key.fill(0); }
  }
  withKey(fn) {
    const key = dpapi(this.protectedKey, false);
    try {
      if (key.length !== 32) throw new VaultError('VAULT_KEY_UNAVAILABLE');
      return fn(key);
    } finally { key.fill(0); }
  }
  address(namespace, path) {
    return this.withKey(key => createHmac('sha256', key).update(JSON.stringify([namespace, path])).digest('hex'));
  }
  encrypt(plaintext, address) {
    return this.withKey(key => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from('Persona.PrivateVault.v1:' + address));
      return Buffer.concat([Buffer.from('YBV1'), nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    });
  }
  decrypt(bytes, address) {
    return this.withKey(key => {
      try {
        if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'YBV1') throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
        cipher.setAAD(Buffer.from('Persona.PrivateVault.v1:' + address));
        cipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([cipher.update(bytes.subarray(16, -16)), cipher.final()]);
      } catch { throw new VaultError('VAULT_INTEGRITY_ERROR'); }
    });
  }
}
