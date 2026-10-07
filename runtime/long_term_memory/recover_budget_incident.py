"""Explicit user-authorized recovery of the one fully settled +1-token incident.

Never forgives unknown usage or a charge above its reservation. A native SQLite
backup and exact rows are saved before acknowledging this specific incident.
"""
import json
import sqlite3
import hashlib
from pathlib import Path
from datetime import datetime,timezone
BASE=Path(__file__).resolve().parents[2]
EXPECTED_ATTEMPT='a116c68e-9f53-5541-bf3a-52956dfb8624'
DB=BASE/'runtime/budget_guard/control/budget.sqlite3'
REPORT=BASE/'reports/long_term_memory/budget-recovery.json'
c=sqlite3.connect(DB)
c.row_factory=sqlite3.Row
backup=REPORT.with_suffix('.before.sqlite3')
if backup.exists():raise SystemExit('Recovery backup exists; inspect existing receipt, never repeat blindly')
destination=sqlite3.connect(backup)
c.backup(destination)
destination.close()
c.execute('BEGIN IMMEDIATE')
try:
    row=dict(c.execute('select * from attempts where attempt_id=?',(EXPECTED_ATTEMPT,)).fetchone())
    meta=c.execute("select value from meta where key='breach'").fetchone()
    violations=[dict(r) for r in c.execute("select attempt_id,max_tokens,output,charged,reserved,input_bound,miss,hit from attempts where state='settled' and (output>max_tokens or charged>reserved or miss+hit>input_bound)")]
    if meta is None or meta[0]!='provider_bound_violation' or len(violations)!=1 or violations[0]['attempt_id']!=EXPECTED_ATTEMPT:
        raise RuntimeError('Unexpected breach state; no recovery')
    if row['state']!='settled' or row['output']!=row['max_tokens']+1 or row['charged']>row['reserved'] or row['miss']+row['hit']>row['input_bound'] or not row['usage_json']:
        raise RuntimeError('Incident does not satisfy exact fully-accounted recovery conditions')
    if c.execute("select 1 from attempts where state in ('sent','unknown','orphaned')").fetchone():raise RuntimeError('Pending usage exists')
    receipt={'authorized_by':'User in this chat: authorize repair/recovery, preserve ledger and budget; permanent 64K cap',
      'recovered_at':datetime.now(timezone.utc).isoformat(),'attempt':row,'old_breach':meta[0],
      'ledger_backup':str(backup),'ledger_backup_sha256':hashlib.sha256(backup.read_bytes()).hexdigest(),
      'policy':'actual wire cap one token below unchanged reserved output bound; daily budget remains 50 CNY',
      'attempt_rows_changed':0,'charges_changed':False,'usage_changed':False}
    REPORT.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    c.execute('insert into meta(key,value) values(?,?)',('acknowledged_provider_incident/'+EXPECTED_ATTEMPT,json.dumps({'receipt':str(REPORT),'usage_hash':row['usage_hash']})))
    c.execute("delete from meta where key='breach'")
    c.commit()
except BaseException:
    c.rollback();raise
finally:c.close()
print(json.dumps({'recovered':True,'attempt':EXPECTED_ATTEMPT,'receipt':str(REPORT),'charges_preserved':True}))
