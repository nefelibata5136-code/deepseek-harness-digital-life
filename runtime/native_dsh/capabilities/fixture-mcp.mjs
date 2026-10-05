/** Offline protocol fixture, never installed or enabled in production. */
import { createInterface } from 'node:readline';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  switch (request.method) {
    case 'initialize': reply(request.id, { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: 'offline-fixture', version: '1.0.0' },
      instructions: 'Offline fixture instructions; only expose after explicit discovery.' }); break;
    case 'tools/list': reply(request.id, { tools: [{ name: 'echo', description: 'Offline MCP echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }); break;
    case 'tools/call': reply(request.id, { content: [{ type: 'text', text: request.params.arguments.text + ':' + (process.env.TEST_TOKEN ?? 'none') }],
      structuredContent: { received: request.params.arguments.text, parentKeyPresent: !!process.env.DEEPSEEK_API_KEY } }); break;
    case 'resources/list': reply(request.id, { resources: [{ uri: 'fixture://hello', name: 'hello', mimeType: 'text/plain' }] }); break;
    case 'resources/templates/list': reply(request.id, { resourceTemplates: [] }); break;
    case 'resources/read': reply(request.id, { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'offline resource content' }] }); break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } }) + '\n');
  }
}
