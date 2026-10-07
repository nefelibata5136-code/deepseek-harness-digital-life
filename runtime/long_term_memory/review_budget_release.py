"""Targeted release proof. Checks passed tests before refreshing only owned hashes."""
import hashlib
import json
import subprocess
import sys
from datetime import datetime,timezone
from pathlib import Path
BASE=Path(__file__).resolve().parents[2]
allowed={'runtime/budget_guard/authority.py','runtime/budget_guard/config.json','runtime/budget_guard/provider_gate.mjs',
         'runtime/budget_guard/test_provider_gate.mjs','runtime/budget_guard/test_authority.py',
         'runtime/native_dsh/home/profiles/persona/cordis.patch.yml'}
proof_path=BASE/'reports/task_A/readiness.json'
proof=json.loads(proof_path.read_text('utf-8'))
changed={name for name,h in proof['source_sha256'].items() if hashlib.sha256((BASE/name).read_bytes()).hexdigest()!=h}
if changed-allowed:raise RuntimeError('Unrelated changes remain unvalidated: '+str(changed-allowed))
hashes={name:hashlib.sha256((BASE/name).read_bytes()).hexdigest() for name in allowed}
checks=[]
for command,cwd in [([sys.executable,'-X','utf8','-m','unittest','test_authority.py'],BASE/'runtime/budget_guard'),
                    (['node','--test',str(BASE/'runtime/budget_guard/test_provider_gate.mjs')],BASE)]:
    result=subprocess.run(command,cwd=cwd,capture_output=True,text=True,encoding='utf-8')
    checks.append({'command':command,'returncode':result.returncode,'output':result.stdout+result.stderr})
    if result.returncode:raise RuntimeError('Targeted budget tests failed: '+checks[-1]['output'])
if hashes!={name:hashlib.sha256((BASE/name).read_bytes()).hexdigest() for name in allowed}:raise RuntimeError('Sources changed while testing')
config=json.loads((BASE/'runtime/budget_guard/config.json').read_text('utf-8'))
if config['daily_limit_nano_cny']!=50000000000 or config['max_output_tokens']!=65536:raise RuntimeError('Unauthorized budget/config drift')
record={'passed':True,'observedAt':datetime.now(timezone.utc).isoformat(),'checks':checks,'sourceSha256':hashes,
        'user_authorization':'Preserve ledger/daily budget; repair +1 token incident and permanently set 64K request cap'}
out=BASE/'reports/long_term_memory/budget-validation.json'
out.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
backup=BASE/'reports/long_term_memory/budget-rollback/readiness.before.json'
if not backup.exists():backup.write_bytes(proof_path.read_bytes())
proof['source_sha256'].update(hashes)
proof['memory_task_budget_release']={'observedAt':record['observedAt'],'evidence':str(out.relative_to(BASE)),'changedSources':sorted(changed)}
tmp=proof_path.with_suffix('.memory-budget.tmp')
tmp.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');tmp.replace(proof_path)
print(json.dumps({'passed':True,'refreshed':sorted(changed),'evidence':str(out)}))
