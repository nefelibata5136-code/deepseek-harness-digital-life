"""Bind passing native digital-life evidence to the existing readiness gate.

Read-only by default. Refuse unrelated source drift; --apply preserves the old
proof and adds current validated sources instead of relaxing the startup gate.
"""
import argparse
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).resolve().parents[3]
def digest(name):
    return hashlib.sha256((BASE / name).read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    path = BASE / 'reports/task_A/readiness.json'
    original = path.read_bytes()
    proof = json.loads(original)
    runtime = json.loads((BASE / 'reports/digital-life/runtime-validation.json').read_text('utf-8'))
    codex = json.loads((BASE / 'reports/digital-life/codex-policy-offline.json').read_text('utf-8'))
    assert proof['passed'] and runtime['passed'] and codex['ok']
    verified = dict(runtime['sourceSha256']) | dict(codex['sourceSha256'])
    for name, expected in verified.items():
        assert digest(name) == expected, 'Validation source drift: ' + name
    changed = [name for name, expected in proof['source_sha256'].items() if digest(name) != expected]
    assert all(name in verified for name in changed), 'Unverified unrelated drift: ' + repr(changed)
    for evidence in ['channel_validation.json', 'integrated_validation.json', 'parallel-validation.json']:
        assert json.loads((BASE / 'reports/task_A' / evidence).read_text('utf-8'))['passed']
    proof['source_sha256'].update(verified)
    proof['digital_life_validation'] = {
        'observedAt': runtime['observedAt'],
        'evidence': ['reports/digital-life/runtime-validation.json', 'reports/digital-life/codex-policy-offline.json'],
        'changedReviewedSources': changed,
    }
    if args.apply:
        backup = BASE / 'reports/digital-life/readiness-before.json'
        if not backup.exists():
            backup.write_bytes(original)
        staged = path.with_suffix('.digital-life.tmp')
        staged.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        staged.replace(path)
    print(json.dumps({'passed': True, 'applied': args.apply, 'changedReviewedSources': changed,
                      'validatedSources': len(verified)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
