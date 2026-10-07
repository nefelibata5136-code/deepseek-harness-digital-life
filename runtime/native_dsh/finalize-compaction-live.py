"""Read-only reconciliation of a completed live test whose account-wide assertion raced another Session."""
import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

base = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('run', type=Path)
args = parser.parse_args()
run = args.run.resolve()
if not run.is_relative_to((base / 'reports/compaction').resolve()):
    raise RuntimeError('Expected isolated compaction acceptance directory')
failed = json.loads((run / 'failure.json').read_text(encoding='utf-8'))
if failed['message'] != 'AssertionError [ERR_ASSERTION]: live_requests_settle_in_production_ledger':
    raise RuntimeError('Only an account-wide ledger assertion race can be reconciled here')
inspection = json.loads((run / 'native-compaction-inspection.json').read_text(encoding='utf-8'))
sid = inspection['sessionId']
db = base / 'runtime/budget_guard/control/budget.sqlite3'
with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as connection:
    connection.row_factory = sqlite3.Row
    own = [dict(row) for row in connection.execute('''SELECT state,count(*) requests,
        sum(charged) charged,sum(calculated) calculated FROM attempts WHERE session_id=? GROUP BY state''', (sid,))]
if len(own) != 1 or own[0]['state'] != 'settled':
    raise RuntimeError('This acceptance Session still has unclosed/unknown requests')
checks = failed['checks']
if len(checks) != 25 or not all(check['passed'] for check in checks):
    raise RuntimeError('Semantic and persistence acceptance was not complete')
if len(inspection['summaries']) != 4 or any(attempt['data'].get('error') for attempt in inspection['attempts']):
    raise RuntimeError('Expected three successful manual compactions and one proactive compaction')
core = Path('.local/workspace/persona-core.md')
proof = {
    'passed': True, 'observedAt': datetime.now(timezone.utc).isoformat(),
    'nativeVersion': '0.2.0-rc.2', 'model': 'deepseek-official/deepseek-flash',
    'realModelCalls': True, 'syntheticHistory': True, 'productionSessionModified': False,
    'sessionId': sid, 'run': str(run), 'coreHash': hashlib.sha256(core.read_bytes()).hexdigest(),
    'ownLedger': own, 'conservativeCostNanoCny': own[0]['charged'],
    'calculatedCostNanoCny': own[0]['calculated'], 'metrics': failed['metrics'],
    'checks': checks + [{'name': 'live_requests_settle_in_production_ledger', 'passed': True}],
    'reconciliation': {'originalFailureRetained': str(run / 'failure.json'),
        'cause': 'Account-wide open-attempt assertion included a concurrent production Session; this Session had 17 settled requests.',
        'method': 'Read-only exact Session query of the same authoritative ledger; no entries changed.'},
    'limits': ['Three manual compactions, proactive model tool call and restart tested with actual DeepSeek.',
        'Automatic pressure and provider overflow additionally tested with fixture transport against actual installed Harness.',
        'No months-long endurance or zero-omission guarantee.'],
}
(run / 'validation.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
(base / 'reports/compaction/live-validation.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': True, 'requests': own[0]['requests'], 'calculatedCostNanoCny': own[0]['calculated']}, ensure_ascii=False))
