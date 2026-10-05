// Deterministic text screening, not a sandbox or a semantic intent classifier.
export const BLOCKED = '[KEY_OUTPUT_BLOCKED: 本地审查发现可能的密钥，原文未输出]';
const keyShape = /\bsk-[A-Za-z0-9_-]{16,}\b/;
export function createDetector(knownSecrets = []) {
  const variants = [];
  for (const secret of new Set(knownSecrets.filter(s => typeof s === 'string' && s.length >= 16))) {
    const bytes = Buffer.from(secret);
    for (const [encoding, value] of Object.entries({
      raw: secret, base64: bytes.toString('base64'), base64url: bytes.toString('base64url'),
      hex: bytes.toString('hex'), hexUpper: bytes.toString('hex').toUpperCase(),
      url: encodeURIComponent(secret), unicode: [...secret].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join(''),
    })) {
      variants.push({ encoding, value });
      if (encoding === 'unicode') variants.push({encoding: 'unicode-json', value: value.replaceAll('\\', '\\\\')});
    }
  }
  const inspectText = text => {
    for (const variant of variants) if (text.includes(variant.value)) return { rule: 'known-key', encoding: variant.encoding };
    if (keyShape.test(text)) return { rule: 'key-shaped-text' };
    return null;
  };
  const inspect = (value, visited = new Set()) => {
    if (typeof value === 'string') return inspectText(value);
    if (!value || typeof value !== 'object' || visited.has(value)) return null;
    visited.add(value);
    if (value instanceof Error) return inspectText(String(value.message));
    for (const [key, item] of Object.entries(value)) {
      const hit = inspectText(key) ?? inspect(item, visited);
      if (hit) return hit;
    }
    return null;
  };
  const sanitize = value => {
    if (typeof value === 'string') return inspect(value) ? BLOCKED : value;
    if (Array.isArray(value)) return value.map(sanitize);
    if (value instanceof Error) return inspect(value) ? new Error(BLOCKED) : value;
    if (value && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [inspect(key) ? 'KEY_OUTPUT_BLOCKED_PROPERTY' : key, sanitize(item)]));
    return value;
  };
  return { inspect, sanitize };
}

export function credentialAccessCandidate(name, args = {}) {
  if (['read', 'read_source', 'list_files'].includes(name)
      && /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.credentials[^\\/]*|auth\.json|credentials(?:\.json)?)(?:$|[\\/])/i.test(args.file_path ?? args.path ?? ''))
    return { rule: 'credential-path' };
  if (name === 'terminal' && /\b(?:CredRead|CryptUnprotectData|DEEPSEEK_API_KEY|DASHSCOPE_API_KEY|GetEnvironmentVariable|api_key)\b/i.test(args.command ?? ''))
    return { rule: 'credential-api-or-variable' };
  return null;
}
