"""Refresh reviewed deployment hashes after browser/native channel checks.

Preserves the preceding proof; does not disable any startup or budget gate.
"""
import hashlib
import json
import argparse
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]
REPORT = BASE / 'reports/browser'
proof_path = BASE / 'reports/task_A/readiness.json'
proof = json.loads(proof_path.read_text(encoding='utf-8'))
parser = argparse.ArgumentParser()
parser.add_argument('--browser-only',action='store_true',help='Review only browser server changes; leave concurrent sources gated')
args = parser.parse_args()
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
allowed = {'runtime/native_dsh/native-host.mjs', 'runtime/budget_guard/config.json',
           'runtime/native_dsh/home/profiles/persona/cordis.patch.yml','runtime/browser/server.py','runtime/browser/browser_control.py'}
changed = {n for n,h in proof['source_sha256'].items() if digest(BASE/n) != h}
unrelated = set()
if args.browser_only:
    unrelated = changed - {'runtime/browser/server.py','runtime/browser/browser_control.py'}
    changed &= {'runtime/browser/server.py','runtime/browser/browser_control.py'}
# Other concurrent project work is admitted only with its existing hash-bound
# offline evidence, never just because it appears in the shared working tree.
compaction = {'runtime/native_dsh/persona-compaction.mjs', 'runtime/native_dsh/verify-compaction.mjs'}
evidence = ['reports/task_A/channel_validation.json', 'reports/browser/native-image.json',
            'reports/browser/budget-tests.json']
if changed & compaction:
    latest = max((BASE/'reports/compaction').glob('offline-*/validation.json'),key=lambda p:p.stat().st_mtime)
    validation = json.loads(latest.read_text(encoding='utf-8'))
    if validation.get('passed') is not True or any(digest(Path(n)) != h for n,h in validation['sourceSha256'].items()):
        raise RuntimeError('Concurrent compaction changes lack current passing evidence')
    allowed |= compaction
    evidence.append(str(latest.relative_to(BASE)).replace('\\','/'))
if changed - allowed:
    raise RuntimeError('Unreviewed changes: '+str(changed-allowed))
channel = json.loads((BASE/evidence[0]).read_text(encoding='utf-8'))
native = json.loads((BASE/evidence[1]).read_text(encoding='utf-8'))
budget = json.loads((BASE/evidence[2]).read_text(encoding='utf-8'))
if not channel.get('passed') or not budget.get('passed') or not all(native.get(n) for n in
        ['agent_scope_has_browser','native_mcp_execute','screenshot_native_image','flash_declares_image_input']):
    raise RuntimeError('Deployment verification failed')
if budget['config_sha256'] != digest(BASE/'runtime/budget_guard/config.json'):
    raise RuntimeError('Budget configuration changed after validation')
backup = REPORT/'readiness-before-browser.json'
if not backup.exists(): backup.write_bytes(proof_path.read_bytes())
for name in changed: proof['source_sha256'][name] = digest(BASE/name)
for name in ['runtime/browser/config.json','runtime/browser/server.py','runtime/browser/browser_control.py']:
    proof['source_sha256'][name] = digest(BASE/name)
proof['browser_release'] = {'reviewed_at':datetime.now(timezone.utc).isoformat(), 'evidence':evidence,
    'changed_sources':sorted(changed), 'paid_visual_acceptance':'pending; deployment checks only',
    'concurrent_sources_left_for_their_owner':sorted(unrelated),
    'budget_change_authorized_by_user':'50 CNY/day; existing ledger preserved'}
proof_path.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(proof['browser_release'],ensure_ascii=False))
