import { apply as mountBudget } from '../budget_guard/provider_gate.mjs';
export function apply(ctx, config) {
  mountBudget(ctx, config);
  const property = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  if (property?.writable !== false || property.configurable !== false) throw new Error('D wire guard is not installed');
  ctx.provide('personaBudgetProtection', { provider: 'deepseek-official', model: 'deepseek-flash', fetch: globalThis.fetch });
}
