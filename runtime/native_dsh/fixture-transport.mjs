import assert from 'node:assert/strict';
import { resolve } from 'node:path';
export function fixtureTransport(workspace, { startAt = 0 } = {}) {
let sent = startAt; const wires = [];
const transport = async (url, init) => {
  assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/messages');
  const body = JSON.parse(init.body); wires.push(body); sent++;
  let block;
  if (sent === 1) block = { type: 'tool_use', id: 'tool-' + sent, name: 'read', input: { file_path: resolve(workspace, 'audit.txt') } };
  else if (sent === 2) block = { type: 'tool_use', id: 'tool-' + sent, name: 'write', input: { file_path: resolve(workspace, 'audit.txt'), content: 'after\n' } };
  else block = { type: 'text', text: 'Offline integrated native Host acknowledged.' };
  const events = [
    { type: 'message_start', message: { id: 'msg-' + sent, role: 'assistant', model: 'deepseek-flash', content: [],
      usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } },
    { type: 'content_block_delta', index: 0, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' }
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream', 'request-id': 'offline-' + sent } });
};
return { transport, count: () => sent, wires };
}
