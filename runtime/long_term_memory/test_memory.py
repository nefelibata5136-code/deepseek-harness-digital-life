"""Offline synthetic transport tests; no local embedding/rerank models or APIs."""
import copy
import json
import math
import tempfile
import unittest
from pathlib import Path
from engine import Memory
from source_reader import anchor_span,message_key,compact

ROOT={'kind':'persona','session_id':'offline-root','call_id':'offline-receipt'}
CHILD={'kind':'child_suggestion','session_id':'offline-child','call_id':'offline-child-receipt'}
class FakeQwen:
    def __init__(self,config,audit):self.config=config;self.audit=audit;self.calls=[]
    def embed(self,texts):
        self.calls.append(('embedding',list(texts)))
        self.audit({'operation':'embedding','usage':{'total_tokens':len(texts)},'ok':True,'synthetic':True})
        return [[1.,float('镜子' in text)+.1,float('门' in text)+.1] for text in texts]
    def rerank(self,query,docs):
        self.calls.append(('rerank',list(docs)));self.audit({'operation':'rerank','ok':True,'synthetic':True})
        return [{'index':i,'score':.9-i*.01,'rank':i+1} for i in range(len(docs))]

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name)
        self.path=self.base/'raw.jsonl';self.vps=self.base/'vps.jsonl'
        self.rows=[{'id':1,'conversation_id':'main','role':'user','content':'那面镜子\n开始🙂甲\n第二个话题\n末尾乙','created_at':'2026-06-14 22:48:36'},
                   {'id':2,'conversation_id':'main','role':'assistant','content':'过去我说错了，原话保留','created_at':'2026-06-14 22:48:36'},
                   {'id':3,'conversation_id':'test','role':'user','content':'维修门测试','created_at':'2026-06-14 22:49:36'}]
        self.write_rows();self.vps.write_text(compact({**self.rows[0],'content':'VPS同ID不同内容'})+'\n',encoding='utf-8')
        config={'workspace_id':'offline','embedding_model':'fake-http','rerank_model':'fake-http','dimension':3}
        sources={'sources':[{'namespace':'local','path':'raw.jsonl'},{'namespace':'vps','path':'vps.jsonl'}],
                 'workspace':str(self.base/'workspace'),'native_sessions':'absent','selection_locators':'absent'}
        self.m=Memory(self.base,self.base/'store',sources,config,FakeQwen);self.addCleanup(self.m.close)
        self.m.sync()
    def write_rows(self):self.path.write_text(''.join(compact(r)+'\n' for r in self.rows),encoding='utf-8')
    def payload(self,alias='T1'):
        refs=[self.m.source_ref('local','main',1),self.m.source_ref('local','main',2)]
        side=self.m.source_ref('local','test',3)
        return {'alias':alias,'name':'那面镜子与更正','one_line':'一个经历，有不连续定位与测试旁证','time':{},
                'meaning':{'then':'当时我说错了','later':'现在补一行'},'source_refs':refs,'side_refs':[side],
                'units':[{'key':'mirror','title':'镜子','blurb':'记忆连续性','terms':['镜子'],'my_phrases':['那面镜子'],'refs':[refs[0]]},
                         {'key':'local-topic','title':'第二个话题','terms':['emoji'],'refs':[self.m.source_ref('local','main',1,{'start':'开始🙂甲','end':'末尾乙'})]},
                         {'key':'test-only','title':'测试门','terms':['维修门'],'refs':[side],'channel':'test'}]}
    def accepted(self):
        r=self.m.register(self.payload(),ROOT);self.m.decide(r['event_id'],'accepted',ROOT,r['revision']);return r['event_id']
    def test_multi_entrance_retrieval_mapping_no_raw_and_repeat_no_api(self):
        eid=self.accepted();self.m.embed();a=self.m.search('那面镜子');n=len(self.m.provider().calls);b=self.m.search('那面镜子')
        self.assertEqual(len(self.m.provider().calls),n);self.assertTrue(b['rerank_cache_hit'])
        self.assertEqual(a['results'][0]['event_id'],eid);self.assertFalse(a['results'][0]['raw_content_included'])
        self.assertNotIn('过去我说错了',compact(a));self.assertFalse(any(h['channel']=='test' for r in a['results'] for h in r['matching_entrances']))
        explicit=self.m.search('测试门',include_test=True)
        self.assertTrue(any(h['channel']=='test' for r in explicit['results'] for h in r['matching_entrances']))
    def test_search_configuration_changes_defaults_and_explicit_arguments_win(self):
        for index in range(3):
            r=self.m.register(self.payload('defaults-'+str(index)),ROOT)
            self.m.decide(r['event_id'],'accepted',ROOT,r['revision'])
        self.m.config.update(default_results=2,default_candidates=30)
        configured=self.m.search('镜子')
        self.assertEqual(len(configured['results']),2)
        self.assertEqual(configured['candidate_entrances'],6)
        self.m.config['default_candidates']=1
        narrower=self.m.search('镜子')
        self.assertEqual(narrower['candidate_entrances'],1)
        self.assertEqual(len(narrower['results']),1)
        explicit=self.m.search('镜子',limit=3,candidates=6)
        self.assertEqual(len(explicit['results']),3)
        self.assertEqual(explicit['candidate_entrances'],6)
        self.m.config.pop('default_results');self.m.config.pop('default_candidates')
        legacy=self.m.search('镜子')
        self.assertEqual(len(legacy['results']),3)
        self.assertEqual(legacy['candidate_entrances'],6)

    def test_invalid_search_configuration_fails_before_provider_call(self):
        self.accepted()
        for key,value in [('default_results',0),('default_results',11),('default_results',True),
                          ('default_candidates',0),('default_candidates',31),('default_candidates','5')]:
            with self.subTest(key=key,value=value):
                self.m.config.update(default_results=5,default_candidates=30)
                self.m.config[key]=value
                with self.assertRaises(ValueError):self.m.search('镜子')
                self.assertIsNone(self.m.client)
    def test_long_message_emoji_exact_paging_and_open_whole(self):
        eid=self.accepted();unit=self.m.event(eid)['units'][1]
        page=self.m.open(eid,'local',memory_id=unit['memory_id'],limit=40)
        text=page['text']
        while page['next_offset'] is not None:
            page=self.m.open(eid,'local',memory_id=unit['memory_id'],offset=page['next_offset'],limit=40);text+=page['text']
        self.assertIn('开始🙂甲\n第二个话题\n末尾乙',text)
        self.assertIn('那面镜子',self.m.open(eid,'message',record_id=1,namespace='local',conversation='main')['text'])
    def test_incremental_edit_quarantine_accept_keep_meaning_and_id(self):
        eid=self.accepted();before=copy.deepcopy(self.m.event(eid));self.rows[0]['content']='新增🙂\n'+self.rows[0]['content'];self.write_rows()
        r=self.m.sync();self.assertEqual(len(r['changed']),1);self.assertTrue(self.m.event(eid)['needs_review'])
        self.assertEqual(self.m.search('镜子')['results'],[])
        ev=self.m.event(eid);self.m.decide(eid,'accepted',ROOT,ev['revision']);after=self.m.event(eid)
        self.assertEqual(before['meaning'],after['meaning']);self.assertEqual(before['units'][1]['memory_id'],after['units'][1]['memory_id']);self.assertFalse(after['needs_review'])
        self.assertNotEqual(before['units'][1]['refs'][0]['span']['start'],after['units'][1]['refs'][0]['span']['start'])
    def test_deleted_source_not_kept_alive_and_historical_snapshot_readable(self):
        eid=self.accepted();ref=self.m.event(eid)['source_refs'][0];self.rows=self.rows[1:];self.write_rows();r=self.m.sync()
        self.assertEqual(len(r['deleted']),1);self.assertTrue(self.m.event(eid)['needs_review'])
        historical=self.m.open(eid,'message',record_id=1,namespace='local',conversation='main',version=ref['revision_hash'])
        self.assertIn('那面镜子',historical['text'])
    def test_notes_corrections_append_only_child_cannot_accept(self):
        eid=self.accepted();r=self.m.annotate(eid,{'note':'我的旧备注','tags':['骨头']},ROOT,2)
        self.m.annotate(eid,{'note':'后来更正'},ROOT,r['revision'],r['annotation_id'])
        notes=self.m.event(eid)['annotations'];self.assertEqual(len(notes),2);self.assertEqual(notes[0]['fields']['note'],'我的旧备注')
        self.assertEqual(notes[1]['supersedes'],notes[0]['annotation_id'])
        with self.assertRaises(PermissionError):self.m.decide(eid,'accepted',CHILD,4)
        with self.assertRaises(PermissionError):self.m.annotate(eid,{'note':'冒充'},CHILD,4)
        with self.assertRaises(ValueError):self.m.annotate(eid,{'note':'过期'},ROOT,2)
    def test_child_meaning_is_suggestion_only(self):
        r=self.m.register(self.payload('S1'),CHILD);e=self.m.event(r['event_id'])
        self.assertNotIn('meaning',e);self.assertIn('suggested_meaning',e);self.assertNotIn('my_phrases',e['units'][0])
    def test_index_corruption_rebuild_keeps_ids_annotations_and_versions(self):
        eid=self.accepted();self.m.annotate(eid,{'note':'重建也留下'},ROOT,2)
        before=self.m.event(eid);self.m.close();self.m.db_path.write_bytes(b'corrupt-index')
        result=self.m.rebuild();after=self.m.event(eid)
        self.assertTrue(result['rebuilt']);self.assertEqual(before,after);self.assertEqual(len(self.m.ledger()),3)
        observations_before=self.m.observations.stat().st_size;self.m.sync();self.assertEqual(observations_before,self.m.observations.stat().st_size)
    def test_journal_corruption_is_not_silently_rewritten(self):
        self.accepted();data=self.m.journal.read_bytes();self.m.journal.write_bytes(data.replace(b'accepted',b'forgeddd',1))
        with self.assertRaises(RuntimeError):self.m.rebuild()
        self.assertNotEqual(self.m.journal.read_bytes(),data)
    def test_ambiguous_anchor_and_missing_anchor_rejected(self):
        with self.assertRaises(ValueError):anchor_span('重复重复','重复')
        with self.assertRaises(ValueError):anchor_span('真实','不存在')
    def test_multisource_ids_remain_separate(self):
        local=self.m.item(message_key('local','main',1));vps=self.m.item(message_key('vps','main',1))
        self.assertNotEqual(local['mid'],vps['mid']);self.assertNotEqual(local['content_hash'],vps['content_hash'])
    def test_source_namespace_conflict_fails_before_overwrite(self):
        self.m.sources['sources'].append({'namespace':'local','path':'vps.jsonl'})
        with self.assertRaises(ValueError):self.m.sync()
        self.assertEqual(self.m.item(message_key('local','main',1))['raw']['content'],self.rows[0]['content'])
    def test_repeat_sync_does_not_duplicate_observations(self):
        size=self.m.observations.stat().st_size;result=self.m.sync()
        self.assertEqual(result['added'],[]);self.assertEqual(result['changed'],[]);self.assertEqual(self.m.observations.stat().st_size,size)

    def test_cross_message_boundary_anchor_and_explicit_rejection(self):
        first=anchor_span('前缀🙂唯一开头正文','唯一开头')
        last=anchor_span('接续正文唯一结尾后缀',None,'唯一结尾')
        self.assertEqual(first['exact_quote'],'唯一开头正文')
        self.assertEqual(last['exact_quote'],'接续正文唯一结尾')
        r=self.m.register(self.payload('suggestion'),CHILD)
        self.m.decide(r['event_id'],'rejected',ROOT,r['revision'])
        self.assertEqual(self.m.catalog()['events'][0]['status'],'rejected')
        self.assertEqual(self.m.ledger()[-1]['actor']['kind'],'persona')
        self.assertEqual(self.m.search('镜子')['results'],[])

    def test_corrupt_rerank_cache_recovered_and_all_candidates_auditable(self):
        self.accepted();result=self.m.search('镜子')
        before=len(self.m.provider().calls)
        self.m.db.execute("UPDATE reranks SET result='[]'");self.m.db.commit()
        fixed=self.m.search('镜子')
        self.assertFalse(fixed['rerank_cache_hit']);self.assertEqual(len(self.m.provider().calls),before+1)
        audit=json.loads(self.m.open(view='search_audit',search_id=result['search_id'])['text'])
        self.assertEqual(len(audit['ranked_entrances']),2)

    def test_conflict_keeps_both_full_versions_available(self):
        self.m.sources['sources'].append({'namespace':'local','path':'vps.jsonl'})
        with self.assertRaises(ValueError):self.m.sync()
        pair=json.loads(self.m.open(view='source_conflicts')['text'])['pairs'][0]
        self.assertEqual(len(pair['sources']),2)
        self.assertNotEqual(pair['sources'][0]['raw']['content'],pair['sources'][1]['raw']['content'])

    def test_twelve_round_event_over_100k_chars_has_one_semantic_entrance(self):
        self.rows=[{'id':i,'conversation_id':'long-project','role':'user' if i%2 else 'assistant',
                    'content':f'第{i}轮\n'+('同一个目标🙂\n'*1300),'created_at':None} for i in range(1,25)]
        self.write_rows();self.m.sync()
        refs=[self.m.source_ref('local','long-project',i) for i in range(1,25)]
        p={'name':'长期目标的一个事件','time':{},'source_refs':refs,'units':[{'key':'whole-goal','title':'目标入口','terms':['同一个目标'],'refs':refs}]}
        r=self.m.register(p,ROOT);self.m.decide(r['event_id'],'accepted',ROOT,r['revision'])
        self.m.embed();self.assertEqual(self.m.status()['entrances'],1)
        text=[];offset=0
        while True:
            page=self.m.open(r['event_id'],'event',offset=offset,limit=20000);text.append(page['text'])
            if page['next_offset'] is None:break
            offset=page['next_offset']
        self.assertGreater(page['total_chars'],100000)
        self.assertEqual(len(''.join(text)),page['total_chars'])
        self.assertTrue(all(row['content'] in ''.join(text) for row in self.rows))
        self.assertEqual(len(self.m.event(r['event_id'])['units']),1)

if __name__=='__main__':unittest.main()
