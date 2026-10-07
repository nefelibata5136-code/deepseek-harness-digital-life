# Architecture

This document describes the retained v0.1 single-persona compatibility composition.
For v0.2 World, independent workers and owner routing, see [Technical Overview](technical-overview.md) and [Code Guide](code-guide.md).

This is a Cordis composition over official DSH 0.2.0-rc.2, not another inference
driver or handwritten Agent loop.

## Identity, Session and workspace

The maintainer supplies local persona-core.md. The bridge reads the current
literal identity into the native prompt. The primary Session is an explicit
persisted UUID, never inferred from message text. Independent activities retain
their Session provenance and do not automatically speak in the persona's voice.

Native Session events record actions. A checkpoint is a shorter current context
representation, not formal memory or proof that an omitted event never happened.
Exact facts require original-source lookup.

workspace_foundation mounts official file tools and observation/CAS policy.
Different conversations/paths can proceed independently; canonical same-path
operations serialize. Opaque terminal/desktop targets remain exclusive during
operations. Versions live outside the writable workspace. Restore needs stopped
writers and an explicitly reviewed plan.

## Memory and continuity

long_term_memory separates original records, semantic event proposals, accepted
events, recall entrances, annotations and rebuildable indexes. The persona
authors boundaries/meaning; raw chat is not embedded wholesale. Search returns
accepted entrances; memory_open explicitly pages evidence. Source changes and
conflicts never silently overwrite accepted history.

Notes, continuity, memory cards, mental-state text, pending suggestions and context
summaries serve different purposes. None automatically becomes another.
Activity acceptance alone does not author a memory or mental state.

## Host, time and budget

configure expands placeholders into ignored local paths. start supplies trusted
process configuration and explicit identity. native-host exposes authenticated
loopback status/prompt/task routes; task-host serializes submissions per Session.

budget_guard is a durable SQLite authority using integer nano-CNY. The provider
wire gate atomically reserves worst-case bounded request cost, then settles actual
usage. Uncertain delivery retains reservations. It covers DeepSeek, not Codex,
embedding/rerank or OCR. time_host mounts native schedules/storage/Session control,
adds real time and admission. Native restart catch-up differs from Resident.

## Capabilities and delegation

Each reviewed capability has metadata, profile, credential references and a
release digest. Installation starts disabled; inspect/accept precede enable/refresh.
Changes require renewed acceptance. Bounded IPC and worker Job Objects isolate
lifecycle/resources, not malicious code.

DSH owns native spawn/control. The Codex advisor uses a separate login/config home,
disposable read-only work area and one-shot mode. Advice retains source and does
not become an authoritative persona decision.

## Desktop and recovery

Computer Use wraps official native driver/attachments inside the same Agent loop,
shares the desktop and requires fresh snapshots. Browser direct actions use one
dedicated Chrome profile via browser-use MCP, not a second browser Agent.
Both are disabled in public startup.

Main-session diagnostic/protocol normalization, lightweight self-checkpoint and
resume checks are exported. The installed standby service, private known-good
snapshots and task-scheduler registrations are excluded.

| Source | Responsibility |
|---|---|
| runtime/native_dsh | Native composition, Session bridge and compaction |
| native_dsh/digital-life | Life state, attention, continuation and advisor |
| native_dsh/capabilities | Reviewed profiles and isolated workers |
| native_dsh/private-vault | Encryption and private-result projection |
| workspace_foundation | Native file policy, operation locks and versions |
| long_term_memory | Authorship, source adapters and retrieval |
| budget_guard / time_host | Budget authority and native scheduling |
| browser / bluesky / xiaohongshu | Optional external adapters |
| dots_bridge | Experimental external research bridge |
| self_maintenance | Current-byte checkpoint/seal/accept/rollback |
| tools/web-search | Research source adapters and full-text pagination |
