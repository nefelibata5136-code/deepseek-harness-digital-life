"""Read-only invoice estimate and per-session cache coverage, from one ledger."""
import argparse
import json
from .authority import Authority
from .pricing import cost_bounds

def aggregate(rows):
    known = [r for r in rows if r['state'] == 'settled']
    unknown = [r for r in rows if r['state'] == 'accounted_upper']
    pending = [r for r in rows if r['state'] not in ('settled', 'accounted_upper')]
    hit = sum(r['hit'] for r in known)
    miss = sum(r['miss'] for r in known)
    bounds = [cost_bounds(r) for r in known]
    return dict(known_requests=len(known), unknown_requests=len(unknown), pending_requests=len(pending),
                cache_hit_tokens=hit, cache_miss_tokens=miss, input_tokens=hit + miss,
                output_tokens=sum(r['output'] for r in known),
                cache_hit_rate=hit / (hit + miss) if hit + miss else None,
                cache_coverage_complete=not unknown and not pending,
                cost_lower_nano_cny=sum(low for low, high in bounds),
                cost_upper_nano_cny=sum(high for low, high in bounds),
                unknown_upper_nano_cny=sum(r['charged'] for r in unknown),
                pending_upper_nano_cny=sum(r['reserved'] for r in pending))

def report(authority, session_id):
    day = authority.now().date().isoformat()
    con = authority.connect(readonly=True)
    try:
        # One SQLite snapshot, unique attempt IDs; no SSE-frame or turn summation.
        rows = con.execute('SELECT * FROM attempts WHERE start_day=? OR session_id=?', (day, session_id)).fetchall()
        daily = aggregate([r for r in rows if r['start_day'] == day])
        session = aggregate([r for r in rows if r['session_id'] == session_id])
        return dict(date=day, timezone='Asia/Shanghai', daily=daily, session=session,
                    session_id=session_id, cost_kind='known_usage_price_estimate_not_account_debit',
                    day_basis='request_start_day', session_scope='all_attempts_in_this_session_including_compaction',
                    observed_at=authority.now().isoformat())
    finally:
        con.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--session-id', required=True)
    options = parser.parse_args()
    print(json.dumps(report(Authority(), options.session_id), ensure_ascii=False))
