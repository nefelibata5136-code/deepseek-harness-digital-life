"""Refresh only this tested local Vault release in the existing readiness gate."""
import hashlib
import json
from pathlib import Path
from datetime import datetime

base = Path(__file__).resolve().parents[3]
report_dir = base / 'reports/private-vault'
validation = json.loads((report_dir / 'validation.json').read_text(encoding='utf8'))
if not validation.get('passed') or len(validation['checks']) < 25:
    raise RuntimeError('Vault native integration proof is missing')
path = base / 'reports/task_A/readiness.json'
proof = json.loads(path.read_text(encoding='utf8'))
allowed = {'runtime/native_dsh/boot-native.mjs', 'runtime/native_dsh/native-host.mjs',
           'runtime/native_dsh/persona-plugin.mjs', 'runtime/native_dsh/home/profiles/persona/cordis.patch.yml'}
allowed.update(name for name in validation['sourceSha256'] if name.startswith('runtime/native_dsh/private-vault/'))
channel_name = 'runtime/native_dsh/verify-channel.mjs'
channel_path = base / 'reports/task_A/channel_validation.json'
channel_hash = None
if channel_path.exists():
    channel = json.loads(channel_path.read_text(encoding='utf8'))
    channel_time = datetime.fromisoformat(channel['observed_at'].replace('Z', '+00:00')).timestamp()
    if channel.get('passed') and channel.get('cold_resume') and channel.get('concurrent_prompts_queued') and all(
            (base / name).stat().st_mtime <= channel_time for name in [channel_name, 'runtime/native_dsh/native-host.mjs']):
        allowed.add(channel_name)
        channel_hash = hashlib.sha256((base / channel_name).read_bytes()).hexdigest()
changed = {name for name, digest in proof['source_sha256'].items()
           if hashlib.sha256((base / name).read_bytes()).hexdigest() != digest}
# Refresh only our tested hashes. Preserve all other expected hashes unchanged:
# the main preflight continues refusing them until their owner validates them.
pending_other_changes = sorted(changed - allowed)
for name, digest in validation['sourceSha256'].items():
    if hashlib.sha256((base / name).read_bytes()).hexdigest() != digest:
        raise RuntimeError('Source changed after Vault verification: ' + name)
backup = report_dir / 'readiness.before.json'
if not backup.exists():
    backup.write_bytes(path.read_bytes())
proof['source_sha256'].update(validation['sourceSha256'])
if channel_hash:
    proof['source_sha256'][channel_name] = channel_hash
proof['private_vault_release'] = {'checkedAt': validation['checkedAt'], 'evidence': 'reports/private-vault/validation.json',
                                 'changedSources': sorted(changed & allowed), 'pendingOtherSourceChanges': pending_other_changes,
                                 'channelEvidence': 'reports/task_A/channel_validation.json' if channel_hash else None}
temporary = path.with_suffix('.vault.tmp')
temporary.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
temporary.replace(path)
print(json.dumps(proof['private_vault_release']))
