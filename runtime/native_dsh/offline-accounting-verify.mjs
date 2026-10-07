// Real Cordis disposal test with an in-memory mock RPC; no API, model or real ledger.
import { Context } from '@deepseek-ai/cordis';
import { mountUsageAccounting } from './persona-plugin.mjs';
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ctx = new Context();
const writes = [];
mountUsageAccounting(ctx, async (tool, args) => {
  await new Promise(resolve => setTimeout(resolve, 35));
  writes.push({ tool, ...args });
  return tool === 'budget_check' ? { allowed: true } : { saved: true };
});
const agent = { session: { id: 'offline-final-usage' }, options: { provider: 'deepseek-official', model: 'deepseek-flash' } };
ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'last-attempt', turn: 1, step: 1 } });
ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'last-attempt', index: 8,
  time: Date.now(), chunk: { type: 'usage', usage: { inputTokens: 3, cacheReadTokens: 7, outputTokens: 5 } } } });
const beforeDispose = writes.length;
await ctx.fiber.dispose();
if (beforeDispose !== 0 || writes.length !== 2 || writes[0].tool !== 'usage_start' || writes[1].tool !== 'usage')
  throw new Error('Final asynchronous usage did not drain during real Cordis disposal');

// Pending admission/error paths must stop before calling the native continuation.
let continued = false;
const blocked = new Context();
mountUsageAccounting(blocked, async () => ({ allowed: false, reason: 'unreported_provider_attempt' }));
let refused = false;
try {
  await blocked.waterfall('agent/pre-step', { agent, signal: new AbortController().signal },
    async () => { continued = true; return {}; });
} catch (error) { refused = String(error).includes('unreported_provider_attempt'); }
await blocked.fiber.dispose();
if (!refused || continued) throw new Error('Unreported usage did not stop pre-step admission');

// Follow the real DSH order: build lazy stream, emit start, then iterate.
const gated = new Context();
let pendingPersisted = false; let providerSawPending = false;
mountUsageAccounting(gated, async tool => {
  await new Promise(resolve => setTimeout(resolve, 35));
  if (tool === 'usage_start') pendingPersisted = true;
  return { saved: true };
});
const request = markAgentLoopRequest({ provider: 'deepseek-official', model: 'deepseek-flash' });
const stream = gated.waterfall('llm/stream', request, () => (async function* () {
  providerSawPending = pendingPersisted;
  yield { type: 'text', text: 'offline only' };
})());
gated.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'gated-attempt', turn: 1, step: 1 } });
for await (const _chunk of stream) { /* No actual transport/provider. */ }
await gated.fiber.dispose();
if (!providerSawPending) throw new Error('Provider iteration began before pending usage persistence');

const result = { observed_at: new Date().toISOString(), native_cordis_version: '4.0.4',
  real_fiber_dispose_awaited_last_usage: true, writes_before_dispose: beforeDispose,
  mock_rpc_order: writes.map(item => item.tool), unreported_usage_blocks_before_next: true,
  pending_persisted_before_native_provider_iteration: true,
  api_called: false, real_ledger_written: false, workspace_written: false };
await writeFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../reports/native_accounting_validation.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
