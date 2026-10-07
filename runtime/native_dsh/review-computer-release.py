"""Refresh deployment hashes only after targeted local verification; keep the old proof."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

base = Path(__file__).resolve().parents[2]
report = base / 'reports/windows_computer'
proof = base / 'reports/task_A/readiness.json'
previous = json.loads(proof.read_text(encoding='utf8'))
allowed = {'runtime/native_dsh/boot-native.mjs', 'runtime/native_dsh/home/profiles/persona/cordis.patch.yml',
           'runtime/native_dsh/native-host.mjs', 'runtime/native_dsh/persona-plugin.mjs',
           'runtime/native_dsh/computer-host.mjs', 'runtime/native_dsh/windows-dpi.mjs',
           'runtime/native_dsh/package.json', 'runtime/native_dsh/package-lock.json'}
allowed.add('runtime/budget_guard/authority.py')
allowed.update({'runtime/native_dsh/verify-compaction.mjs', 'runtime/native_dsh/persona-compaction.mjs'})
allowed.update({'runtime/native_dsh/desktop-overlay.mjs', 'runtime/native_dsh/desktop-overlay.py'})
allowed.update({'runtime/native_dsh/verify-channel.mjs', 'runtime/native_dsh/assets/persona-desktop-overlay.png'})
allowed.add('runtime/browser/server.py')
changed = {name for name, digest in previous['source_sha256'].items()
           if hashlib.sha256((base / name).read_bytes()).hexdigest() != digest}
if changed - allowed:
    raise RuntimeError('Unreviewed composition changes: ' + str(changed - allowed))
if 'runtime/browser/server.py' in changed:
    actions = json.loads((base / 'reports/browser/local-actions.json').read_text(encoding='utf8'))
    if not all(actions.get(key) is True for key in ['navigate','type','click','scroll','nested_scroll',
                                                  'screenshot_image','screenshot_coordinate_mapping','password_page_withheld']):
        raise RuntimeError('Concurrent browser change needs passing actual local action evidence')
checks = ['task_A/channel_validation.json', 'task_A/integrated_validation.json', 'windows_computer/offline-validation.json',
          'windows_computer/budget-tests.json', 'windows_computer/overlay-validation.json', 'windows_computer/indicator-lifecycle.json']
if changed & {'runtime/native_dsh/verify-compaction.mjs', 'runtime/native_dsh/persona-compaction.mjs'}:
    latest = max((base / 'reports/compaction').glob('offline-*/validation.json'), key=lambda p:p.stat().st_mtime)
    compaction = json.loads(latest.read_text(encoding='utf8'))
    tested = compaction['sourceSha256'].get(str(base / 'runtime/native_dsh/verify-compaction.mjs'))
    if tested != hashlib.sha256((base / 'runtime/native_dsh/verify-compaction.mjs').read_bytes()).hexdigest():
        raise RuntimeError('Compaction test changed after validation')
    checks.append(str(latest.relative_to(base / 'reports')).replace('\\','/'))
for name in checks:
    result = json.loads((base / 'reports' / name).read_text(encoding='utf8'))
    if result.get('passed') is not True:
        raise RuntimeError('Verification failed: ' + name)
lifecycle = json.loads((report / 'indicator-lifecycle.json').read_text(encoding='utf8'))
for name, digest in lifecycle['sourceSha256'].items():
    if hashlib.sha256((base / 'runtime/native_dsh' / name).read_bytes()).hexdigest() != digest:
        raise RuntimeError('Desktop indicator source changed after lifecycle verification: ' + name)
snapshot = report / 'readiness-before-computer.json'
if not snapshot.exists():
    snapshot.write_bytes(proof.read_bytes())
for name in allowed:
    previous['source_sha256'][name] = hashlib.sha256((base / name).read_bytes()).hexdigest()
previous['computer_release'] = {'reviewed_at': datetime.now(timezone.utc).isoformat(), 'checks': checks,
                                'changed_reviewed_sources': sorted(changed),
                                'desktop_provider': '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.0-rc.2',
                                'paid_model_acceptance': 'reports/windows_computer/acceptance.json'}
proof.write_text(json.dumps(previous, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(json.dumps(previous['computer_release'], ensure_ascii=False))
