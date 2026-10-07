import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTime } from './time-host.mjs';
const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const packages = {};
for (const name of ['dsh', 'dsh-schedule', 'dsh-time-context', 'dsh-experimental-schedule-bundle',
  'dsh-api-session-controller', 'dsh-storage-domain', 'dsh-storage-json', 'dsh-session-persistence-jsonl']) {
  const path = resolve(here, '../native_dsh/node_modules/@deepseek-ai', name, 'package.json');
  const bytes = await readFile(path); const metadata = JSON.parse(bytes.toString('utf8'));
  packages[name] = { version: metadata.version, metadata_sha256: createHash('sha256').update(bytes).digest('hex') };
}
let clockService;
try {
  const { stdout } = await exec('w32tm', ['/query', '/status'], { windowsHide: true, encoding: 'buffer' });
  const diagnostic = new TextDecoder('gbk').decode(stdout);
  clockService = { diagnostic, source_is_local_cmos: diagnostic.includes('Local CMOS Clock'),
    synchronized: !diagnostic.includes('Local CMOS Clock') && !/Leap[^\n]*:\s*3\b/.test(diagnostic),
    limitation: 'Runtime samples OS clock; this does not certify NTP accuracy or alter Windows time settings.' };
} catch (error) { clockService = { verified: false, error_code: error.code }; }
const python = (process.env.DL_PYTHON || 'python');
const before = Date.now();
const sample = JSON.parse((await exec(python, ['-B', resolve(here, 'clock.py')], { windowsHide: true })).stdout);
const after = Date.now();
if (sample.timeZone !== 'Asia/Shanghai' || sample.epochMs < before - 1000 || sample.epochMs > after + 1000)
  throw new Error('Python clock and Node OS clock disagree');
const result = { observedAt: currentTime(), node: process.version, packages, harness_upgraded: false,
  official_docs: ['https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/schedule.md',
    'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/schedule.md'],
  docs_checked_in_this_session: true, windows_clock_service: clockService,
  python_node_clock_consistent: true, python_clock: sample };
await writeFile(resolve(here, '../../reports/task_C/environment.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
