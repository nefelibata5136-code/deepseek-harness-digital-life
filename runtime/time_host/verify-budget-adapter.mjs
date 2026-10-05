import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScheduleAdmission } from './budget-adapter.mjs';
import { currentTime } from './time-host.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const python = process.argv[2] ?? 'python';
const root = resolve(here, '../../reports/task_C/budget-adapter-runs', randomUUID());
await mkdir(root, { recursive: true });
const setup = async mode => {
  const db = resolve(root, mode + '.sqlite3');
  const child = spawn(python, ['-B', resolve(here, 'budget-test-fixture.py'), db, mode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', x => { stderr += x; }); child.stdout.resume();
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, stderr); return db;
};
const allowed = await createScheduleAdmission({ python, db: await setup('empty') })();
assert.equal(allowed.allowed, true);
const denied = await createScheduleAdmission({ python, db: await setup('unknown') })();
assert.equal(denied.allowed, false); assert.equal(denied.reason, 'unresolved_usage');
await assert.rejects(createScheduleAdmission({ python, db: resolve(root, 'uninitialized.sqlite3') })());
const result = { observedAt: currentTime(), passed: true, paid_api_called: false, formal_ledger_written: false,
  actual_D_authority_status: true, initialized_empty_allowed: allowed, unresolved_usage_denied: denied,
  missing_authority_failed_closed: true, root };
await writeFile(resolve(here, '../../reports/task_C/budget-adapter-verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
