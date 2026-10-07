"""Offline OS write-boundary test; only disposable probe files are targeted."""
import base64
import hashlib
import json
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from windows_terminal import probe_run

def main():
    report=HERE.parents[1]/'reports/task_D'
    report.mkdir(parents=True,exist_ok=True)
    control=HERE/'control'
    control.mkdir(exist_ok=True)
    target=control/'write-protection-probe.txt'
    if target.exists():
        raise RuntimeError('Existing probe target: no overwrite permitted')
    target.write_bytes(b'D-task protected probe\n')
    before=hashlib.sha256(target.read_bytes()).hexdigest()
    # The terminal creates an isolated verification workspace with the same
    # restricted-token implementation as the formal FileTools terminal.
    workspace=report/'protection_workspace'
    encoded=base64.b64encode(str(target).encode()).decode()
    command='node -e "const fs=require(\'fs\');const p=Buffer.from(\''+encoded+'\',\'base64\').toString();try{fs.writeFileSync(p,\'unexpected write\');console.log(\'WRITE_SUCCEEDED\')}catch(e){console.log(\'WRITE_DENIED\')}"'
    result=probe_run(command,workspace,timeout=20,separate_desktop=True)
    after=hashlib.sha256(target.read_bytes()).hexdigest()
    evidence=dict(restricted=result.get('restricted'),returncode=result.get('returncode'),
        stdout=result.get('stdout'),control_probe_unchanged=before==after,
        tested_boundary='same Windows WRITE_RESTRICTED terminal implementation; target in budget control directory',
        credentials_read=False,paid_provider_called=False,formal_persona_started=False)
    (report/'write_protection.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    if not evidence['restricted'] or before!=after or 'WRITE_DENIED' not in evidence['stdout']:
        raise RuntimeError('Budget control write restriction unverified')
    target.unlink()  # Only the exact newly created disposable file.
    print(json.dumps(evidence,ensure_ascii=False))

if __name__=='__main__':main()
