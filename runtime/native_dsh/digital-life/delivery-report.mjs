import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostRequest, history } from '../../desktop_persona/usage-adapter.mjs';
const base = resolve(import.meta.dirname, '../../..');
const json = async name => JSON.parse(await readFile(resolve(base, name), 'utf8'));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const readiness = await json('reports/task_A/readiness.json');
for (const [name, expected] of Object.entries(readiness.source_sha256)) assert.equal(await hash(resolve(base, name)), expected, name);
const h = await history();
assert.equal(h.running, false, 'Finish only when the seat is resting');
const request = await json('reports/digital-life/acceptance-request-id.json');
const input = h.rows.find(r => r.role === 'user' && r.requestId === request.requestId);
assert(input, 'The actual original acceptance request must be in native history');
// Inbox splice can precede turn/start, so the UI's user-row turn is the
// preceding turn. Bound the response by native event order and next input.
const nextInput = h.rows.find(r => r.role === 'user' && r.seq > input.seq);
const actualFinal = h.rows.filter(r => r.role === 'assistant' && r.seq > input.seq
  && r.seq < (nextInput?.seq ?? Infinity)).at(-1);
assert(actualFinal?.text.includes('通过'), 'Do not infer acceptance from a different turn');
const final = await json('reports/digital-life/acceptance-final-response.json');
assert.equal(final.value.state, 'completed');
assert.equal(final.value.authoritative, true);
assert.equal(final.value.errors.length, 0);
const status = (await hostRequest('GET', '/status')).value;
assert.equal(status.digitalLife.seatPresent, false);
assert.equal(status.digitalLife.settings.residentEnabled, true);
assert.equal(status.digitalLife.clock.nextWakeAt, '2026-10-05T01:00:00.000Z');
const acceptancePath = '.local/workspace/development/digital-life-acceptance.md';
const presetSources = {};
for (const name of ['index.mjs', 'entrance.mjs', 'client.js', 'package.json', 'cordis.patch.yml'])
  presetSources['runtime/digital_life_preset/' + name] = await hash(resolve(base, 'runtime/digital_life_preset', name));
const report = {
  passed: true, observedAt: new Date().toISOString(), identity: status.digitalLife.identity,
  seatSessionId: status.digitalLife.seatSessionId,
  acceptance: { path: acceptancePath, sha256: await hash(acceptancePath), nativeTurn: actualFinal.turn,
    requestId: request.requestId, finalSeq: actualFinal.seq, finalConfirmation: final.value.requestId,
    provenance: 'Persona herself wrote and amended the acceptance file through native tools',
    originalTransport: 'HTTP client timed out; one admitted turn completed; recovered original native turn without retry' },
  digitalLife: status.digitalLife, readinessSourcesVerified: Object.keys(readiness.source_sha256).length,
  presetSources,
  desktop: { actualInstalledVersion: '0.2.0-rc.2', selectedDefault: 'persona',
    verified: ['actual settings card and selection', 'persistent profile', 'desktop reload enters existing Persona panel',
      'new blank conversation enters existing Persona panel', 'single-seat/activity status visible'],
    existingStandardNavigation: 'offline client test; not asserted as a live desktop test' },
  validation: ['8 store/advisor tests', '39 compaction tests', 'installed official Registry/Loader mounting',
    'native offline identity/state/advice/cold-process/quiet-wake checks', 'path traversal and Windows junction rejected; original card preserved',
    'actual Codex app-server readOnly/network=false/MCP=0 inspection', 'actual Persona Codex advice delivery and explicit acceptance',
    'original file-level parallel/CAS and authenticated native channel regressions'],
  limitations: ['Codex is a read-only adviser; broad host terminal/CUA/browser channels belong only to the seat',
    'Resident needs a running Host; no model activity during shutdown', 'isolated OAuth long-term refresh remains unverified',
    'pending advice is ordinary local storage; private material belongs in the existing encrypted Vault'],
  shutdownAuthorizedByUser: true, nativeRequestSettled: true,
};
await writeFile(resolve(base, 'reports/digital-life/delivery.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, acceptancePath, resting: true,
  residentEnabled: true, intervalMs: status.digitalLife.settings.intervalMs,
  nextWakeAt: status.digitalLife.clock.nextWakeAt, mentalPresent: status.digitalLife.mental.present,
  experiences: status.digitalLife.totalExperiences, sourceProofVerified: true }));
