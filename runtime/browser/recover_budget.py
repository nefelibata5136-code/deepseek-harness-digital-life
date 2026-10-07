"""One specifically user-authorized conservative recovery. Never guesses usage."""
import json
from pathlib import Path
import sys
BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(BASE/'runtime/budget_guard'))
from authority import Authority
attempt='f0a540d4-0a85-5c0b-90eb-15b590d624fe'
a=Authority()
with a.connect(readonly=True) as c:
    row=dict(c.execute('SELECT * FROM attempts WHERE attempt_id=?',(attempt,)).fetchone())
if row['state']=='accounted_upper':
    receipt={'already_accounted_upper':True,'attempt_id':attempt,'charged':row['charged'],'actual_usage_known':False}
else:
    receipt=a.account_upper({'attempt_id':attempt,'expected_reserved':2228224000,
        'confirm_full_reservation_charge':True})
receipt['user_confirmation']='User explicitly confirmed full CNY 2.228224 upper charge in this browser integration chat.'
receipt['status']=a.status()
path=BASE/'reports/browser/budget-recovery.json';path.parent.mkdir(parents=True,exist_ok=True)
path.write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(receipt,ensure_ascii=False))
