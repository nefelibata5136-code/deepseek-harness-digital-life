"""Acceptance under Persona's real restricted Windows terminal, not admin Node.
No real model, browser, desktop input or Host restart. Fixture evidence is retained.
"""
import json
from pathlib import Path
import os
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from windows_terminal import run
BASE=Path(__file__).resolve().parents[2]
WORKSPACE=Path(os.environ.get('DL_WORKSPACE', '.local/workspace'))
results=[]
for file in ['tools/self-maintenance/verify-change.mjs','tools/web-search/verify.mjs','tools/self-maintenance/simulate.mjs']:
    output=run('node --preserve-symlinks-main --preserve-symlinks "'+str(WORKSPACE/file)+'"',WORKSPACE,120)
    if output.get('returncode') != 0:
        print(json.dumps({'passed':False,'file':file,'result':output},ensure_ascii=False));raise SystemExit(1)
    value=json.loads(output['stdout'])
    if not(value.get('ok') or value.get('passed')):raise RuntimeError('Acceptance failed')
    results.append({'file':file,'restricted':output.get('restricted'),'integrity':output.get('integrity_level'),'result':value})
evidence={'passed':True,'modelCalls':0,'results':results}
target=BASE/'reports/self-maintenance/terminal-validation.json'
target.parent.mkdir(parents=True,exist_ok=True)
target.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(evidence,ensure_ascii=False))
