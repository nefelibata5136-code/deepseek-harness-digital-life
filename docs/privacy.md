# Publish the system, keep the life private

This repository contains generic code and synthetic examples, no identity body,
conversations, real memory, notes, continuity/index text, Vault data, event history,
browser profiles, screenshots, auth databases or machine credentials.
The export uses an explicit code allowlist and appends to the existing public history. No original private
.git, history/snapshot objects, private recovery copies or environments were copied.
Private acceptance records were inspected locally; only bounded outcomes are reported.

Keep identity and activity under ignored .local. Generated native profiles are
under ignored runtime/native_dsh/home. The ignore policy also excludes environment
values, databases, keys, logs, JSONL, private stores, profiles, attachments and media.
Inspect the exact staged tree and history before publication: ignore rules do not
remove previously tracked files or protect other repositories.

Store secrets outside the workspace and use references. Never commit browser backup
ZIPs, screenshots, Vault ciphertext or encrypted login state. Encryption is not
permission to publish personal material.

If exporting activity records, preserve stable IDs, source, real occurrence time
(null if unknown), observation time, hash, versions/deletion markers and full evidence
pagination. Keep summaries separate. This source repo does not enable GitHub
synchronization or background personal-data exports.

If old history contained secrets/private material, do not publish it as a starting
point. Revoke/rotate exposed credentials and construct a new reviewed export.
Scan tree, index, reachable history and remote readback. Two scans cannot prove
semantic privacy; review embedded examples/prompts as well.

The audit script prints only rule/file/line, never matched values.
Synthetic-test exceptions must bind exact file/hash; no blanket test/doc exclusion.
