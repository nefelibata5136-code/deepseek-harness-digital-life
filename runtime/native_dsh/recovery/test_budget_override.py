import sys,json,tempfile,os
from pathlib import Path
from datetime import datetime
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from budget_guard.authority import Authority,BudgetDenied,SHANGHAI
policy=json.loads((Path(__file__).resolve().parents[2]/'budget_guard/config.json').read_text('utf8'))
policy['daily_limit_nano_cny']=policy['warning_nano_cny']=policy['conservative_nano_cny']=1
with tempfile.TemporaryDirectory() as directory:
    a=Authority(Path(directory)/'budget.sqlite3',config=policy,now=lambda:datetime(2026,10,5,20,0,tzinfo=SHANGHAI))
    a.initialize();s=a.status();assert not s['daily_limit_enforced'] and s['stop_reason'] is None
    result=a.reserve({'attempt_id':'temporary-override-fixture','request_id':'fixture','session_id':'fixture','purpose':'fixture','payload_hash':'synthetic',
                      'provider':'deepseek-official','model':'deepseek-flash','max_tokens':256,'owner_pid':os.getpid()})
    assert result['allowed'] and a.status()['unsettled_reservations']>0
    a.now=lambda:datetime(2026,10,6,0,1,tzinfo=SHANGHAI)
    assert a.status()['daily_limit_enforced'] and a.status()['stop_reason'] is not None
print(json.dumps({'passed':True,'todaySuspended':True,'tomorrowEnforced':True,'reservationsRetained':True,'realLedgerModified':False}))
