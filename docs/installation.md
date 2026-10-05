# Installation

Core: Windows 10/11, Node.js 24+, Python 3.12+, Git.

~~~powershell
npm --prefix runtime/native_dsh ci --no-audit --no-fund
python -m pip install -r requirements.txt
npm run setup
npm test
npm run smoke
~~~

Setup generates ignored profile/paths. Rerunning it regenerates profile defaults;
the primary Session UUID in .local/runtime.json is retained. Keep identity and
associated stores together. Write your own .local/workspace/persona-core.md.
Supply DEEPSEEK_API_KEY through a secret manager/process environment.
DL_PYTHON selects an interpreter. Start launches the authenticated loopback Host;
control status is read-only, prompt can cause paid calls/actions.
Review budget_guard/config.json pricing/expiry before paid use.

## Optional modules

Memory: engine/synthetic tests are offline. Semantic search requires requests,
your reviewed provider workspace ID and DL_QWEN_API_KEY through the credential
broker. Configure memory config/sources locally; the public source list is empty.
The private migration importer refuses to run. Register optional memory bundle
through capabilities/Plugin Manager; install disabled, inspect/accept exact hash,
then enable. examples/hello provides a simple non-network bundle.

Browser: install runtime/browser/requirements.txt in an isolated environment,
configure Chrome executable/private root/profile and generated MCP row. Use a
dedicated profile. Human login/CAPTCHA/risk handling stays human. Restore is unaccepted.
Computer Use uses the pinned DSH Windows provider and shares the desktop. Review
permissions before enabling. Fresh snapshots precede element indexes; offline
tests never send real desktop input.

Bluesky: your DL_BLUESKY_HANDLE and DL_BLUESKY_DID plus broker reference
DL_BLUESKY_APP_PASSWORD are needed. Placeholder account cannot log in. Register
bundle separately and review write authority. XHS: install its requirements,
configure adapter and dedicated browser; public social operations are read-only.
Optional private AI/OCR have extra setup/cost/privacy limits.

Codex advisor: fresh separate login/config home, read-only one-shot. No existing
authentication is distributed. Dots/Slack: bundle contains protocol/task fixtures;
complete genuine round trip remains unaccepted. Supply private channel/member
configuration locally; sender modes do not themselves authorize speaking as you.

Desktop patch: inspect against an isolated upstream checkout and run git apply
--check before building. Patch vendor snapshot differs from installed DSH packages.
No installed binary/profile is shipped. Upstream build/packaging notices still apply.
