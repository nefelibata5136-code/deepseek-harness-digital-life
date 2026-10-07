import { pythonAuthority } from '../budget_guard/provider_gate.mjs';

/** D's read-only preflight. The actual request reservation remains at D's wire gate. */
export function createScheduleAdmission({ python, db, rpc = pythonAuthority({ python, db }) }) {
  return async () => {
    const status = await rpc('status');
    if (status.timezone !== 'Asia/Shanghai' || !Number.isSafeInteger(status.available) || status.available < 0
        || !Object.hasOwn(status, 'stop_reason')) throw new Error('D returned an invalid budget status');
    return { allowed: status.stop_reason === null && (status.budget_limits_enabled === false || status.daily_limit_enforced === false || status.available > 0),
      reason: status.stop_reason, source: 'D.authority.status', date: status.date };
  };
}
