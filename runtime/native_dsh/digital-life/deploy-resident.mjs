// Read-only by default. Local hot-source publication through the existing
// supervised Host, with budget maintenance admission and idle verification.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostRequest } from '../../desktop_persona/transport.mjs';
import { control } from '../../time_host/control.mjs';
import { readConfig } from '../../time_host/supervisor.mjs';
import { deploymentIdle, readAttemptStates } from './deployment-admission.mjs';
const base = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile);
const sourceHash = bytes => createHash('sha256').update(bytes).digest('hex');
// Shared startup dependencies may be edited by another task. Read only, and
// refuse if they change during this concrete loading window.
const sharedPaths = ['runtime/budget_guard/provider_gate.mjs', 'runtime/budget_guard/authority.py',
  'runtime/native_dsh/recovery/main.mjs', 'runtime/native_dsh/recovery/diagnostics.mjs', 'runtime/native_dsh/recovery/tool-protocol.mjs'];
const sharedHashes = async () => Object.fromEntries(await Promise.all(sharedPaths.map(async name => [name, sourceHash(await readFile(resolve(base, name)))])));
const sharedAtReview = await sharedHashes();
const proof = JSON.parse(await readFile(resolve(base, 'reports/resident-v1/offline-validation.json'), 'utf8'));
assert(proof.passed);
for (const [name, expected] of Object.entries(proof.sourceSha256))
  assert.equal(sourceHash(await readFile(resolve(base, name))), expected, 'Current validated bytes required: ' + name);
const stateProof = JSON.parse(await readFile(resolve(base, 'reports/state-board/live-validation.json'), 'utf8'));
const recovery = JSON.parse(await readFile(resolve(base, 'reports/state-board/live-restore-validation.json'), 'utf8'));
const branches = JSON.parse(await readFile(resolve(base, 'reports/intention-sampling/state-board-integration.json'), 'utf8'));
const memoryExclusion = JSON.parse(await readFile(resolve(base, 'reports/intention-sampling/source-exclusion-validation.json'), 'utf8'));
assert(stateProof.passed && recovery.passed && recovery.sessionId === stateProof.sessionId && recovery.stateSurvivesRealRestart);
assert(branches.passed && branches.branchBoardsTransparent && branches.draftsExcludedAfterRecovery);
assert(memoryExclusion.passed && memoryExclusion.nativeDraftSessionsExcluded === 72);
assert.equal(sourceHash(await readFile(resolve(base, 'runtime/long_term_memory/source_reader.py'))), memoryExclusion.sourceSha256);
const ledgerPath = resolve(base, 'runtime/budget_guard/control/budget.sqlite3');
const idle = async status => deploymentIdle(status, await readAttemptStates(ledgerPath));
let current = (await hostRequest('GET', '/status')).value;
if (process.argv.includes('--wait-idle')) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (!(await idle(current)) && Date.now() < deadline) {
    console.log(JSON.stringify({waitingForIdle:true,pid:current.pid,activeSessionCount:current.activeSessionIds.length,openAttempts:current.budget.open_attempts}));
    await new Promise(resolve => setTimeout(resolve, 15000));
    current = (await hostRequest('GET', '/status')).value;
  }
}
assert(await idle(current), 'Wait for idle Host and no reserved/sent provider requests; terminal unknown usage retains its reservation');
assert.deepEqual(await sharedHashes(), sharedAtReview, 'Shared startup sources changed during review; preserve the other task and revalidate');
const terminalUnknownBefore = (await readAttemptStates(ledgerPath)).unknown ?? 0;
// A foreground wait grants no permission to load bytes changed in the meantime.
for (const [name, expected] of Object.entries(proof.sourceSha256))
  assert.equal(sourceHash(await readFile(resolve(base, name))), expected, 'Validated bytes changed while waiting: ' + name);
