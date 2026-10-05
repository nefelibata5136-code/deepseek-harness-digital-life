"""Offline tests, temporary ledgers; never invoke a model or edit live usage."""
import unittest
import tempfile
import copy
import json
import os
from pathlib import Path
from datetime import datetime, timedelta
from .authority import Authority, SHANGHAI, HERE
from .pricing import band, cost_bounds
from .usage_report import report

class Tests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.now = datetime(2026, 10, 4, 13, tzinfo=SHANGHAI)
        self.a = Authority(Path(folder.name)/'budget.db', copy.deepcopy(json.loads((HERE/'config.json').read_text())), lambda:self.now)
        self.a.initialize()

    def request(self, id, session='main', miss=100, hit=0, output=10, unknown=False):
        self.a.reserve(dict(attempt_id=id,request_id=id,session_id=session,purpose='compaction',payload_hash=id,
                            provider='deepseek-official',model='deepseek-flash',max_tokens=16384,owner_pid=os.getpid()))
        if unknown:
            self.a.unknown(id)
        else:
            self.a.settle(dict(attempt_id=id,usage=dict(input_tokens=miss,cache_creation_input_tokens=0,
                                                      cache_read_input_tokens=hit,output_tokens=output)))

    def test_offpeak_cost_excludes_conservative_charge_and_unknown(self):
        self.request('one')
        self.request('unknown', unknown=True)
        r = report(self.a, 'main')
        self.assertEqual(r['daily']['cost_lower_nano_cny'], 140000)
        self.assertEqual(r['daily']['cost_upper_nano_cny'], 140000)
        self.assertEqual(r['session']['pending_requests'], 1)
        self.assertFalse(r['session']['cache_coverage_complete'])
        self.assertGreater(r['session']['pending_upper_nano_cny'], 0)
        self.assertEqual(self.a.status()['settled'], 280000)

    def test_weighted_session_cache_excludes_other_sessions(self):
        self.request('small', miss=0, hit=100)
        self.request('large', miss=900, hit=0)
        self.request('other', session='other', miss=0, hit=9000)
        r = report(self.a, 'main')
        self.assertEqual(r['session']['cache_hit_rate'], .1)
        self.assertEqual(r['session']['input_tokens'], 1000)
        self.assertEqual(r['daily']['input_tokens'], 10000)

    def test_empty_session_is_null_not_zero_or_another_session(self):
        self.request('one')
        r = report(self.a, 'empty')['session']
        self.assertIsNone(r['cache_hit_rate'])
        self.assertEqual(r['known_requests'], 0)

    def test_read_only_repeat_no_recount_and_day_vs_session(self):
        self.request('one', hit=100)
        first = report(self.a, 'main')
        self.assertEqual(first, report(self.a, 'main'))
        self.now += timedelta(days=1)
        later = report(self.a, 'main')
        self.assertEqual(later['daily']['known_requests'], 0)
        self.assertEqual(later['session']['known_requests'], 1)

    def test_peak_edges_weekends_and_holidays(self):
        def at(day, hour, minute=0):
            return datetime.fromisoformat(f'{day}T{hour:02}:{minute:02}:00+08:00')
        self.assertEqual(band(at('2026-10-08', 8, 59)), 'offpeak')
        self.assertEqual(band(at('2026-10-08', 9)), 'peak')
        self.assertEqual(band(at('2026-10-08', 12)), 'offpeak')
        self.assertEqual(band(at('2026-10-08', 14)), 'peak')
        self.assertEqual(band(at('2026-10-08', 18)), 'offpeak')
        self.assertEqual(band(at('2026-10-05', 10)), 'offpeak')
        self.assertEqual(band(at('2026-10-10', 10)), 'offpeak')
        self.assertIsNone(band(at('2027-01-01', 10)))

    def test_spanning_price_boundary_is_range(self):
        p = self.a.price_snapshot()
        row=dict(price_json=json.dumps(p),miss=100,hit=0,output=10,
                 started_at='2026-10-08T08:59:00+08:00',settled_at='2026-10-08T09:01:00+08:00')
        self.assertEqual(cost_bounds(row), (140000,280000))
        row.update(started_at='2026-10-08T08:00:00+08:00',settled_at='2026-10-08T13:00:00+08:00')
        self.assertEqual(cost_bounds(row), (140000,280000))

if __name__ == '__main__':
    unittest.main()
