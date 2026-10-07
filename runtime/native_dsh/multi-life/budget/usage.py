"""Read-only N-ledger request usage/cache report. No credential or prompt reads."""
from pathlib import Path
import argparse
from collections import defaultdict
from datetime import datetime, timezone, timedelta
import json
import re
import sqlite3

SHANGHAI = timezone(timedelta(hours=8), 'Asia/Shanghai')

def safe_provider_id(value):
    return value if isinstance(value,str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,255}',value) and not value.lower().startswith('sk-') else None

def read_ledger(path, day=None, after=None, before=None, request_ids=None, session_ids=None):
    path=Path(path).resolve(strict=True)
    con=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=5);con.row_factory=sqlite3.Row
    try:
        con.execute('PRAGMA query_only=ON');con.execute('BEGIN')
        tables={row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        query='SELECT a.*'+(',p.life_id attributed_life_id,p.run_id attributed_run_id,p.source_kind,p.reason cost_reason,p.provenance,p.origin_room_id,p.provider,p.model,p.prompt_metadata_json' if 'request_attribution' in tables else '')
        query+=(',o.life_id owner_life_id,o.run_id owner_run_id,o.category owner_category,o.released_before_dispatch' if 'attempt_owners' in tables else '')
        query+=' FROM attempts a'
        if 'request_attribution' in tables:query+=' LEFT JOIN request_attribution p USING(attempt_id)'
        if 'attempt_owners' in tables:query+=' LEFT JOIN attempt_owners o USING(attempt_id)'
        where=[];params=[]
        if day:where.append('a.start_day=?');params.append(day)
        if after:where.append('a.started_at>=?');params.append(after)
        if before:where.append('a.started_at<?');params.append(before)
        if request_ids:
            where.append('a.request_id IN ('+','.join('?' for _ in request_ids)+')');params.extend(request_ids)
        if session_ids:
            where.append('a.session_id IN ('+','.join('?' for _ in session_ids)+')');params.extend(session_ids)
        if where:query+=' WHERE '+' AND '.join(where)
        rows=[]
        for record in con.execute(query+' ORDER BY a.started_at,a.attempt_id',params):
            row=dict(record);prices=json.loads(row['price_json']);raw=json.loads(row['usage_json']) if row['usage_json'] else {}
            life=row.get('attributed_life_id') or row.get('owner_life_id')
            reason=row.get('cost_reason') or row.get('owner_category') or 'legacy_unknown'
            complete=row['state']=='settled' and all(row[key] is not None for key in ('hit','miss','output'))
            reasoning=raw.get('reasoning_tokens',raw.get('output_tokens_details',{}).get('reasoning_tokens'))
            reasoning=reasoning if type(reasoning) is int and 0<=reasoning<= (row['output'] or 0) else None
            rows.append(dict(ledger=str(path),attempt_id=row['attempt_id'],request_id=row['request_id'],session_id=row['session_id'],
                life_id=life,run_id=row.get('attributed_run_id') or row.get('owner_run_id'),reason=reason,
                source_kind=row.get('source_kind'),origin_room_id=row.get('origin_room_id'),
                provenance=row.get('provenance') or ('legacy_owner_coarse_category' if life else 'legacy_unknown_owner_source'),
                purpose=row['purpose'],model=row.get('model') or prices.get('model'),provider=row.get('provider') or prices.get('provider'),
                started_at=row['started_at'],day=row['start_day'],state=row['state'],known_usage=complete,
                input_tokens=row['hit']+row['miss'] if complete else None,prompt_cache_hit_tokens=row['hit'] if complete else None,
                prompt_cache_miss_tokens=row['miss'] if complete else None,output_tokens=row['output'] if complete else None,
                reasoning_tokens=reasoning,reasoning_included_in_output=True,
                provider_request_id=safe_provider_id(row['provider_request_id']),
                local_estimated_cost_nano_cny=row['calculated'] if complete else None,
                reservation_upper_nano_cny=row['reserved'] if row['state'] not in ('settled','accounted_upper') else 0,
                unknown_accounted_upper_nano_cny=row['charged'] if row['state']=='accounted_upper' else 0,
                released_before_dispatch=bool(row.get('released_before_dispatch')),
                prompt_metadata=json.loads(row.get('prompt_metadata_json') or '{}')))
        return rows
    finally:con.close()

def aggregate(rows):
    known=[row for row in rows if row['known_usage']]
    hit=sum(row['prompt_cache_hit_tokens'] for row in known);miss=sum(row['prompt_cache_miss_tokens'] for row in known)
    pending=[row for row in rows if row['state'] not in ('settled','accounted_upper')]
    unknown=[row for row in rows if row['state']=='accounted_upper']
    return dict(requests=len(rows),known_requests=len(known),pending_requests=len(pending),unknown_requests=len(unknown),
        released_requests=sum(row['released_before_dispatch'] for row in rows),
        input_tokens=hit+miss,prompt_cache_hit_tokens=hit,prompt_cache_miss_tokens=miss,
        output_tokens=sum(row['output_tokens'] for row in known),
        reasoning_tokens=sum(row['reasoning_tokens'] or 0 for row in known) if any(row['reasoning_tokens'] is not None for row in known) else None,
        reasoning_coverage_requests=sum(row['reasoning_tokens'] is not None for row in known),reasoning_included_in_output=True,
        cache_hit_rate=hit/(hit+miss) if hit+miss else None,cache_coverage_complete=not pending and not unknown,
        local_estimated_cost_nano_cny=sum(row['local_estimated_cost_nano_cny'] or 0 for row in known),
        reservation_upper_nano_cny=sum(row['reservation_upper_nano_cny'] for row in rows),
        unknown_accounted_upper_nano_cny=sum(row['unknown_accounted_upper_nano_cny'] or 0 for row in rows))

def report(paths, **filters):
    paths=list(dict.fromkeys(str(Path(path).resolve(strict=True)) for path in paths));requests=[];seen={};conflicts=[]
    for path in paths:
        for row in read_ledger(path,**filters):
            old=seen.get(row['attempt_id'])
            if old:
                if {key:value for key,value in old.items() if key!='ledger'} != {key:value for key,value in row.items() if key!='ledger'}:
                    conflicts.append(dict(attempt_id=row['attempt_id'],ledgers=[old['ledger'],row['ledger']]))
                continue
            seen[row['attempt_id']]=row;requests.append(row)
    requests.sort(key=lambda row:(row['started_at'],row['attempt_id']))
    buckets=defaultdict(list);sequence_buckets=defaultdict(list);prefix_buckets=defaultdict(list);session_counts=defaultdict(int)
    for row in requests:
        key=(row['life_id'],row['model'],row['day'],row['reason']);buckets[key].append(row)
        session_counts[(row['session_id'],row['model'])]+=1
        row['session_request_index_in_window']=session_counts[(row['session_id'],row['model'])]
        position='first_in_session_window' if row['session_request_index_in_window']==1 else 'repeated_in_session_window'
        sequence_buckets[(*key,position)].append(row)
        prompt=row['prompt_metadata']
        if prompt:
            signature=tuple(prompt.get(key) for key in ['system_hash','tools_hash','first_message_hash','reasoning_effort','thinking_mode'])
            prefix_buckets[(*key,*signature)].append(row)
    groups=[dict(life_id=key[0],model=key[1],day=key[2],reason=key[3],**aggregate(rows)) for key,rows in buckets.items()]
    sequence_groups=[dict(life_id=key[0],model=key[1],day=key[2],reason=key[3],position=key[4],**aggregate(rows)) for key,rows in sequence_buckets.items()]
    prefix_groups=[dict(life_id=key[0],model=key[1],day=key[2],reason=key[3],system_hash=key[4],tools_hash=key[5],first_message_hash=key[6],
        reasoning_effort=key[7],thinking_mode=key[8],request_ids=list(dict.fromkeys(row['request_id'] for row in rows)),**aggregate(rows)) for key,rows in prefix_buckets.items()]
    return dict(observed_at=datetime.now(SHANGHAI).isoformat(),timezone='Asia/Shanghai',day_basis='request_start_day',
        cost_kind='local_known_usage_price_estimate_not_provider_debit',filters=filters,ledgers=paths,
        total=aggregate(requests),groups=groups,requests=requests,cache_by_sequence=sequence_groups,wire_prefix_groups=prefix_groups,
        sequence_scope='selected request window; first does not prove cold Provider cache',duplicate_attempt_conflicts=conflicts,
        complete=not conflicts,secret_reads=False,prompt_contents_read=False)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger',action='append',default=[])
    parser.add_argument('--root',action='append',default=[],help='One budget directory; only its immediate *.sqlite3 files')
    parser.add_argument('--day',default=datetime.now(SHANGHAI).date().isoformat())
    parser.add_argument('--after');parser.add_argument('--before');parser.add_argument('--request-id',action='append')
    parser.add_argument('--session-id',action='append')
    parser.add_argument('--output',type=Path)
    options=parser.parse_args()
    paths=options.ledger+[str(path) for root in options.root for path in sorted(Path(root).glob('*.sqlite3'))]
    if not paths:parser.error('at least one --ledger or --root is required')
    value=report(paths,day=options.day,after=options.after,before=options.before,request_ids=options.request_id,session_ids=options.session_id)
    text=json.dumps(value,ensure_ascii=False,indent=2)+'\n'
    if options.output:options.output.write_text(text,encoding='utf-8');print(json.dumps({'written':str(options.output.resolve()),'requests':value['total']['requests'],'complete':value['complete']}))
    else:print(text,end='')
    return 0 if value['complete'] else 2

if __name__=='__main__':raise SystemExit(main())