const configPath = resolve(base, 'runtime/budget_guard/config.json');
const original = await readFile(configPath), originalConfig = JSON.parse(original);
assert(!originalConfig.maintenance_pause, 'Respect pre-existing maintenance pause');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ passed: true, applied: false, currentPid: current.pid, ready: true, idle: true,
    sourceHashesVerified: Object.keys(proof.sourceSha256).length }));
  process.exit(0);
}
const paused = Buffer.from(JSON.stringify({ ...originalConfig, maintenance_pause: true }, null, 2) + '\n');
const atomic = async bytes => { const temp = configPath + '.' + randomUUID() + '.tmp'; await writeFile(temp, bytes); await rename(temp, configPath); };
assert((await readFile(configPath)).equals(original), 'Budget config changed before admission pause');
await atomic(paused);
let ready;
try {
  const protectedStatus = (await hostRequest('GET', '/status')).value;
  assert.equal(protectedStatus.pid, current.pid, 'Host generation changed during admission pause; preserve concurrent maintenance');
  assert(await idle(protectedStatus));
  assert.deepEqual(await sharedHashes(), sharedAtReview, 'Shared startup sources changed before loading');
  assert.equal(protectedStatus.budget.stop_reason, 'maintenance_pause');
  const supervisorConfig = await readConfig(resolve(base, 'runtime/time_host/production-config.json'));
  const stopped = await control(supervisorConfig, 'stop'); assert(stopped.accepted);
  const limit = Date.now() + 120000;
  while (Date.now() < limit) { if (!(await control(supervisorConfig, 'status')).status) break; await new Promise(r => setTimeout(r, 300)); }
  await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve(base, 'runtime/time_host/task-plan.ps1'), '-Config', resolve(base, 'runtime/time_host/production-config.json'), '-Action', 'Start'],
    { windowsHide: true, timeout: 15000 });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try { const status = (await hostRequest('GET', '/status')).value;
      if (status.ready && status.pid !== current.pid) { ready = status; break; } } catch { /* Startup is not a model retry. */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  assert(ready, 'Existing Host did not restart; retain pause and inspect startup logs');
  assert.equal(ready.digitalLife.resident?.version, 1, 'Preset lifecycle actually mounted');
  assert.equal(ready.digitalLife.resident.primaryOnly, true);
  assert.equal(ready.digitalLife.stateBoard?.version, 1, 'State Board actually mounted in formal preset');
  assert.equal(ready.digitalLife.stateBoard.primaryOnly, true);
  assert.deepEqual(await sharedHashes(), sharedAtReview, 'Shared startup sources changed while loading');
  assert.equal((await readAttemptStates(ledgerPath)).unknown ?? 0, terminalUnknownBefore, 'Terminal unknown reservations must not be settled or released by deployment');
  assert.equal(ready.budget.unsettled_reservations, protectedStatus.budget.unsettled_reservations, 'Preserve the full unknown-usage reservation amount');
  assert((await readFile(configPath)).equals(paused), 'Concurrent budget config edit; preserve it');
  await atomic(original);
  const after = (await hostRequest('GET', '/status')).value;
  assert.equal(after.budget.stop_reason, null);
  const report = { passed: true, observedAt: new Date().toISOString(), applied: true, oldPid: current.pid,
    newPid: after.pid, sessionId: after.sessionId, resident: after.digitalLife.resident,
    stateBoard: after.digitalLife.stateBoard, samplingSettings: {
      enabled: after.digitalLife.settings.intentionSamplingEnabled,
      ownConsent: after.digitalLife.settings.intentionSamplingConsent },
    stateAcceptanceSessionId: stateProof.sessionId, nativeRecoveryVerified: true, branchBoardsVerified: true,
    noTestPromptToMain: true, pausedDuringRestart: true, fullAccessMode: after.filePermissions.mode,
    historicalReadinessNotRewritten: true, terminalUnknownReservationsPreserved: terminalUnknownBefore,
    budgetLedgerNotModified: true, sourceSha256: proof.sourceSha256, sharedStartupSourceSha256: sharedAtReview };
  await writeFile(resolve(base, 'reports/resident-v1/deployment-latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  // Restore only our exact temporary bytes. A failed startup remains an explicit
  // failure; this never force-starts or overwrites somebody else's config.
  if ((await readFile(configPath)).equals(paused)) await atomic(original);
  throw error;
}
