"""Bind only two validated workspace-version sources to the existing Host gate.
Read-only by default; --apply preserves old proof. Never edits source or restarts Host.
"""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import uuid
BASE=Path(__file__).resolve().parents[2]
ALLOWED={'runtime/workspace_foundation/lifecycle.mjs','runtime/workspace_foundation/file-operation-locks.mjs'}
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    path=BASE/'reports/task_A/readiness.json';original=path.read_bytes();proof=json.loads(original)
    assert proof['passed'] is True
    parallel=json.loads((BASE/'reports/task_A/parallel-validation.json').read_text('utf-8'))
    assert parallel['passed'] and parallel['paidModelCalls']==0
    for name,expected in parallel['sourceSha256'].items():
        assert digest(BASE/name)==expected,'Validation source drift: '+name
    for name,script in [('per-file-lock-validation.json','verify-per-file-locks.mjs'),('file-cancel-validation.json','verify-file-cancellation.mjs')]:
        result=json.loads((BASE/'reports/task_A'/name).read_text('utf-8'))
        assert result['passed'] and result['paidModelCalls']==0
        time=datetime.fromisoformat(result['observedAt'].replace('Z','+00:00')).timestamp()
        for source in [*ALLOWED,'runtime/native_dsh/'+script]:
            assert (BASE/source).stat().st_mtime<=time,'Re-run current validation: '+source
    changed={name for name,expected in proof['source_sha256'].items() if digest(BASE/name)!=expected}
    assert changed<=ALLOWED,'Unrelated source drift retained: '+repr(sorted(changed-ALLOWED))
    assert ALLOWED<=parallel['sourceSha256'].keys()
    result={'passed':True,'applied':args.apply,'changed':sorted(changed),'evidence':'reports/task_A/parallel-validation.json'}
    if args.apply and changed:
        backup=BASE/'reports/self-maintenance/pre-change'/('readiness-'+hashlib.sha256(original).hexdigest()+'.json')
        if not backup.exists():backup.write_bytes(original)
        for name in changed:proof['source_sha256'][name]=parallel['sourceSha256'][name]
        proof['self_maintenance_parallel_release']=result
        assert path.read_bytes()==original,'Readiness changed concurrently; retry'
        for name,expected in parallel['sourceSha256'].items():assert digest(BASE/name)==expected,'Source changed concurrently'
        temporary=path.with_name('readiness-'+uuid.uuid4().hex+'.tmp')
        temporary.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        assert path.read_bytes()==original,'Readiness changed concurrently; keep candidate'
        temporary.replace(path)
    target=BASE/'reports/self-maintenance/parallel-release.json'
    target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
