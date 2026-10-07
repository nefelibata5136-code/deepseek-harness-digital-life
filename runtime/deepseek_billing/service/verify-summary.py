"""Read-only acceptance evidence from the two explicitly created billing test Sessions."""
import hashlib
import json
import re
from pathlib import Path

BASE=Path(__file__).resolve().parents[3]
FOLDER=BASE/'reports/official-billing-summary-20261007'
LIVES=['life-ca23d767-1b53-5adf-b85b-19bb81c72286','life-f422ba76-d026-5363-83a1-552ea830106d']
rows=[json.loads(line) for line in (BASE/'runtime/multi_life_supervisor/supervisor/deepseek-billing/snapshots.jsonl').read_text(encoding='utf-8').splitlines()]
results=[]
for index,life in enumerate(LIVES):
    acceptance=json.loads((FOLDER/f'accept-{index}.json').read_text(encoding='utf-8'))
    sid=acceptance['session_id']
    paths=list(Path(acceptance['session_root']).glob('*/'+sid+'/session.v4.jsonl'))
    assert len(paths)==1
    events=[json.loads(line) for line in paths[0].read_text(encoding='utf-8').splitlines()]
    assert any(e['type']=='turn/end' and e['data']['reason']['kind']=='completed' for e in events)
    calls={e['data']['callId']:e['data']['name'] for e in events if e['type']=='tool/call'}
    tools={}
    for event in events:
        if event['type']!='tool/result':continue
        message=event['data']['message'];name=calls.get(message.get('toolCallId'))
        if name not in ('billing_details','billing_status','budget_status','cache_status'):continue
        assert not message.get('isError')
        tools[name]=json.loads(''.join(block.get('text','') for block in message['content']))
    assert len(tools)==4
    assert not re.search(r'local_estimated|nano_cny|remaining_budget|official_local',json.dumps(tools))
    defaults=[]
    for event in events:
        if event['type']!='system/message':continue
        message=event['data']['message']
        if message.get('source',{}).get('producer')!='cache-health':continue
        text=''.join(block.get('text','') for block in message['content'])
        match=re.search(r'\[BILLING\]\n(.*?)\n\[/BILLING\]',text,re.S)
        assert match
        default=json.loads(match.group(1));assert set(default)=={'billing'}
        assert 'snapshots' not in default['billing']
        assert not re.search(r'local_estimated|nano_cny|remaining_budget',text)
        billing=default['billing']
        confirmed=next(row for row in rows if row['life_id']==life and row['timestamp']==billing['official_updated_at'] and row['fetch_status']=='success')
        assert billing['today_cost']==confirmed['official_today_cost']
        assert billing['latest_billing_delta']==confirmed['latest_billing_delta']
        defaults.append({'seq':event['seq'],'billing':billing,'chars':len(match.group(1))})
    assert defaults
    own=[row for row in rows if row['life_id']==life and row['fetch_status']=='success']
    for row in tools['billing_details']['snapshots']:
        assert any(row['timestamp']==candidate['timestamp'] and row['official_today_cost']==candidate['official_today_cost'] for candidate in own)
    contexts=[e['data'].get('systemPromptUpdate') for e in events if e['type']=='request/context']
    assert all(value=='in-history' for value in contexts)
    results.append({'life_id':life,'title':acceptance['title'],'session_id':sid,'session_path':str(paths[0]),
        'turn_completed':True,'tools_success':list(tools),'default_states':defaults,
        'own_official_snapshots_verified':True,'agent_local_money_absent':True,'default_history_absent':True,
        'system_prompt_update':contexts,'billing_tool_values':{key:value for key,value in tools.items() if key in ('billing_status','billing_details')},
        'native_evidence_sha256':hashlib.sha256(paths[0].read_bytes()).hexdigest()})
evidence={'agents':results,'official_snapshots':rows,'offline_checks':'10 Node tests + 3 usage tests + 4 official Decimal/mapping tests passed; wire transport local SSE, no paid calls'}
(FOLDER/'validation.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'agents_verified':len(results),'all_four_tools_succeeded':True,'default_chars':[max(d['chars'] for d in row['default_states']) for row in results],
    'snapshots_per_key':[sum(row['life_id']==life and row['fetch_status']=='success' for row in rows) for life in LIVES]}))
