import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentIdle } from './deployment-admission.mjs';
const idle = { ready: true, busy: false, activeSessionIds: [] };
test('terminal unknown usage permits idle loading while reservations stay outside this decision', () => {
  assert(deploymentIdle(idle, { unknown: 4, settled: 100, accounted_upper: 2 }));
});
test('sent or reserved requests on any day block loading, even with matching aggregate unknown/open counts', () => {
  assert(!deploymentIdle(idle, { unknown: 4, sent: 3 }));
  assert(!deploymentIdle(idle, { unknown: 4, reserved: 1 }));
});
test('active sessions, busy or unready Host always block loading', () => {
  assert(!deploymentIdle({ ...idle, activeSessionIds: ['session'] }, { unknown: 1 }));
  assert(!deploymentIdle({ ...idle, busy: true }, { unknown: 1 }));
  assert(!deploymentIdle({ ...idle, ready: false }, {}));
});
test('unrecognized ledger states fail closed', () => {
  assert(!deploymentIdle(idle, { future_state: 1 }));
});
