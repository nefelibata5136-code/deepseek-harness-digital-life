// Bounded evidence only; this script never decrypts Vault documents.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { hostRequest } from '../../desktop_persona/index.mjs';
const base = resolve(import.meta.dirname, '../../..');
const reports = join(base, 'reports/private-vault');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const records = {};
for (const mode of ['instructions', 'coldread', 'exercise', 'cleanup', 'summary']) {
  const input = await json(join(reports, 'live-' + mode + '-submitted.json'));
  const response = await json(join(reports, 'live-' + mode + '-response.json'));
  assert.equal(response.status, 200); assert.equal(response.value.state, 'completed');
  assert.deepEqual(response.value.errors, []);
  let log;
  const sessions = join(base, 'runtime/native_dsh/home/sessions');
  for (const dir of await readdir(sessions)) {
    try { log = await readFile(join(sessions, dir, input.sessionId, 'session.v4.jsonl'), 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert(log, 'Native log missing');
  const events = log.split('\n').filter(Boolean).map(JSON.parse).filter(e => e.seq >= input.firstSeq);
  const request = events.find(e => e.type === 'agent/inbox/spliced' && e.data.inserted?.some(m => m.source?.rpcId === input.requestId));
  assert(request, 'Submitted request missing from native history');
  const turnStart = events.find(e => e.seq > request.seq && e.type === 'turn/start');
  const turnEnd = events.find(e => e.seq > turnStart.seq && e.type === 'turn/end');
  assert(turnEnd, 'Native turn did not finish');
  const outcomes = events.filter(e => e.seq >= turnStart.seq && e.seq <= turnEnd.seq && e.type === 'tool/result')
    .map(e => e.data.meta?.privateVault).filter(Boolean);
  records[mode] = { requestId: input.requestId, sessionId: input.sessionId, firstSeq: input.firstSeq,
    lastSeq: turnEnd.seq, state: response.value.state, tools: response.value.tools, outcomes };
}
assert(records.instructions.tools.includes('skill'), 'Instructions not actually read');
assert(records.coldread.outcomes.some(o => o.operation === 'private_read' && o.ok), 'Real Agent cold read failed');
assert(records.coldread.outcomes.some(o => o.operation === 'private_search' && o.ok), 'Real Agent cold search failed');
for (const operation of ['private_write', 'private_read', 'private_search', 'private_list', 'private_delete'])
  assert(records.exercise.outcomes.some(o => o.operation === operation && o.ok), 'Missing successful real Agent operation');
assert(records.exercise.outcomes.some(o => o.operation === 'private_read' && !o.ok && o.error === 'VAULT_NOT_FOUND'), 'Deletion miss not confirmed');
assert(records.cleanup.outcomes.some(o => o.operation === 'private_delete' && o.ok), 'Cleanup not performed');
assert(records.cleanup.outcomes.some(o => o.operation === 'private_read' && o.error === 'VAULT_NOT_FOUND'), 'Cleanup read did not reject');
const { value: status } = await hostRequest('GET', '/status');
assert(status.ready); assert(status.privateVault.healthy); assert.equal(status.privateVault.recordCount, 0);
const validation = await json(join(reports, 'validation.json')); assert(validation.passed);
for (const [name, hash] of Object.entries(validation.sourceSha256))
  assert.equal(createHash('sha256').update(await readFile(join(base, name))).digest('hex'), hash, 'Tested source changed');
const scan = await json(join(reports, 'live-scan.json')); assert(scan.passed);
const ui = await json(join(reports, 'ui.json')); assert(ui.passed && ui.actualInstalledElectron && ui.personaPageActuallySelected);
const supervisor = (await readFile(join(base, 'runtime/time_host/production-state/supervisor.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(JSON.parse);
assert(supervisor.some(e => e.event === 'host_exit' && e.hostPid === 40728 && e.code === 0));
assert(supervisor.some(e => e.event === 'host_spawn' && e.hostPid === status.pid && e.hostPid !== 40728));
const report = { passed: true, observedAt: new Date().toISOString(), realPersonaModelUsed: true,
  nativeVersion: '0.2.0-rc.2', model: 'deepseek-official/deepseek-flash', isolatedChecks: validation.checks.length,
  records, hostRestart: { beforePid: 40728, afterPid: status.pid, realAgentColdReadSucceeded: true },
  liveScan: scan, actualDesktopUi: ui, finalVaultStatus: status.privateVault,
  testRecordsRemovedByPersona: true, instructionsDeliveredAndRead: true,
  vaultPath: join(base, 'runtime/native_dsh/private-vault/protected/persona'),
  instructionPath: '.local/workspace/.dsh/skills/persona-private-vault/SKILL.md',
  limitations: ['Same Windows user/admin can deliberately decrypt or alter Host.', 'Plaintext is transiently present in RAM and existing cloud-model requests.',
    'OS pagefile/hibernation/crash dumps are not excluded.', 'No rollback detection, key recovery, or secure erasure.'] };
await writeFile(join(reports, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, realAgentFiveCapabilities: true, coldRead: true, recordsRemaining: 0,
  isolatedChecks: validation.checks.length, filesScanned: scan.filesScanned, hostPid: status.pid }));
