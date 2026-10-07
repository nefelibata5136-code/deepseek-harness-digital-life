"""Verify the registered unified-export adapter using only memory action rows."""
import importlib.util
import json
import sys
from pathlib import Path
from engine import BASE,atomic_json

root=Path('.local/unconfigured/local-study-export')
sys.path.insert(0,str(root))
s=importlib.util.spec_from_file_location('unified_local_export',root/'export_local.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
from persona_memory_adapter import collect,SOURCE
out=root/'output/.private/persona-memory-local'
out.mkdir(parents=True,exist_ok=True)
ledger=m.Ledger(out/'evidence.sqlite3');coverage=[]
collect(ledger,coverage,m.make,m.canonical);first=ledger.added
collect(ledger,coverage,m.make,m.canonical);second=ledger.added-first
assert second==0
records=ledger.current_rows()
path=out/'action-metadata.jsonl';m.atomic(path,''.join(m.canonical(r)+'\n' for r in records));ledger.c.close()
result={'source':SOURCE,'registered_adapter':str(root/'persona_memory_adapter.py'),'existing_export_entry':str(root/'export_local.py'),
        'local_saved':True,'local_exported':True,'export_path':str(path),'records':len(records),'first_new_observations':first,'repeat_new_observations':second,
        'private_text_exported':False,'github_published':False,'dots_read_verified':False,'coverage':coverage}
atomic_json(BASE/'reports/long_term_memory/local-export-validation.json',result)
print(json.dumps(result,ensure_ascii=False))
