"""Seal only byte-matched capability evidence, preserving the existing startup gate."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
report = BASE / 'reports/capabilities'
proof_path = BASE / 'reports/task_A/readiness.json'
original = proof_path.read_bytes()
proof = json.loads(original)
validation = json.loads((report / 'validation.json').read_text(encoding='utf-8'))
if not validation.get('passed') or not validation.get('sourceHashesUnchanged'):
    raise RuntimeError('Capability validation did not pass')
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
tested = validation['sourceSha256']
if any(digest(BASE / name) != expected for name, expected in tested.items()):
    raise RuntimeError('Capability sources changed after validation')
changed = {name for name, expected in proof['source_sha256'].items() if digest(BASE / name) != expected}
if changed - tested.keys():
    raise RuntimeError('Other unvalidated source changes: ' + str(changed - tested.keys()))
evidence = ['reports/capabilities/validation.json', 'reports/task_A/integrated_validation.json',
            'reports/task_A/channel_validation.json']
for name in evidence:
    if json.loads((BASE / name).read_text(encoding='utf-8')).get('passed') is not True:
        raise RuntimeError('Deployment evidence failed: ' + name)
release = {'observedAt': datetime.now(timezone.utc).isoformat(), 'evidence': evidence,
           'checks': len(validation['checks']), 'paidModelCalls': 0, 'changedSources': sorted(changed),
           'note': 'Only reviewed capability adapter hashes added; existing credentials, budget and startup checks retained.'}
if args.apply:
    backup = report / 'readiness-before-capabilities.json'
    if not backup.exists():
        backup.write_bytes(original)
    if proof_path.read_bytes() != original:
        raise RuntimeError('Readiness proof moved concurrently; inspect and retry')
    proof['source_sha256'].update(tested)
    proof['capability_release'] = release
    temporary = proof_path.with_suffix('.capabilities.tmp')
    temporary.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(proof_path)
print(json.dumps({'applied': args.apply, **release}, ensure_ascii=False))
