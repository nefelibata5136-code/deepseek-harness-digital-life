"""Offline persistence/concurrency tests. Every ledger is a temporary fixture."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from datetime import datetime, timedelta
from authority import Authority, BudgetDenied, SHANGHAI, HERE

NOW = datetime(2026,10,4,13,tzinfo=SHANGHAI)
CONFIG = json.loads((HERE/'config.json').read_text(encoding='utf-8'))
CONFIG['stop_on_unknown_usage'] = True

def args(i='one', output=16384):
    return dict(attempt_id=i,request_id='request',session_id='session',purpose='agent-loop',
                payload_hash='fake-hash',provider='deepseek-official',model='deepseek-flash',max_tokens=output,owner_pid=os.getpid())

def usage(miss=100,hit=0,output=10):
    return dict(input_tokens=miss,cache_read_input_tokens=hit,cache_creation_input_tokens=0,output_tokens=output)

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name)/'budget.db'
        self.now = NOW
        self.authority = Authority(self.db,copy.deepcopy(CONFIG),lambda:self.now)
        self.authority.initialize()

    def test_unknown_does_not_stop_but_daily_budget_still_applies(self):
        self.authority.config['stop_on_unknown_usage'] = False
        self.authority.reserve(args('unknown'))
        self.authority.unknown('unknown')
        state = self.authority.status()
        self.assertEqual(state['unknown_attempts'], 1)
        self.assertIsNone(state['stop_reason'])
        self.authority.reserve(args('next'))
        self.authority.config['daily_limit_nano_cny'] = 1
        with self.assertRaises(BudgetDenied):
            self.authority.reserve(args('over-limit'))

    def test_temporary_maintenance_pauses_new_calls(self):
        self.authority.config['maintenance_pause'] = True
        with self.assertRaises(BudgetDenied): self.authority.reserve(args())
        self.authority.config.pop('maintenance_pause')
        self.authority.reserve(args())

    def test_noncache_exact_integer_and_status(self):
        self.authority.reserve(args())
        result = self.authority.settle(dict(attempt_id='one',usage=usage()))
        self.assertEqual(result['charged'],280000)
        self.assertEqual(result['calculated'],140000)
        self.assertEqual(self.authority.status()['unsettled_reservations'],0)

    def test_cache_hit_not_promised_at_admission(self):
        reserve = self.authority.reserve(args())
        self.assertEqual(reserve['reserved'],1048576*2000+16384*8000)
        result = self.authority.settle(dict(attempt_id='one',usage=usage(0,100,10)))
        self.assertEqual(result['charged'],84000)

    def test_duplicates_and_retries(self):
        self.authority.reserve(args())
        with self.assertRaises(BudgetDenied): self.authority.reserve(args())
        self.authority.settle(dict(attempt_id='one',usage=usage()))
        self.assertTrue(self.authority.settle(dict(attempt_id='one',usage=usage()))['duplicate'])
        self.authority.reserve(args('second-attempt'))
        self.assertEqual(self.authority.status()['open_attempts'],1)

    def test_conflicting_usage_halts(self):
        self.authority.reserve(args())
        self.authority.settle(dict(attempt_id='one',usage=usage()))
        with self.assertRaises(BudgetDenied): self.authority.settle(dict(attempt_id='one',usage=usage(output=11)))
        with self.assertRaises(BudgetDenied): self.authority.reserve(args('next'))

    def test_unknown_retained_and_blocks_retry(self):
        self.authority.reserve(args())
        before = self.authority.status()['unsettled_reservations']
        self.authority.unknown('one')
        with self.assertRaises(BudgetDenied): self.authority.reserve(args('retry'))
        self.assertEqual(self.authority.status()['unsettled_reservations'],before)
        # Late authoritative usage can settle the retained attempt once.
        self.authority.settle(dict(attempt_id='one',usage=usage()))
        self.authority.reserve(args('late-retry'))

    def test_missing_usage_no_zero_settlement(self):
        self.authority.reserve(args())
        with self.assertRaises(BudgetDenied): self.authority.settle(dict(attempt_id='one',usage={}))
        self.assertGreater(self.authority.status()['unsettled_reservations'],0)
        with self.assertRaises(BudgetDenied): self.authority.reserve(args('retry'))

    def test_upper_accounting_retains_maximum_and_unknown_tokens(self):
        reservation = self.authority.reserve(args())['reserved']
        self.authority.unknown('one')
        request = dict(attempt_id='one', expected_reserved=reservation, confirm_full_reservation_charge=True)
        with self.assertRaises(BudgetDenied): self.authority.account_upper(request)
        with patch('authority.process_birth', return_value=None):
            with self.assertRaises(BudgetDenied): self.authority.account_upper({**request,'expected_reserved':reservation-1})
            with self.assertRaises(BudgetDenied): self.authority.account_upper({**request,'confirm_full_reservation_charge':False})
            receipt = self.authority.account_upper(request)
        self.assertEqual(receipt['released_reservation'], 0)
        self.assertFalse(receipt['actual_usage_known'])
        state = self.authority.status()
        self.assertEqual(state['available'], CONFIG['daily_limit_nano_cny']-reservation)
        self.assertEqual(state['calculated_official_price_cost'], 0)
        self.assertEqual(state['input_tokens'], 0)
        self.assertEqual(state['upper_accounted_charge'], reservation)
        self.assertIsNone(state['stop_reason'])
        self.authority.reserve(args('next'))
        self.now += timedelta(days=1)
        self.assertEqual(self.authority.status()['upper_accounted_charge'],reservation)
        self.authority.unknown('one')
        self.assertEqual(self.authority.status()['upper_accounted_charge'],reservation)
        # Real late usage can still replace the conservative maximum.
        self.authority.settle(dict(attempt_id='one',usage=usage()))
        self.assertEqual(self.authority.status()['upper_accounted_attempts'],0)

    def test_final_wire_binding_is_single_use(self):
        self.authority.reserve(args())
        bind=dict(attempt_id='one',max_tokens=16384,wire_hash='f'*64)
        self.assertTrue(self.authority.bind(bind)['bound'])
        with self.assertRaises(BudgetDenied): self.authority.bind(bind)

    def test_provider_bound_breach_records_and_halts(self):
        self.authority.reserve(args())
        with self.assertRaises(BudgetDenied): self.authority.settle(dict(attempt_id='one',usage=usage(output=16385)))
        self.assertEqual(self.authority.status()['output_tokens'],16385)
        with self.assertRaises(BudgetDenied): self.authority.reserve(args('retry'))

    def test_wire_headroom_preserves_accounting_bound(self):
        self.authority.reserve(args(output=65536))
        self.authority.bind(dict(attempt_id='one',max_tokens=65535,output_headroom_tokens=1,wire_hash='a'*64))
        self.authority.settle(dict(attempt_id='one',usage=usage(output=65536)))
        self.assertIsNone(self.authority.status()['stop_reason'])
        self.authority.reserve(args('two',output=65536))
        with self.assertRaises(BudgetDenied):
            self.authority.bind(dict(attempt_id='two',max_tokens=65534,output_headroom_tokens=2,wire_hash='b'*64))

    def test_thread_concurrency_no_overcommit(self):
        def run(i):
            try: return self.authority.reserve(args(str(i)))['reserved']
            except BudgetDenied: return 0
        with ThreadPoolExecutor(max_workers=16) as pool: values = list(pool.map(run,range(40)))
        capacity = CONFIG['daily_limit_nano_cny'] // (CONFIG['input_bound_tokens'] * 2000 + args()['max_tokens'] * 8000)
        self.assertEqual(sum(v>0 for v in values),min(40,capacity))
        self.assertLessEqual(sum(values),CONFIG['daily_limit_nano_cny'])

    def test_process_concurrency_uses_same_authority(self):
        def run(i):
            p = subprocess.run([sys.executable,str(HERE/'authority.py'),'reserve','--db',str(self.db)],
                input=json.dumps(args('process-'+str(i))),text=True,capture_output=True,encoding='utf-8')
            return p.returncode==0
        with ThreadPoolExecutor(max_workers=8) as pool: results=list(pool.map(run,range(12)))
        capacity = CONFIG['daily_limit_nano_cny'] // (CONFIG['input_bound_tokens'] * 2000 + args()['max_tokens'] * 8000)
        self.assertEqual(sum(results),min(12,capacity))
        self.assertLessEqual(self.authority.status()['unsettled_reservations'],CONFIG['daily_limit_nano_cny'])

    def test_shrink_output_and_reject_without_mutation(self):
        config = copy.deepcopy(CONFIG)
        config.update(daily_limit_nano_cny=2_120_000_000,warning_nano_cny=2_000_000_000,conservative_nano_cny=2_100_000_000)
        a=Authority(self.db,config,lambda:NOW)
        admitted=a.reserve(args())
        self.assertEqual(admitted['max_tokens'],2856)
        self.assertLessEqual(admitted['reserved'],config['daily_limit_nano_cny'])
        before=a.status()
        with self.assertRaises(BudgetDenied): a.reserve(args('denied'))
        self.assertEqual(a.status(),before)

    def test_cross_day_unknown_and_reservation_carry(self):
        self.now=NOW.replace(hour=23,minute=59)
        self.authority.reserve(args())
        reserve=self.authority.status()['unsettled_reservations']
        self.now+=timedelta(days=1)
        self.assertEqual(self.authority.status()['unsettled_reservations'],reserve)
        self.authority.unknown('one')
        with self.assertRaises(BudgetDenied): self.authority.reserve(args('next-day'))

    def test_cross_day_settlement_occupies_all_spanned_days(self):
        self.authority.reserve(args())
        self.now+=timedelta(days=2)
        self.authority.settle(dict(attempt_id='one',usage=usage()))
        for day in ('2026-10-04','2026-10-05','2026-10-06'):
            self.assertEqual(self.authority.status(day)['settled'],280000)
        self.assertEqual(self.authority.status('2026-10-07')['settled'],0)

    def test_crash_restart_no_release(self):
        source = 'from authority import Authority; from datetime import datetime; import os; a=Authority('+repr(str(self.db))+', now=lambda: datetime.fromisoformat('+repr(NOW.isoformat())+')); req='+repr(args('crashed'))+'; req["owner_pid"]=os.getpid(); a.reserve(req); os._exit(17)'
        p=subprocess.run([sys.executable,'-c',source],cwd=HERE,capture_output=True)
        self.assertEqual(p.returncode,17)
        reopened=Authority(self.db,config=copy.deepcopy(CONFIG),now=lambda:NOW)
        self.assertGreater(reopened.status()['unsettled_reservations'],0)
        self.assertEqual(reopened.status()['orphaned_attempts'],1)
        with self.assertRaises(BudgetDenied): reopened.reserve(args('crashed'))
        with self.assertRaises(BudgetDenied): reopened.reserve(args('new-attempt-after-crash'))

    def test_readonly_status_does_not_create_or_reset(self):
        missing=Authority(Path(self.temp.name)/'missing.db')
        with self.assertRaises(BudgetDenied): missing.status()
        self.assertFalse(missing.path.exists())
        self.authority.reserve(args())
        before=self.db.read_bytes()
        self.authority.status()
        self.assertEqual(before,self.db.read_bytes())
        self.authority.initialize()
        self.assertEqual(before,self.db.read_bytes())

    def test_provider_and_price_fail_closed(self):
        request=args(); request['model']='deepseek-v4-pro'
        with self.assertRaises(BudgetDenied): self.authority.reserve(request)
        self.now=NOW+timedelta(days=8)
        with self.assertRaises(BudgetDenied): self.authority.reserve(args())

    def test_legacy_import_latest_no_second_bill(self):
        ledger=Path(self.temp.name)/'legacy.jsonl'
        r=dict(session_id='s',attempt_id='a',index=1,date='2026-10-04',observed_at=NOW.isoformat(),
            counts=dict(cache_miss_tokens=100,cache_hit_tokens=0,output_tokens=10))
        later={**r,'index':2,'counts':dict(cache_miss_tokens=100,cache_hit_tokens=20,output_tokens=10)}
        ledger.write_text('\n'.join(json.dumps(x) for x in (r,later,later)),encoding='utf-8')
        a=Authority(Path(self.temp.name)/'import.db',config=copy.deepcopy(CONFIG),now=lambda:NOW)
        a.initialize(ledger)
        self.assertEqual(a.status()['settled'],280800)
        a.initialize(ledger)
        self.assertEqual(a.status()['settled'],280800)

    def test_legacy_pending_not_released(self):
        pending=Path(self.temp.name)/'pending.json'
        pending.write_text(json.dumps({'s:a':{'observed_at':NOW.isoformat()}}))
        a=Authority(Path(self.temp.name)/'import.db',config=copy.deepcopy(CONFIG),now=lambda:NOW)
        a.initialize(legacy_pending=pending)
        with self.assertRaises(BudgetDenied): a.reserve(args())

    def test_warning_and_conservative_mode_configurable(self):
        config=copy.deepcopy(CONFIG)
        config.update(warning_nano_cny=1,conservative_nano_cny=2)
        a=Authority(self.db,config,lambda:NOW)
        a.reserve(args())
        a.settle(dict(attempt_id='one',usage=usage()))
        self.assertTrue(a.status()['warning'])
        self.assertTrue(a.status()['conservative'])
        self.assertEqual(a.reserve(args('conservative'))['max_tokens'],2048)

if __name__=='__main__': unittest.main(verbosity=2)
