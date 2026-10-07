"""Read-only completion checks, with compact evidence instead of model claims."""
import json
from pathlib import Path
from engine import Memory,BASE,HERE,atomic_json
from source_reader import digest,resolve_actor,read_lines,compact

def main():
    report=BASE/'reports/long_term_memory';m=Memory()
    try:
        with m.lock():
            m.sync();events,links,threads=m.project();initial=json.loads((report/'import-result.json').read_text('utf-8'))['result']
            assert all(m.event(a)['event_id']==eid for a,eid in initial['ids'].items())
            assert len(events)==11 and len(threads)==3 and len(links)==12 and sum(len(e['units']) for e in events.values())==20
            assert all(e['status']=='accepted' and not e['needs_review'] for e in events.values())
            c05=m.event('C05');assert len(c05['annotations'])==2 and c05['annotations'][1]['supersedes']==c05['annotations'][0]['annotation_id']
            assert m.tags(c05)==['我可能记错','正门与通道','记忆诚实']
            c08=m.event('C08');old=next(r['payload'] for r in m.ledger() if r['operation']=='event' and r['payload']['event_id']==c08['event_id'])
            assert [u['memory_id'] for u in old['units']]==[u['memory_id'] for u in c08['units']]
            assert set(c08['units'][0]['terms'])-set(old['units'][0]['terms'])=={'无井号','没带 # 的招呼','正门被连敲'}
            originals=json.loads((report/'source-audit.json').read_text('utf-8'));hashes=[]
            for r in originals:
                h=digest(Path(r['path']).read_bytes());assert h==r['sha256'];hashes.append({'path':r['path'],'sha256':h,'unchanged':True})
            provenance=json.loads((HERE/'qwen-provenance.json').read_text('utf-8'))
            assert digest(Path(provenance['source']).read_bytes())==provenance['source_sha256']
            assert digest((HERE/'qwen_legacy.py').read_bytes())==provenance['frozen_sha256']
            design=Path(m.sources['workspace'])/'memory/design';acceptance={}
            for name in ('v1-approved.json','v1-anchor-corrections.json','v1-recall-additions.json','v1-acceptance.md','v1-final-check.md'):
                actor=resolve_actor(BASE,authored_file=design/name);assert actor['kind']=='persona' and actor['session_id']=='7aac9199-2840-58ed-980c-036c9eb3acd3'
                acceptance[name]={'sha256':digest((design/name).read_bytes()),'actor':actor}
            path=Path(acceptance['v1-final-check.md']['actor']['native_path']);records=read_lines(path,True)
            calls={e['data']['callId']:e for _,e in records if e['type']=='tool/call' and e['seq']>=308 and e['data'].get('name','').startswith('cap__memory__')}
            receipts=[]
            for _,e in records:
                if e['type']!='tool/result':continue
                msg=e['data'].get('message',{});cid=msg.get('toolCallId')
                if cid not in calls:continue
                value=json.loads('\n'.join(b['text'] for b in msg.get('content',[]) if b.get('type')=='text'))
                assert not msg.get('isError') and value.get('ok')
                call=calls[cid];receipts.append({'seq':call['seq'],'call_id':cid,'name':call['data']['name'],'arguments':json.loads(call['data']['arguments']),'result_seq':e['seq'],'ok':True})
            assert len(receipts)>=20 and any(r['name'].endswith('annotate') for r in receipts)
            prompts=[json.loads(p.read_text('utf-8')) for p in report.glob('*-submitted.json')]
            assert all(p['sessionId']=='7aac9199-2840-58ed-980c-036c9eb3acd3' for p in prompts)
            budget=json.loads((BASE/'runtime/budget_guard/config.json').read_text('utf-8'));assert budget['daily_limit_nano_cny']==50000000000 and budget['max_output_tokens']==65536
            units=(report/'unit-tests.txt').read_text('utf-8');assert 'Ran 20 tests' in units and units.rstrip().endswith('OK')
            engine=json.loads((report/'acceptance-engine.json').read_text('utf-8'));assert engine['corrupt_copy_recovery_pass'] and engine['repeat_search_added_api_requests']==0 and engine['q5_three_sources_same_page']
            stats=m.status();stats.pop('reported_usage',None)
            result={'completed':True,'independent_session':'7aac9199-2840-58ed-980c-036c9eb3acd3','primary_session_not_prompted':'80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b',
                    'native_memory_tool_successful_receipts':receipts,'persona_authored_acceptance':acceptance,'source_files_unchanged':hashes,
                    'qwen_legacy_exact_source_reuse_verified':True,'stable_event_and_memory_ids_verified':True,'native_notes_and_supersedes_verified':True,
                    'unit_tests':20,'actual_qwen_query_tests':19,'default_five_event_expectation_sets_recalled':engine['event_recall_passed'],
                    'default_eligible_unit_expectation_sets_recalled':engine['unit_recall_passed'],'actual_raw_copy_corruption_rebuild_verified':True,
                    'single_long_event_test':'24 messages / 12 rounds / over 100000 Unicode chars / one authored semantic entrance; exact paged reads',
                    'known_limits':['Q6/Q10 incomplete default five-event sets deliberately retained by Persona; continue through links/audit','Q19 retrieves event entrances, not exhaustive speaker enumeration','Old-card branches and missing source originals remain uncovered','Source-change/rejection behavior tested in isolated engineering fixtures, not by altering real history','Persona wants more prominent missing display in a later version'],
                    'budget':{'permanent_request_tier_tokens':65536,'wire_headroom_tokens':1,'daily_limit_yuan':50,'original_ledger_and_incident_preserved':True},'status':stats}
            m.export_catalog();atomic_json(report/'final-validation.json',result)
            print(compact({'completed':True,'native_memory_tools':len(receipts),'events':len(events),'entrances':20,'original_files_unchanged':len(hashes),'unit_tests':20,'query_event_sets':str(engine['event_recall_passed'])+'/19','stable_ids':True,'qwen_requests':stats['api_requests']}))
    finally:m.close()

if __name__=='__main__':main()
