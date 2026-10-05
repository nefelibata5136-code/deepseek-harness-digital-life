import { mountTimeHost } from './time-host.mjs';
import { createScheduleAdmission } from './budget-adapter.mjs';

export const inject = ['agents', 'sessions', 'tools', 'storageDomain', 'sessionPersistence', 'sessionController', 'personaBudgetProtection', 'personaSessionEntrance'];
export async function apply(ctx, config) {
  const proof = ctx.personaBudgetProtection;
  if (proof?.provider !== 'deepseek-official' || proof?.model !== 'deepseek-flash' || proof.fetch !== globalThis.fetch)
    throw new Error('A must attest the mounted D provider wire guard before Schedule activation');
  const entrance = ctx.personaSessionEntrance;
  if (entrance.sessionId !== config.sessionId || typeof entrance.resolveScheduleAgent !== 'function')
    throw new Error('A formal Session entrance is missing or does not match the Schedule target');
  const schedule = await mountTimeHost(ctx, { sessionId: config.sessionId,
    resolveAgent: id => entrance.resolveScheduleAgent(id),
    admit: createScheduleAdmission({ python: config.python, db: config.budgetDb }), budgetProtected: true });
  ctx.provide('personaSchedule', schedule);
}
