"""Remove only B's known disposable fixture directories, preserve every evidence store."""
import argparse
import json
from pathlib import Path
import shutil
import os

HERE = Path(__file__).resolve().parent
REPORTS = HERE.parents[1] / 'reports' / 'task_B'
OWNED_FAILED_RUNS = ['acceptance-8d1a2349-5ae3-56ce-85a2-efb05f801ce0',
                     'acceptance-2d3a6a70-274d-5a17-851b-db81fdde23cb',
                     'acceptance-0939e570-c44b-5dcd-8e31-08ddeecdaf35']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    targets = [(REPORTS / name / sub, REPORTS) for name in OWNED_FAILED_RUNS
               for sub in ['native-workspace', 'readonly', 'aggregate-workspace', 'version-fixtures/workspace']]
    targets.append((HERE / '__pycache__', HERE))
    plan = []
    for target, allowed in targets:
        resolved, boundary = target.resolve(), allowed.resolve()
        if not resolved.is_relative_to(boundary) or resolved == boundary:
            raise ValueError('Target outside owned fixture boundary')
        if target.is_symlink() or os.path.isjunction(target):
            raise ValueError('Linked cleanup target denied')
        if target.exists():
            plan.append(str(resolved))
            if args.apply:
                shutil.rmtree(resolved)
    report = {'dry_run': not args.apply, 'targets': plan,
              'retained': 'All Git history, native session events, tool receipts and result files'}
    if args.apply:
        (REPORTS / 'cleanup.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
