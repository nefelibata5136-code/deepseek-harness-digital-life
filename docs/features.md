# Feature matrix

Evidence inspected on 2026-10-06. Private acceptance prompts, utterances, results
and screenshots remain local. Historical acceptance differs from public reproduction.

Stable = implementation plus meaningful bounded acceptance/use.
Experimental = code exists but coverage, transport/security/portability is incomplete.
Disabled = an implemented mechanism deliberately off.
Planned = a direction without a complete accepted public implementation.
The whole framework remains Experimental.

| Feature | Status | Evidence and boundary |
|---|---|---|
| Workspace read/write/edit | Stable | Native files/CAS/per-path locks; unrestricted OS permissions are not a sandbox |
| File protection/restore | Stable | snapshots.py, change.mjs; dirty baseline, seal conflict, quiescent restore |
| Memory proposals/acceptance/cards | Stable | Append-only journal, stable IDs and conflicts; no real store exported |
| Recall/search/original reading | Stable | Actual optional API acceptance plus synthetic tests; charges separate |
| Notes / continuity / index | Stable | Local file and life_working_write mechanisms; persona authors content |
| Web/research | Stable | Source adapters, explicit full-text pages, policy fixtures; reachability varies |
| Bluesky core read/post | Stable | Fixed Host client, deterministic draft/TID, canonical readback; bounded real API evidence |
| Bluesky expanded social/DM/media | Experimental | Offline action tests; incomplete real-agent full acceptance; rejected DM is not delivery |
| XHS public read-only | Stable | Opaque references/fixed actions, images and real search/read/restart evidence |
| XHS private AI / OCR export | Experimental | Extra services/setup/cost; not quick start |
| Browser direct actions | Stable | Minimum real browser/visual acceptance; public startup disabled |
| Browser backup | Experimental | Backup hashes exist; login-state protection required |
| Browser profile restore | Experimental | Not fully accepted; backup count does not prove restore |
| Computer Use | Experimental | Bounded real applications/indicator acceptance, partial app coverage; public default off |
| Native subagents | Stable | Native spawn/control, Session provenance and interruption; shared resources |
| Codex advisor | Stable | Isolated read-only one-shot and actual bounded acceptance; own login/cost |
| Native schedule integration | Stable | Restart delivery and isolated fixtures; upstream bundle itself experimental |
| Budget gate/accounting | Stable | Atomic reservations, actual usage, uncertain delivery retained; dated prices, no public date exemption |
| life_* preferences/state | Experimental | Versioned store and pending acceptance; evolving composition semantics |
| Self-authored context_compact | Stable | Byte-exact native tests, references/crash recovery, no auxiliary model |
| Capability install/accept/refresh/disable | Stable | Hash acceptance and isolated workers; changed code needs renewed review |
| Self-maintenance/rollback | Stable | Current-byte checkpoint/seal/hash refusal; external actions not retractable |
| Private Vault | Experimental | DPAPI/AES-GCM plus projection tests; not protection from same-user full access/compromised Host |
| Resident periodic wake | Disabled | Default false; one-current-wake elapsed-window semantics |
| Resident continue/rest/state board | Experimental | Bounded live and native-loop fixtures; explanations are not chain-of-thought |
| Intention sampling | Experimental | Explicit consent, same-source read-only expansion; drafts are not decisions/memories |
| Dots / Slack | Experimental | Protocol/tasks/offline tests; genuine complete round trip still unaccepted |
| Main-session recovery | Experimental | Diagnostics/self-checkpoint/resume exported; installed watchdog excluded |
| Desktop multi-window | Experimental | Upstream patch and prior installed-app evidence; build/version acceptance needed |
| Portable standby self-repair | Planned | Deployment service/authorization/known-good private snapshots excluded |
| Always-on / cross-platform private runtime | Planned | No powered-off execution promise; platform work remains |

Public-default disabled is a launch setting, separate from historical acceptance.
See [security](security.md), [installation](installation.md), [validation](validation.md).
