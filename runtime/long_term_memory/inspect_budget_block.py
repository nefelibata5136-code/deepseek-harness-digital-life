"""Read-only diagnosis of a provider-bound stop; never clears budget controls."""
import sqlite3
import json
from pathlib import Path
base=Path(__file__).resolve().parents[2]
c=sqlite3.connect((base/'runtime/budget_guard/control/budget.sqlite3').as_uri()+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
print(json.dumps({'meta': [dict(r) for r in c.execute('select * from meta')],
                 'recent_attempts':[dict(r) for r in c.execute('select * from attempts order by rowid desc limit 3')]},ensure_ascii=False,indent=2))
