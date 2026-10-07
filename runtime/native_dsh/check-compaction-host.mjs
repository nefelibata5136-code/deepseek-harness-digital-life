// Read only the latest durable model envelope; never wake the formal Agent.
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const marker = JSON.parse(await readFile(resolve(here, '../../reports/first_native_start.json'), 'utf8'));
const ctx = new Context();
try {
  await ctx.plugin(SessionStore);
  await ctx.plugin(JsonlPersistence, { root: resolve(here, 'home/sessions'), compression: 'none' });
  await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'first-search' });
  const observation = await ctx.sessionQuery.observeSession(SessionId(marker.native_session_id), { projectionMode: 'none' });
  try {
    const session = Session.create(SessionId(marker.native_session_id), observation.events, observation.header, observation.inheritedEventCount);
    const header = session.requestHeader();
    const result = { observedAt: new Date().toISOString(), sessionId: session.id,
      latestDurableModelEnvelopeHasContextCompact: header?.tools?.some(tool => tool.name === 'context_compact') ?? false,
      latestConfig: header?.config, modelCalled: false, sourceSessionWritten: false,
      scope: 'Readback of latest saved model-visible tools; this does not trigger compaction or restart the Host.' };
    await writeFile(resolve(here, '../../reports/compaction/production-readback.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { observation[Symbol.dispose](); }
} finally { await ctx.fiber.dispose(); }
