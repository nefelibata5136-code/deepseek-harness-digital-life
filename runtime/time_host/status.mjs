import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTime } from './time-host.mjs';
import { control } from './control.mjs';
import { readConfig } from './supervisor.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const read = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const version = await read(resolve(here, '../native_dsh/node_modules/@deepseek-ai/dsh/package.json'));
const schedule = await read(resolve(here, '../../reports/task_C/schedule-verification.json'));
const supervisor = await read(resolve(here, '../../reports/task_C/supervisor-verification.json'));
const task = await read(resolve(here, '../../reports/task_C/task-plan-verification.json'));
const budget = await read(resolve(here, '../../reports/task_C/budget-adapter-verification.json'));
const environment = await read(resolve(here, '../../reports/task_C/environment.json'));
console.log(JSON.stringify({ observedAt: currentTime(), native_version: version.version,
  read_only: true, model_called: false, schedule_test: schedule && { passed: schedule.passed, observed_at: schedule.observed_at },
  supervisor_test: supervisor && { passed: supervisor.passed, observedAt: supervisor.observedAt },
  task_plan_test: task, budget_adapter_test: budget,
  clock_evidence: environment && { observedAt: environment.observedAt,
    python_node_clock_consistent: environment.python_node_clock_consistent,
    windows_clock_service: environment.windows_clock_service },
  formal_persona_wakeup: 'Not certified by C; inspect A first-run and five-minute acceptance.',
  live: process.argv[2] ? await control(await readConfig(resolve(process.argv[2]))) : null }, null, 2));
