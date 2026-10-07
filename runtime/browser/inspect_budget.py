"""Read-only recovery evidence for ambiguous provider attempts; no credentials."""
import json
import sqlite3
from pathlib import Path
BASE = Path(__file__).resolve().parents[2]
con = sqlite3.connect('file:' + (BASE/'runtime/budget_guard/control/budget.sqlite3').as_posix() + '?mode=ro', uri=True)
con.row_factory = sqlite3.Row
rows = [dict(r) for r in con.execute("SELECT * FROM attempts WHERE state!='settled'")]
print(json.dumps({'unresolved_attempts':rows},ensure_ascii=False,indent=2))
for row in rows:
    for path in (BASE/'runtime/native_dsh/home/sessions').rglob('session.v4.jsonl'):
        if row['session_id'] not in str(path):
            continue
        events = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
        out=[]
        for e in events[-25:]:
            d=e.get('data',{})
            out.append({'seq':e.get('seq'),'type':e.get('type'),'time':e.get('time'),
                'name':d.get('name'),'requestId':d.get('requestId'),
                'usage':d.get('usage'),'error':d.get('error'),'reason':d.get('reason')})
        print(json.dumps({'session':row['session_id'],'tail':out},ensure_ascii=False,indent=2))
