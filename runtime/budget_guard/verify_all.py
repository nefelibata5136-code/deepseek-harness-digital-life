"""Reproducible keyless acceptance; saves logs/hashes under reports/task_D."""
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

HERE=Path(__file__).resolve().parent
REPORT=HERE.parents[1]/'reports/task_D'

def main():
    REPORT.mkdir(parents=True,exist_ok=True)
    env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'}}
    env.update(PYTHONIOENCODING='utf-8',PYTHONDONTWRITEBYTECODE='1',BUDGET_TEST_PYTHON=sys.executable)
    suites=[('authority',[sys.executable,str(HERE/'test_authority.py')]),
            ('provider_gate',['node','--test',str(HERE/'test_provider_gate.mjs')]),
            ('write_protection',[sys.executable,str(HERE/'verify_protection.py')])]
    results=[]
    for name,command in suites:
        run=subprocess.run(command,cwd=HERE,env=env,capture_output=True,text=True,encoding='utf-8',timeout=60)
        log=run.stdout+'\n'+run.stderr
        (REPORT/(name+'.log')).write_text(log,encoding='utf-8')
        results.append({'suite':name,'returncode':run.returncode,'log':name+'.log'})
        print(name+': '+('PASS' if run.returncode==0 else 'FAIL'))
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in HERE.iterdir() if p.is_file()}
    evidence={'verified_at':datetime.now(timezone(timedelta(hours=8))).isoformat(),
        'suites':results,'source_sha256':hashes,'paid_model_calls':0,'formal_persona_started':False,
        'production_integrated':False,'ledger_scope':'temporary test ledgers only; existing production usage files untouched',
        'claim':'budget component and installed adapter verified offline; A must integrate formal entry/composition'}
    (REPORT/'validation.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    if any(r['returncode'] for r in results):sys.exit(1)

if __name__=='__main__':main()
