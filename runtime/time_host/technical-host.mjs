import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { loadPackage } from './packages.mjs';
import { mountTimeHost, currentTime } from './time-host.mjs';
const { LlmAdapter } = await loadPackage('@deepseek-ai/dsh-llm');
export const inject = ['agents', 'sessions', 'llm', 'sessionController', 'sessionPersistence', 'storageDomain'];

export async function apply(ctx) {
  if (process.env.C_TIME_CRASH_AFTER_FLUSH_ONCE === '1') {
    const marker = process.env.C_TIME_CRASH_MARKER;
    const original = ctx.sessions.flush.bind(ctx.sessions);
    ctx.sessions.flush = async session => {
      const flushed = await original(session);
      if (flushed && !existsSync(marker) && [...session.ownEvents()].some(event =>
        event.type === 'agent/inbox/spliced' && event.data.inserted?.some(message => message.source?.kind === 'schedule'))) {
        writeFileSync(marker, 'C technical split-write crash\n'); process.exit(91);
      }
      return flushed;
    };
  }
  class Receiver extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 100000 }; }
    async *stream(options) {
      if (options.provider !== 'c-keyless') throw new Error('Technical Host rejects paid routes');
      appendFileSync(process.env.C_TIME_RECEIVER_LOG, JSON.stringify({ at: currentTime(), messages: options.messages }) + '\n');
      const text = 'C technical receiver acknowledged.';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['c-keyless'], new Receiver()));
  ctx.provide('cSchedule', await mountTimeHost(ctx, {
    sessionId: process.env.C_TIME_TARGET_SESSION,
    budgetProtected: true,
    admit: async input => {
      const allowed = process.env.C_TIME_BUDGET_ALLOW !== '0';
      appendFileSync(process.env.C_TIME_ADMISSION_LOG, JSON.stringify({ ...input, allowed, kind: 'technical-budget-stub' }) + '\n');
      return { allowed };
    },
    resolveAgent: id => ctx.sessionController.resolveAgent(id),
    onDuplicate: input => appendFileSync(process.env.C_TIME_DUPLICATE_LOG, JSON.stringify(input) + '\n')
  }));
}
