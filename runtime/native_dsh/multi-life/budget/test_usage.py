import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('usage',Path(__file__).with_name('usage.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class UsageTests(unittest.TestCase):
    def test_multiple_ledgers_owner_categories_optional_reasoning_and_unknown_coverage(self):
        with tempfile.TemporaryDirectory(prefix='TEST-ONLY-life-usage-') as root:
            paths=[]
            for index,life in enumerate(['life-TEST-A','life-TEST-B']):
                path=Path(root)/f'{index}.sqlite3';paths.append(path);con=sqlite3.connect(path)
                con.execute('CREATE TABLE attempts(attempt_id,request_id,session_id,purpose,price_json,usage_json,state,hit,miss,output,calculated,reserved,charged,provider_request_id,started_at,start_day)')
                con.execute('CREATE TABLE request_attribution(attempt_id,life_id,run_id,source_kind,reason,provenance,origin_room_id,provider,model,prompt_metadata_json)')
                con.execute('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(f'TEST-{index}','TEST-request',f'TEST-session-{index}','agent-loop',json.dumps({'model':'deepseek-flash','provider':'deepseek-official'}),json.dumps({'reasoning_tokens':8}),'settled',80,20,10,1600,5000,1600,'sk-SYNTHETIC-REJECTION-FIXTURE-e98df4a8','2026-10-06T20:00:00+08:00','2026-10-06'))
                con.execute('INSERT INTO request_attribution VALUES(?,?,?,?,?,?,?,?,?,?)',(f'TEST-{index}',life,'TEST-run','room-inbox','peer_room','trusted_native_source','TEST-room','deepseek-official','deepseek-flash','{}'))
                if index==0:con.execute('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',('TEST-pending','TEST-pending','TEST-session-0','agent-loop',json.dumps({'model':'deepseek-flash'}),None,'unknown',None,None,None,None,5000,None,None,'2026-10-06T20:01:00+08:00','2026-10-06'))
                con.commit();con.close()
            before=[path.read_bytes() for path in paths]
            value=module.report([*paths,paths[0]],day='2026-10-06')
            self.assertEqual(value['total']['requests'],3);self.assertEqual(value['total']['cache_hit_rate'],0.8)
            self.assertEqual(value['total']['output_tokens'],20);self.assertEqual(value['total']['reasoning_tokens'],16)
            self.assertEqual(value['total']['local_estimated_cost_nano_cny'],3200)
            self.assertEqual(value['total']['reservation_upper_nano_cny'],5000);self.assertFalse(value['total']['cache_coverage_complete'])
            self.assertTrue(any(group['life_id'] is None for group in value['groups']))
            self.assertTrue(all(row['provider_request_id'] is None for row in value['requests']))
            self.assertEqual(before,[path.read_bytes() for path in paths]);self.assertFalse(value['duplicate_attempt_conflicts'])
            self.assertEqual(module.report(paths,day='2026-10-06',after='2026-10-06T20:01:00+08:00')['total']['requests'],1)

if __name__=='__main__':unittest.main()
