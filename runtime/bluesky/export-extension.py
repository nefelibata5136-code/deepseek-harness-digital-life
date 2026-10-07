"""Local evidence export through the existing persona.native_dsh projection."""
import datetime as dt
import importlib.util
import json
from pathlib import Path

base = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native_export', base / 'runtime/export_records.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
acceptance = json.loads((base / 'reports/bluesky/extension-acceptance.json').read_text(encoding='utf-8'))
sources = [(Path(acceptance['nativeSource']), acceptance['firstSeq'])]
sources += [(Path(child['source']), 0) for child in acceptance['childBatches']]
snapshots = [(path, minimum, [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()])
             for path, minimum in sources]

def project(observed):
    return [record for path, minimum, rows in snapshots for record in module.project(path, rows, observed)
            if record['event_type'] in ('tool/call', 'tool/result') and record['original_location']['seq'] >= minimum]

records = project(dt.datetime.now(dt.timezone.utc).isoformat())
again = project(dt.datetime.now(dt.timezone.utc).isoformat())
assert [r['version_id'] for r in records] == [r['version_id'] for r in again]
assert len({r['record_id'] for r in records}) == len(records)
output = base / 'reports/bluesky/extension-records.local.jsonl'
output.write_text(''.join(module.canonical(record) + '\n' for record in records), encoding='utf-8')
summary = {'source': 'persona.native_dsh', 'records': len(records), 'sessions': len(snapshots),
           'local_saved': True, 'local_exported': True, 'repeat_no_new_versions': True,
           'github_published': False, 'dots_read_verified': False,
           'output': str(output), 'scope': 'Whole tool metadata records, hashes and native evidence location; no arguments, result bodies, hidden reasoning or private messages.'}
(base / 'reports/bluesky/extension-export-check.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False))
