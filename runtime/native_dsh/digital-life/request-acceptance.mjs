import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostRequest } from '../../desktop_persona/usage-adapter.mjs';
const requestId = randomUUID();
const text = await readFile(new URL('../../../reports/digital-life/acceptance-request.txt', import.meta.url), 'utf8');
await writeFile(new URL('../../../reports/digital-life/acceptance-request-id.json', import.meta.url), JSON.stringify({ requestId, sentAt: new Date().toISOString() }));
const result = await hostRequest('POST', '/prompt', { requestId, text });
await writeFile(new URL('../../../reports/digital-life/acceptance-response.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
