// Read-only native-history inspection. Does not boot the production Host or call a model.
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function arg(name, fallback) { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; }
const id = arg('--session');
if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Usage: node inspect-compaction.mjs --session UUID [--root SESSION-ROOT]');
const root = resolve(arg('--root', resolve(here, 'home/sessions')));
const ctx = new Context();
try {
  await ctx.plugin(SessionStore);
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' });
  await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'first-search' });
  const observation = await ctx.sessionQuery.observeSession(SessionId(id), { projectionMode: 'none' });
  try {
    const events = observation.events;
    const summaries = events.filter(event => event.type === 'compaction/summary').map(event => {
      const data = event.data;
      const summary = data.summary.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const match = summary.match(/<persona-source-manifest>(.*?)<\/persona-source-manifest>/s);
      const replacement = events.find(item => item.type === 'user/message' && item.data.source?.compactionId === data.compactionId);
      return { time: new Date(event.time).toISOString(), compactionId: data.compactionId, summarySeq: event.seq,
        provider: data.provider, model: data.model, shadowedRange: data.shadowedRange, shadowedSeqs: data.shadowedSeqs,
        beforeEstimatedTokens: data.shadowedTokenCount,
        afterEstimatedTokens: replacement ? estimateMessage(replacement.data) : estimateMessage(createUserMessage({
          content: data.summary, source: { kind: 'user' } })),
        usage: data.usage ?? null, summary, sourceManifest: match ? JSON.parse(match[1]) : null };
    });
    const attempts = events.filter(event => ['compaction/start', 'compaction/end'].includes(event.type));
    console.log(JSON.stringify({ sessionId: id, originalHistoryRoot: root, eventCount: events.length, summaries, attempts }, null, 2));
  } finally { observation[Symbol.dispose](); }
} finally { await ctx.fiber.dispose(); }
