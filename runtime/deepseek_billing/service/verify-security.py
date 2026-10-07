"""Read-only exact-secret scan in Host memory; reports names/counts, never values."""
import importlib.util,json
from pathlib import Path
HERE=Path(__file__).resolve().parent
RUNTIME=HERE.parents[1]
spec=importlib.util.spec_from_file_location('broker',RUNTIME/'native_dsh/capabilities/credentials.py')
broker=importlib.util.module_from_spec(spec);spec.loader.exec_module(broker)
refs=['DL_LIFE_DEEPSEEK_43A0232A_0475_4FD1_8D99_64E88666CCAA','DL_LIFE_DEEPSEEK_E689278F_123B_44B0_AF99_D4CA2C1E7B8B','DL_DEEPSEEK_PLATFORM_TOKEN']
secrets=[]
for ref in refs:
    try:secrets.append(broker.operation('resolve',ref)['value'].encode())
    except Exception:pass
report=RUNTIME.parent/'reports/deepseek-billing-repair-20261007'
targets=[RUNTIME/'deepseek_billing',report,RUNTIME/'multi_life_supervisor/supervisor/deepseek-billing']
leaks=[];count=0
for root in targets:
    for path in root.rglob('*'):
        if not path.is_file() or path.suffix in ['.png','.pyc'] or path.name=='.verify-auth.json':continue
        data=path.read_bytes();count+=1
        if any(secret and secret in data for secret in secrets):leaks.append(str(path.relative_to(RUNTIME.parent)))
result={'credentials_checked':len(secrets),'files_checked':count,'raw_credential_matches':len(leaks),'files_with_matches':leaks,'scope':'billing source, production billing cache, acceptance artifacts; exact Host credential values compared only in memory'}
(report/'security-validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
raise SystemExit(bool(leaks))
