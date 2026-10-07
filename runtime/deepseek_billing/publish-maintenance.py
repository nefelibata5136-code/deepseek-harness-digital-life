"""Narrow immutable source candidates in each owner's workspace; no runtime data."""
import hashlib,json
from pathlib import Path
HERE=Path(__file__).resolve().parent
BASE=HERE.parents[1]
registry=json.loads((BASE/'runtime/multi_life_supervisor/registry/registry.json').read_text(encoding='utf-8'))
files=[HERE/'MAINTENANCE.md',HERE/'README.md']+[p for p in (HERE/'service').iterdir() if p.suffix=='.mjs']+[HERE/'service/cache-usage.py',HERE/'service/test_cache_usage.py',HERE/'browser-poc/key-identities.json',HERE/'browser-poc/verify_cost.py',HERE/'browser-poc/test_cost.py']
hashes={str(p.relative_to(HERE)).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
generation=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()
for life in registry['lives'].values():
    root=Path(life['deployment']['workspace'])/'development/billing-maintenance'
    target=root/'source'/generation
    target.mkdir(parents=True,exist_ok=True)
    for path in files:
        out=target/path.relative_to(HERE);out.parent.mkdir(parents=True,exist_ok=True)
        if out.exists() and out.read_bytes()!=path.read_bytes():raise RuntimeError('CANDIDATE_CHANGED')
        out.write_bytes(path.read_bytes())
    (target/'manifest.json').write_text(json.dumps({'generation':generation,'official_root':'runtime/deepseek_billing','files':hashes},indent=2),encoding='utf-8')
    (root/'CURRENT.json').write_text(json.dumps({'generation':generation,'source':'source/'+generation,'purpose':'non-secret source candidate; not published Host code'},indent=2),encoding='utf-8')
    (root/'README.md').write_bytes((HERE/'MAINTENANCE.md').read_bytes())
print(json.dumps({'owners':len(registry['lives']),'generation':generation,'files':len(files),'contains_credentials':False}))
