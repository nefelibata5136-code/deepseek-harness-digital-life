"""Run Persona-authored queries against actual Qwen APIs and original chat."""
import json
import shutil
import tempfile
from pathlib import Path
from engine import Memory,BASE,HERE,atomic_json
from import_design import import_design
from source_reader import compact,digest

def main():
    report=BASE/'reports/long_term_memory'
    memory=Memory()
    try:
        with memory.lock():
            memory.sync()
            before=len(memory.ledger());again=import_design(memory,Path(memory.sources['workspace'])/'memory/design')
            assert not again['registered'] and len(memory.ledger())==before
            build=memory.embed();print(compact({'embedding_build':build}),flush=True)
            queries=again['queries'];rows=[]
            for q in queries:
                kwargs={}
                if q['qid']=='Q11':kwargs.update(from_time='2026-06-24',to_time='2026-06-24 23:59:59')
                if q['qid']=='Q12':kwargs.update(from_time='2026-06-16 12:00:00',to_time='2026-06-16 23:59:59')
                if q['qid'] in ('Q13','Q19'):kwargs['include_test']=True
                result=memory.search(q['query'],**kwargs)
                aliases=[e['alias'] for e in result['results']]
                keys=[h['entrance_key'] for e in result['results'] for h in e['matching_entrances']]
                expected_units=q.get('expected_units',[])
                excluded=['c02.test_channel'] if not kwargs.get('include_test') else []
                row={'query_definition':q,'arguments':kwargs,'event_recall_pass':set(q['expected_event_aliases']).issubset(aliases),
                     'unit_recall_pass':set(expected_units)-set(excluded)<=set(keys),'default_test_exclusion_pass':not any(h['channel']=='test' for e in result['results'] for h in e['matching_entrances']) if not kwargs.get('include_test') else None,
                     'result':result,'needs_human_semantic_review':q['kind'] in ('negative','unknown-answer','speaker-filter','doubt')}
                rows.append(row);print(compact({'qid':q['qid'],'aliases':aliases,'events_pass':row['event_recall_pass'],'units_pass':row['unit_recall_pass']}),flush=True)
            # Exact pages reconstruct a long original and all semantic local spans.
            originals=[]
            for alias in ('C01','C05','C07','C11'):
                event=memory.event(alias)
                for unit in event['units']:
                    if unit.get('channel')=='test':continue
                    out=memory.open(alias,'local',memory_id=unit['memory_id'],limit=600)
                    chunks=[out['text']]
                    while out['next_offset'] is not None:
                        out=memory.open(alias,'local',memory_id=unit['memory_id'],offset=out['next_offset'],limit=600);chunks.append(out['text'])
                    full=memory.open(alias,'local',memory_id=unit['memory_id'],limit=20000)
                    assert ''.join(chunks)==full['text'] and full['complete']
                    originals.append({'alias':alias,'key':unit['key'],'pages':len(chunks),'chars':full['total_chars'],'sha256':digest(full['text']),'mapped_source_keys':[r['mid'] for r in unit['refs']]})
            q5=memory.open('C05','local',memory_id='c05.my_misread',limit=20000)
            assert all(f'id={i} /' in q5['text'] for i in (657,666,656))
            conflict=memory.open(view='source_compare',record_id=1240,limit=20000)
            comparison=json.loads(conflict['text']);assert not comparison['same_content'] and len(comparison['sources'])==2
            # Repetition must not spend again or create authored decisions.
            count=memory.status()['api_requests'];memory.search(queries[0]['query'])
            assert memory.status()['api_requests']==count
            sync=memory.sync();assert not sync['changed'] and not sync['deleted']
            # Destructively corrupt only an isolated copy; never the live cache.
            with tempfile.TemporaryDirectory(prefix='persona-memory-acceptance-') as tmp:
                copied=Path(tmp)/'store';shutil.copytree(memory.store,copied,ignore=shutil.ignore_patterns('writer.lock'))
                clone=Memory(store=copied,sources=memory.sources,config=memory.config)
                clone.db_path.write_bytes(b'intentional-corruption-fixture')
                recovery=clone.rebuild()
                assert clone.project()==memory.project()
                assert clone.ledger()==memory.ledger()
                clone.close()
            status=memory.status()
            summary={'actual_qwen_api':True,'raw_chat_sent_to_embedding':False,'build':build,
                     'queries':rows,'event_recall_passed':sum(r['event_recall_pass'] for r in rows),'unit_recall_passed':sum(r['unit_recall_pass'] for r in rows),
                     'query_count':len(rows),'original_reads':originals,'q5_three_sources_same_page':True,
                     'local_vps_conflict':{'id':1240,'same_content':False,'namespaces':[s['namespace'] for s in comparison['sources']]},
                     'repeat_import_added_decisions':0,'repeat_search_added_api_requests':0,'corrupt_copy_recovery_pass':recovery['rebuilt'],
                     'scope_notes':['Old cards not read/accepted by Persona in this batch; Q14/Q15 old-card branches not covered','No full temporary session per-turn timestamps','No Anthropic full constitution source','Retrieval relevance is not a historical factual answer'],
                     'status':status}
            atomic_json(report/'acceptance-engine.json',summary)
            print(compact({k:v for k,v in summary.items() if k not in ('queries','original_reads','status')}),flush=True)
    finally:memory.close()

if __name__=='__main__':main()
