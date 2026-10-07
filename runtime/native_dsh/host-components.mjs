// Deployment assembly only. Agent loop, persistence, tools and scheduling are native DSH.
import { mountTimeHost } from '../time_host/time-host.mjs';
import { pythonAuthority } from '../budget_guard/provider_gate.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createScheduleAdmission } from '../time_host/budget-adapter.mjs';
import {mountProgress} from '../activity_progress/host.mjs';
import {mountBillingRuntime} from '../deepseek_billing/service/runtime.mjs';

export const inject = ['sessionController', 'sessionPersistence', 'storageDomain', 'tools', 'workspaceFoundation', 'personaBudgetProtection', 'personaTasks', 'personaTurnAdmission','systemPrompt','agents'];
export async function apply(ctx, config) {
  mountProgress(ctx);
  if(config.officialBillingProducer===true)await mountBillingRuntime(ctx,{producer:true});
  if (ctx.personaBudgetProtection.fetch !== globalThis.fetch) throw new Error('Schedule Host must use D wire guard');
  const rpc = pythonAuthority(config);
  await rpc('init');
  const status = () => rpc('status');
  ctx.tools.register(defineTool({ name: 'budget_status',
    description: '读取北京时间今日硬预算、已结算费用、缓存/token用量、未结算预留和剩余额度。费用是官方价格计算，不是账户扣款证明。',
    parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: status }));
  const sessionId = process.env.DL_SESSION_ID;
  if (!sessionId) throw new Error('Formal Session identity must be explicit before Host startup');
  const schedule = await mountTimeHost(ctx, { sessionId, budgetProtected: true,
    isAuthorized: id => ctx.personaTasks.accepts(id), acquire: id => ctx.personaTurnAdmission.acquire(id),
    resolveAgent: id => ctx.sessionController.resolveAgent(id),
    admit: createScheduleAdmission({ python: config.python, db: config.db }) });
  ctx.provide('personaHost', { sessionId, schedule, status });
}
