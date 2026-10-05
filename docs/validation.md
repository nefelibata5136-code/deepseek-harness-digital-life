# Validation and evidence boundaries

Checked on 2026-10-06, Windows, Node 24.16.0 and Python 3.12.10.
The clean export installs pinned DSH 0.2.0-rc.2 using npm ci. No production
node_modules, user profile, live Session, identity or memory is used by these checks.

## Public reproduction

Run npm run setup, npm test and npm run smoke after installation.
The test runner uses synthetic model/transport responses, isolated workspaces and
fresh fixture Sessions. It does not call the real persona, send social messages,
pay providers or inject input into the real desktop.

| Check | Scope and result |
|---|---|
| Node unit suites | 50 tests: store/Resident/state board/admission/advisor/read policy/Bluesky/Dots; passed |
| Memory | 22 tests: journal, identifiers, conflicts, sources and synthetic Qwen transport |
| Budget authority | 23 tests, including independent-process reservations |
| Usage report | 6 tests; no real payment claim |
| Budget provider gate | 14 tests |
| Self-maintenance | 9 scenarios: checkpoints, conflicts and restore refusal |
| Web-search | 7 offline checks |
| Credential output guard | 11 checks, synthetic secrets and isolated full-access fixture |
| Self-authored compaction | 36 checks: exact body, references, flush failure and crash recovery |
| Native Resident | Continue/rest, narrow child authority, explicit schedule delivery and loop semantics |
| Private Vault storage | 14 checks: real Windows DPAPI, AES-GCM, cold process, corruption, opaque paths, no plaintext |
| Host smoke | Native Agent loop, real isolated workspace read/write, zero paid calls, desktop off, periodic Resident off |

Deployment acceptance records were reviewed separately. Their private text,
screenshots, identifiers and logs are not reproduced here. Stable labels in
features.md describe bounded historical acceptance plus implementation; they
do not claim this release repeated authenticated external-service acceptance.

## Observed gaps

- The deployment-wide runtime fixture did not pass reactivation of an enabled
  periodic Resident after a cold restart in the clean export. Periodic mode stays
  disabled. This is not a passed recovery claim; the portable runner omits that
  deployment fixture and retains the independently passing Resident checks.
- The old schedule fixture requires a deployment technical runner and profile.
  Those are excluded. Native Resident tests cover explicit schedule delivery;
  historical restart evidence is distinguished from new public reproduction.
- The old Vault desktop projection fixture requires an excluded private desktop
  adapter. Public tests cover storage only; full application projection is not
  reaccepted in this export.
- Browser profile restore, Dots/Slack genuine round trip and broad desktop app
  coverage remain incomplete. Optional integration scripts are not promises of
  authenticated acceptance on another machine.

## Release privacy checks

The export starts from an explicit source allowlist and a fresh Git repository.
Audit scripts inspect tree, staged index and every reachable commit without
printing matched values. Hash-bound exceptions cover inspected synthetic test
credentials only. An independent local review checks personal identifiers,
machine paths, private data artifacts and Markdown links. Old Git objects,
private histories and validation transcripts are never imported.

Scanners have limits: review changes and the staged tree before every publication.
