"""Read only trusted owner usage; no credentials, prompts or database writes."""
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone

MIGRATION = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(MIGRATION/'runtime/native_dsh/multi-life/budget'))
from usage import read_ledger, aggregate

def agent_usage(rows):
    # Internal ledger estimates remain auditable, but no monetary estimate crosses the Agent interface.
    return {key:value for key,value in aggregate(rows).items() if key not in (
        'local_estimated_cost_nano_cny','reservation_upper_nano_cny','unknown_accounted_upper_nano_cny')}

def summarize(paths, life_id, session_id, now=None):
    now = now or datetime.now(timezone(timedelta(hours=8)))
    rows = {}
    for path in paths:
        for row in read_ledger(path, day=now.date().isoformat()):
            if row['life_id'] == life_id:
                if row['attempt_id'] in rows and rows[row['attempt_id']] != {**row, 'ledger':rows[row['attempt_id']]['ledger']}:
                    raise ValueError('CACHE_USAGE_CONFLICT')
                rows[row['attempt_id']] = row
    all_rows = sorted(rows.values(), key=lambda r:r['started_at'])
    own = [r for r in all_rows if r['session_id']==session_id]
    known = [r for r in own if r['known_usage']]
    recent = known[-10:]
    latest = known[-1] if known else None
    low_streak = 0
    for row in reversed(recent):
        if now-datetime.fromisoformat(row['started_at']) > timedelta(hours=1):
            break
        total = row['input_tokens']
        if total < 8192 or row['prompt_cache_hit_tokens']/total >= .1:
            break
        low_streak += 1
    anomaly = low_streak>=3
    latest_view = None if latest is None else {k:latest[k] for k in ('attempt_id','started_at','input_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','output_tokens')}
    if latest_view:
        latest_view['cache_hit_rate'] = latest['prompt_cache_hit_tokens']/latest['input_tokens'] if latest['input_tokens'] else None
    return dict(source='provider_messages_usage_local_ledger',observed_at=now.isoformat(),life_id=life_id,session_id=session_id,
        today=agent_usage(all_rows),latest_request=latest_view,recent_10_requests=agent_usage(recent),
        pending_requests=sum(r['state'] in ('reserved','sent','unknown') for r in own),
        advisory=dict(suspected_cache_anomaly=anomaly,consecutive_large_low_hit_requests=low_streak,
            rule='3 consecutive known requests in this Session within 1h, input>=8192 and cache hit rate<10%; cold starts can also match',
            recommendation='Ask another Agent or control-side maintainer for help; avoid paid self-debugging loops.' if anomaly else None,
            enforcement='display_only_no_budget_limit_no_cancellation_no_automatic_message'),
        private_prompt_read=False,credential_read=False)

def main():
    life_id,session_id=sys.argv[1:]
    registry=json.loads((MIGRATION/'runtime/multi_life_supervisor/registry/registry.json').read_text(encoding='utf-8'))
    owner=registry['sessions'].get(session_id)
    if life_id not in registry['lives'] or not owner or owner['lifeId']!=life_id:
        raise ValueError('CACHE_USAGE_TRUSTED_OWNER_REQUIRED')
    paths=[MIGRATION/'runtime/budget_guard/control/budget.sqlite3']
    for directory in [MIGRATION/'runtime/multi_life_supervisor/registry/budget',MIGRATION/'runtime/multi_life_supervisor/workers'/life_id/'registry/budget']:
        paths.extend(directory.glob('*.sqlite3'))
    print(json.dumps(summarize([p for p in paths if p.exists()],life_id,session_id)))

if __name__=='__main__':
    try:main()
    except Exception:
        print(json.dumps(dict(error='CACHE_USAGE_UNAVAILABLE')));sys.exit(1)
