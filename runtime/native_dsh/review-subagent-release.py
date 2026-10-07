"""Refresh only the five subagent composition hashes, backed by an offline boot check."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

base = Path(__file__).resolve().parents[2]
report = base / 'reports/subagents'
path = base / 'reports/task_A/readiness.json'
proof = json.loads(path.read_text(encoding='utf8'))
checked = json.loads((report / 'composition.json').read_text(encoding='utf8'))
allowed = {'runtime/native_dsh/home/profiles/persona/cordis.patch.yml',
           'runtime/native_dsh/home/profiles/persona/package.json',
           'runtime/native_dsh/persona-plugin.mjs',
           'runtime/native_dsh/package.json', 'runtime/native_dsh/package-lock.json'}
if not checked['passed'] or set(checked['sourceSha256']) != allowed:
    raise RuntimeError('Missing targeted composition proof')
for name, digest in checked['sourceSha256'].items():
    if hashlib.sha256((base / name).read_bytes()).hexdigest() != digest:
        raise RuntimeError('Composition changed after check: ' + name)
changed = {name for name, digest in proof['source_sha256'].items()
           if hashlib.sha256((base / name).read_bytes()).hexdigest() != digest}
if changed - allowed:
    raise RuntimeError('Unrelated unreviewed changes: ' + str(changed - allowed))
backup = report / 'rollback/readiness.before.json'
if not backup.exists():
    backup.write_bytes(path.read_bytes())
proof['source_sha256'].update(checked['sourceSha256'])
proof['subagent_release'] = {'observedAt': datetime.now(timezone.utc).isoformat(),
                            'compositionEvidence': 'reports/subagents/composition.json',
                            'changedSources': sorted(changed),
                            'liveAcceptance': 'reports/subagents/acceptance.json'}
temporary = path.with_suffix('.subagents.tmp')
temporary.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
temporary.replace(path)
print(json.dumps(proof['subagent_release']))
