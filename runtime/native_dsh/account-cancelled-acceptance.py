"""Account only the cancelled acceptance request at its entire retained maximum."""
import json
import sys
from datetime import datetime
from pathlib import Path

base = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(base / 'runtime/budget_guard'))
from authority import Authority

report = base / 'reports/windows_computer'
submitted = json.loads((report / 'submitted-task.json').read_text(encoding='utf8'))
authority = Authority()
with authority.connect(readonly=True) as con:
    candidates = con.execute("SELECT attempt_id,reserved,started_at FROM attempts WHERE session_id=? AND state='unknown'",
                             (submitted['sessionId'],)).fetchall()
    rows = [r for r in candidates if datetime.fromisoformat(r['started_at']) >= datetime.fromisoformat(submitted['submittedAt'].replace('Z','+00:00'))]
if len(rows) != 1:
    raise RuntimeError('Expected exactly one unknown request belonging to this cancelled acceptance')
row = rows[0]
receipt = authority.account_upper({'attempt_id':row['attempt_id'], 'expected_reserved':row['reserved'],
                                  'confirm_full_reservation_charge': True})
(report / 'cancelled-budget-upper.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(receipt))
