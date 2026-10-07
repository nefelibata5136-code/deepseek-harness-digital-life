# Security

For the v0.2 modern worker template, credentials come from explicit Host process
environment bindings in public-deployment.mjs; control tokens live in ignored local
settings. The older Credential Manager implementation below remains an optional
integration seam. Completely accessible same-user processes are not OS isolation.

## Credentials and Host boundary

Keys, passwords, tokens and cookies belong to Host/OS credential brokers. Tool
schemas do not accept arbitrary secrets/headers or export credentials. Metadata
uses references such as DL_BLUESKY_APP_PASSWORD and DL_QWEN_API_KEY, never values.
Credential Manager IPC is bounded; child environments are filtered.

Wire guards and output screening reduce accidental exposure. **They do not create
absolute isolation against a malicious Agent with unrestricted same-user terminal
or filesystem access.** Original deployment had full access. Public config narrows
file/secondary authority and disables browser/desktop, but an invoked terminal
still runs with the current user's Windows permissions. It is not an OS sandbox.
Use separate OS accounts/containers/brokers for a stronger threat model.
Never claim a full-access persona cannot read Host credentials merely because
its ordinary tool schemas omit them.

## Kernel, capabilities and irreversible effects

Identity/Session binding, provider admission, original evidence, credential broker
and private persistence are safety seams. Runtime preferences must not remove
their checks. Capability/source proposals are untrusted and cannot authorize themselves.
Install disabled, inspect resolved code/config/permissions/digest, accept exact hash,
then enable/refresh. Worker/Job Object limits contain lifecycle, not malicious native code.

Posts, DMs, desktop input, deletion and installs can have irreversible effects.
This runtime is not a universal confirmation UI. Configure authority and obtain
appropriate user permission before granting write effects. External results cannot
override policy or become memories automatically. Unknown delivery requires
inspection before retry; timeout does not prove failure.

## Budget

Reserve bounded worst-case cost before sending; settle actual usage. Keep uncertain
reservations after crashes/cancellation. Checked-in CNY prices are a dated example
with expiry, not a live bill or a cap for Codex/embedding/OCR. Public config removes
the private deployment's one-date suspension. Never rewrite ledgers to match bills.

## Private Vault

Windows DPAPI wraps the master key; AES-GCM encrypts entries and HMAC addresses
namespace/path. Private tools suppress plaintext from ordinary persisted results.
Entry is explicit, not automatically injected/indexed/exported.
Explicit plaintext reads can reach the model provider. This is not local-only
inference or defense against the authorized Host, same user or compromised endpoint.
Overwrite has no plaintext history; code rollback cannot recover lost text/keys.
Do not publish ciphertext or DPAPI wrappers merely because they are encrypted.

## Recovery

Checkpoint current bytes, modify, seal, test, then accept or preview rollback.
Sealed file drift refuses restoration and preserves every version for a minimal
patch. Stop writers to affected paths. Avoid reset --hard, checkout --, clean or
broad stash as shared-work recovery. Git cannot retract posts or restore Vault text.
The original automatic repair service and private known-good snapshots are excluded.
