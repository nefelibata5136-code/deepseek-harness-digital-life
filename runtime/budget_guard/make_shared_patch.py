"""Read-only shared sources -> reviewable patch in task_D; never applies it."""
import difflib
from pathlib import Path

HERE=Path(__file__).resolve().parent
BASE=HERE.parents[1]
changes={
    'runtime/native_dsh/persona-plugin.mjs':[
        ("const toolNames = ['list_files', 'read', 'search_history', 'write', 'terminal'];",
         "const toolNames = ['list_files', 'read', 'search_history', 'write', 'terminal', 'budget_status'];"),
        ('  mountUsageAccounting(ctx, rpc);',
         "  // Accounting is owned exclusively by the protected Messages wire gate.\n  add('budget_status', '读取今日 token、费用预留、余额和停止原因；只读。', {}, (_args, exec) => call('budget_status', {}, exec));"),
    ],
    'runtime/native_bridge.py':[
        ('    request=json.load(sys.stdin)',
         "    request=json.load(sys.stdin)\n    if request.get('tool') == 'budget_status':\n        from budget_guard.compat import summary\n        result = summary()\n        json.dump({'result': result}, sys.stdout, ensure_ascii=False)\n        return"),
    ],
}

def main():
    chunks=[]
    for name,replacements in changes.items():
        original=(BASE/name).read_text(encoding='utf-8')
        # A may already have merged the shared plugin while D was validating.
        # Its host-components owns budget_status; never register a duplicate.
        host=BASE/'runtime/native_dsh/host-components.mjs'
        if host.exists() and "name: 'budget_status'" in host.read_text(encoding='utf-8'):
            if name.endswith('native_bridge.py'):
                continue
            if name.endswith('persona-plugin.mjs') and '  mountUsageAccounting(ctx, rpc);' not in original and "'budget_status'" in original:
                continue
        revised=original
        for old,new in replacements:
            if revised.count(old)!=1:
                raise RuntimeError('Shared source drift: A must reconcile '+name)
            revised=revised.replace(old,new)
        chunks.append('diff --git a/'+name+' b/'+name+'\n')
        chunks.extend(difflib.unified_diff(original.splitlines(keepends=True),revised.splitlines(keepends=True),
            fromfile='a/'+name,tofile='b/'+name,n=3))
    name='runtime/usage_meter.py'
    original=(BASE/name).read_text(encoding='utf-8')
    revised="\"\"\"Read-only compatibility: the protected budget authority is the only ledger.\"\"\"\nfrom budget_guard.compat import summary, budget_check, usage_start, record_usage\n\nif __name__ == '__main__':\n    import json\n    print(json.dumps(summary(), ensure_ascii=False, indent=2))\n"
    if 'from budget_guard.compat import' not in original:
        chunks.append('diff --git a/'+name+' b/'+name+'\n')
        chunks.extend(difflib.unified_diff(original.splitlines(keepends=True),revised.splitlines(keepends=True),fromfile='a/'+name,tofile='b/'+name,n=3))
    name='runtime/start_persona.py'
    original=(BASE/name).read_text(encoding='utf-8')
    old="        pending = load(BASE / 'reports/api_usage_pending.json', {})\n        session_id = record.get('native_session_id')\n        unresolved = list(pending)  # Exclusive runtime: another unknown attempt also needs inspection."
    new="        from budget_guard.authority import Authority\n        budget_final = Authority().status()\n        session_id = record.get('native_session_id')\n        unresolved = ([budget_final['stop_reason'] or 'unsettled_budget_attempts']\n                      if budget_final['open_attempts'] or budget_final['unknown_attempts'] else [])"
    if old in original:
        revised=original.replace(old,new)
        chunks.append('diff --git a/'+name+' b/'+name+'\n')
        chunks.extend(difflib.unified_diff(original.splitlines(keepends=True),revised.splitlines(keepends=True),fromfile='a/'+name,tofile='b/'+name,n=3))
    (BASE/'reports/task_D/A_INTEGRATION.patch').write_text(''.join(chunks),encoding='utf-8')
    print('Reviewable patch generated; shared files unchanged.')

if __name__=='__main__':main()
