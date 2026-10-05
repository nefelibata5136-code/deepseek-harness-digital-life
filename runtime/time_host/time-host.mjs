import { createHash } from 'node:crypto';
import { loadPackage } from './packages.mjs';

const Schedule = (await loadPackage('@deepseek-ai/dsh-schedule')).default;
const TimeContext = await loadPackage('@deepseek-ai/dsh-time-context');
const { createUserMessage } = await loadPackage('@deepseek-ai/dsh-llm');
export const TIME_ZONE = 'Asia/Shanghai';

export function currentTime() {
  const now = Date.now();
  return { epochMs: now, utc: new Date(now).toISOString(), timeZone: TIME_ZONE,
    local: new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now) + '+08:00' };
}

function fingerprint(message) {
  return createHash('sha256').update(JSON.stringify(message.content)).digest('hex');
}

// Native inbox splices survive a crash before schedule.json commits its receipt.
export function findDeliveredMessage(session, proposed) {
  const hash = fingerprint(proposed);
  for (const event of session.ownEvents()) {
    const messages = event.type === 'user/message' ? [event.data]
      : event.type === 'agent/inbox/spliced' ? (event.data.inserted ?? []) : [];
    for (const message of messages) {
      if (message.source?.kind === 'schedule' && fingerprint(message) === hash) return message;
    }
  }
}

/** Mount over A's official resolver and D's admission; never create another conversation driver. */
export async function mountTimeHost(ctx, options) {
  if (!options?.sessionId || typeof options.resolveAgent !== 'function' || typeof options.admit !== 'function'
      || options.budgetProtected !== true) throw new Error('A formal Session resolver and D hard budget protection are required');
  if (!ctx.get('sessionPersistence') || !ctx.get('storageDomain')) throw new Error('Native persistence and storage-domain are required');
  await ctx.plugin(TimeContext, { timeZone: TIME_ZONE, refreshIntervalMs: 0 }).await();
  ctx.on('agent/pre-step', async (_request, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    // Official time-context truthfully reports a missing browser zone. A separate durable
    // Host-zone statement supplies the deployment default without forging a user/browser source.
    return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text',
      text: `Host time zone: ${TIME_ZONE}. For this Host, interpret unqualified dates and times in this zone. A missing browser zone does not change this configured Host default. Use explicit offsets or time_zone for Schedule.` }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'persona:host-time-zone', text: TIME_ZONE }] } })] };
  }, { prepend: true });
  const storageDomain = ctx.get('storageDomain');
  const receiptAliases = new Map();
  const scoped = ctx.isolate('sessionController').isolate('storageDomain');
  const guardedController = {
    async resolveAgent(sessionId) {
      if (!(options.isAuthorized ? await options.isAuthorized(sessionId) : sessionId === options.sessionId))
        return { error: new Error('Schedule target is outside Persona workspace') };
      const lease = options.acquire ? await options.acquire(sessionId) : undefined;
      try {
      const budget = await options.admit({ sessionId, source: 'schedule', observedAt: currentTime(), timeZone: TIME_ZONE });
      if (budget?.allowed !== true) {lease?.release();return { error: new Error('Schedule budget admission denied') };}
      const result = await options.resolveAgent(sessionId);
      if ('error' in result) {lease?.release();return result;}
      if (String(result.agent.session.id) !== String(sessionId)) {lease?.release();return { error: new Error('Resolved Session identity mismatch') };}
      const agent = result.agent;
      const release = () => {unlisten?.();lease?.release();};
      const unlisten = lease ? ctx.on('agent/status', ({agent: owner,status})=>{if(owner===agent&&status==='idle')release();}) : undefined;
      return { agent: { session: agent.session, followup(message) {
        const existing = findDeliveredMessage(agent.session, message);
        if (existing) {
          // Schedule commits the already-durable id when recovering its split-write window.
          receiptAliases.set(message.id, existing.id);
          options.onDuplicate?.({ sessionId, messageId: existing.id, observedAt: currentTime() });
          release();
          return;
        }
        try {return agent.followup(message);} catch(error) {release();throw error;}
      } } };
      } catch(error) {lease?.release();throw error;}
    }
  };
  await scoped.plugin({ name: 'persona-schedule-resolver', apply(child) {
    child.provide('sessionController', guardedController);
    child.provide('storageDomain', { async open(spec) {
      const domain = await storageDomain.open(spec);
      const tasks = domain.table('tasks');
      const wrappedTasks = new Proxy(tasks, { get(target, property) {
        if (property === 'put') return (id, task) => {
          const alias = receiptAliases.get(task.lastDelivery?.messageId);
          if (alias) task = { ...task, lastDelivery: { ...task.lastDelivery, messageId: alias },
            deliveryHistory: { ...task.deliveryHistory, records: task.deliveryHistory.records.map(record =>
              receiptAliases.has(record.messageId) ? { ...record, messageId: receiptAliases.get(record.messageId) } : record) } };
          return target.put(id, task);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return new Proxy(domain, { get(target, property) {
        if (property === 'table') return name => name === 'tasks' ? wrappedTasks : target.table(name);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } });
  } }).await();
  await scoped.plugin(Schedule, { deliveryHistoryDays: 30, deliveryHistoryRecords: 200 }).await();
  if (!scoped.get('schedule')) throw new Error('Official Schedule did not activate: ' + JSON.stringify(Schedule.inject.map(name => [name, Boolean(scoped.get(name))])));
  return scoped.get('schedule');
}
