"""Refresh only verified compaction composition hashes; preview unless --apply."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

base = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
path = base / 'reports/task_A/readiness.json'
proof = json.loads(path.read_text(encoding='utf-8'))
reports = [base / 'reports/task_A/integrated_validation.json',
           base / 'reports/task_A/channel_validation.json']
offline = sorted((base / 'reports/compaction').glob('offline-*/validation.json'), key=lambda p: p.stat().st_mtime)[-1]
reports.append(offline)
for report in reports:
    result = json.loads(report.read_text(encoding='utf-8'))
    if result.get('passed') is not True:
        raise RuntimeError(f'Validation did not pass: {report.name}')
tested = json.loads(offline.read_text(encoding='utf-8'))
if tested.get('source_hashes_unchanged') is not True:
    raise RuntimeError('Compaction evidence has no stable source hash binding')
for name, expected in tested['sourceSha256'].items():
    if hashlib.sha256(Path(name).read_bytes()).hexdigest() != expected:
        raise RuntimeError('Tested compaction source changed: ' + name)
changed = ['runtime/native_dsh/boot-native.mjs', 'runtime/native_dsh/persona-plugin.mjs',
           'runtime/native_dsh/home/profiles/persona/cordis.patch.yml',
           ]
host_name = 'runtime/native_dsh/native-host.mjs'
channel = json.loads(reports[1].read_text(encoding='utf-8'))
channel_time = datetime.fromisoformat(channel['observed_at'].replace('Z', '+00:00')).timestamp()
if hashlib.sha256((base / host_name).read_bytes()).hexdigest() != proof['source_sha256'][host_name]:
    if (base / host_name).stat().st_mtime > channel_time:
        raise RuntimeError('Host changed after authenticated channel/cold recovery validation')
    changed.append(host_name)
new = ['runtime/native_dsh/persona-compaction.mjs', 'runtime/native_dsh/verify-compaction.mjs']
# A shared desktop-only source can change during this task. Accept its existing
# owner's completed visual proof only when the tested source predates the proof.
# A later edit still blocks the protected preflight; never blanket-refresh it.
overlay_name = 'runtime/native_dsh/desktop-overlay.py'
if overlay_name in proof['source_sha256'] and hashlib.sha256((base / overlay_name).read_bytes()).hexdigest() != proof['source_sha256'][overlay_name]:
    overlay_path = base / 'reports/windows_computer/overlay-validation.json'
    overlay = json.loads(overlay_path.read_text(encoding='utf-8'))
    overlay_time = datetime.fromisoformat(overlay['observedAt'].replace('Z', '+00:00')).timestamp()
    if overlay.get('passed') is not True or not all(overlay.get(name) is True for name in
            ['foregroundPreserved', 'mouseHitTestingPassesThrough', 'captureAffinityVerified', 'hiddenAfterStop']):
        raise RuntimeError('Shared desktop overlay has no completed visual validation')
    if (base / overlay_name).stat().st_mtime > overlay_time:
        raise RuntimeError('Shared desktop overlay changed after its visual validation')
    changed.append(overlay_name)
    reports.append(overlay_path)
updated = {name: hashlib.sha256((base / name).read_bytes()).hexdigest() for name in changed + new}
unrelated = [name for name, expected in proof['source_sha256'].items()
             if name not in changed + new and hashlib.sha256((base / name).read_bytes()).hexdigest() != expected]
if unrelated:
    raise RuntimeError('Other unvalidated sources changed: ' + ', '.join(unrelated))
if args.apply:
    backup = base / 'reports/compaction/rollback/readiness.before.json'
    if not backup.exists():
        backup.write_bytes(path.read_bytes())
    proof['source_sha256'].update(updated)
    proof['compaction_validation'] = {
        'observed_at': datetime.now(timezone.utc).isoformat(),
        'evidence': [str(report.relative_to(base)).replace('\\', '/') for report in reports],
        'note': 'Native integration and authenticated channel/cold recovery revalidated; compaction checks use fixture transport.'}
    temporary = path.with_suffix('.compaction.tmp')
    temporary.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)
print(json.dumps({'applied': args.apply, 'sources': list(updated), 'evidence': [str(r) for r in reports]}, ensure_ascii=False))
