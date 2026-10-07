import importlib.util
import json
import unittest
import tempfile
from pathlib import Path
from datetime import datetime,timezone,timedelta
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('cache_usage',Path(__file__).with_name('cache-usage.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
NOW=datetime(2026,10,7,9,0,tzinfo=timezone(timedelta(hours=8)))
def row(i,life='A',session='S',hit=0,miss=20000,known=True):
    return dict(ledger='TEST',attempt_id=str(i),life_id=life,session_id=session,
        started_at=(NOW-timedelta(seconds=10*(10-i))).isoformat(),known_usage=known,
        prompt_cache_hit_tokens=hit if known else None,prompt_cache_miss_tokens=miss if known else None,
        input_tokens=hit+miss if known else None,output_tokens=10 if known else None,
        reasoning_tokens=None,state='settled' if known else 'unknown',released_before_dispatch=False,
        local_estimated_cost_nano_cny=1 if known else None,reservation_upper_nano_cny=0,unknown_accounted_upper_nano_cny=0)

class CacheUsageTest(unittest.TestCase):
    def read(self,rows):
        with patch.object(module,'read_ledger',return_value=rows):return module.summarize(['TEST'],'A','S',NOW)
    def test_own_scope_latest_recent_and_soft_advisory(self):
        result=self.read([row(i) for i in range(4)]+[row(20,life='B'),row(21,session='T'),row(22,known=False)])
        self.assertEqual(result['latest_request']['attempt_id'],'3')
        self.assertEqual(result['recent_10_requests']['known_requests'],4)
        self.assertEqual(result['today']['known_requests'],5)
        self.assertTrue(result['advisory']['suspected_cache_anomaly'])
        self.assertEqual(result['pending_requests'],1)
        self.assertIn('no_cancellation',result['advisory']['enforcement'])
        self.assertNotIn('estimated',json.dumps(result))
        self.assertNotIn('nano_cny',json.dumps(result))
    def test_cold_start_short_inputs_and_recovered_cache(self):
        self.assertFalse(self.read([row(1)])['advisory']['suspected_cache_anomaly'])
        self.assertFalse(self.read([row(i,miss=500) for i in range(5)])['advisory']['suspected_cache_anomaly'])
        result=self.read([row(i) for i in range(4)]+[row(5,hit=19000,miss=1000)])
        self.assertFalse(result['advisory']['suspected_cache_anomaly'])
        self.assertEqual(result['latest_request']['cache_hit_rate'],.95)
    def test_no_usage_is_unknown_and_old_low_hits_not_current_anomaly(self):
        self.assertIsNone(self.read([])['latest_request'])
        rows=[{**row(i),'started_at':(NOW-timedelta(hours=2)).isoformat()} for i in range(4)]
        self.assertFalse(self.read(rows)['advisory']['suspected_cache_anomaly'])

if __name__=='__main__':unittest.main()
