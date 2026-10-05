"""SQLite single authority; integer nano-CNY, Shanghai days, fail-closed attempts.

No TTL release. A dispatched/possibly dispatched reservation survives every
exception and process restart. Cross-day calls occupy all intervening days.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import sqlite3
import sys
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = HERE.parents[1]
SHANGHAI = timezone(timedelta(hours=8), 'Asia/Shanghai')

class BudgetDenied(RuntimeError):
    pass

def clock():
    return datetime.now(SHANGHAI)

def integer(value):
    if type(value) is not int or value < 0:
        raise BudgetDenied('invalid_nonnegative_integer')
    return value

def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def process_birth(pid):
    """OS identity, not PID alone (PID reuse must not revive crashed attempts)."""
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        api = ctypes.WinDLL('kernel32', use_last_error=True)
        api.OpenProcess.argtypes = [wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.GetProcessTimes.argtypes = [wintypes.HANDLE,*([ctypes.POINTER(wintypes.FILETIME)]*4)]
        api.GetExitCodeProcess.argtypes = [wintypes.HANDLE,ctypes.POINTER(wintypes.DWORD)]
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = api.OpenProcess(0x1000,False,pid)
        if not handle:
            return None  # No alive proof: fail closed, never expire reservation.
        try:
            times = [wintypes.FILETIME() for _ in range(4)]
            code = wintypes.DWORD()
            if not api.GetExitCodeProcess(handle,ctypes.byref(code)) or code.value != 259:
                return None
            if not api.GetProcessTimes(handle,*[ctypes.byref(t) for t in times]):
                return None
            return str((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime)
        finally:
            api.CloseHandle(handle)
    try:
        # Linux portable tests; fields after the last ')' start at field 3.
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
        return None if fields[0]=='Z' else fields[19]
    except (OSError,IndexError):
        return None

class Authority:
    def __init__(self, db=None, config=None, now=clock):
        self.path = Path(db or HERE / 'control' / 'budget.sqlite3')
        self.config = config or json.loads((HERE / 'config.json').read_text(encoding='utf-8'))
        self.now = now
        c = self.config
        for key in ('daily_limit_nano_cny', 'warning_nano_cny', 'conservative_nano_cny',
                    'max_output_tokens', 'conservative_output_tokens', 'min_output_tokens', 'input_bound_tokens'):
            integer(c[key])
        if not 0 < c['min_output_tokens'] <= c['conservative_output_tokens'] <= c['max_output_tokens']:
            raise BudgetDenied('invalid_output_policy')
        if c['input_bound_tokens'] < 1048576:
            raise BudgetDenied('input_bound_below_published_capacity')
        if not 0 <= c['warning_nano_cny'] <= c['conservative_nano_cny'] <= c['daily_limit_nano_cny']:
            raise BudgetDenied('invalid_threshold_policy')
        for rates in ('peak_nano_cny_per_token', 'offpeak_nano_cny_per_token'):
            for key in ('miss', 'hit', 'output'):
                if integer(c[rates][key]) == 0:
                    raise BudgetDenied('zero_price')

    def connect(self, readonly=False):
        if not self.path.exists():
            raise BudgetDenied('authority_not_initialized')
        con = sqlite3.connect(self.path.as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=30)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA busy_timeout=30000')
        if not readonly:
            con.execute('PRAGMA synchronous=FULL')
        return con

    def price_snapshot(self):
        return {**self.config['peak_nano_cny_per_token'],
                'offpeak':self.config['offpeak_nano_cny_per_token'],
                'source':self.config['price_source'],'checked_at':self.config['price_checked_at'],
                'model':self.config['model'],'provider':self.config['provider']}

    def initialize(self, legacy_ledger=None, legacy_pending=None):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.path, timeout=30)
        con.execute('PRAGMA synchronous=FULL')
        con.executescript('''
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS attempts(
            attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
            purpose TEXT NOT NULL, payload_hash TEXT NOT NULL, started_at TEXT NOT NULL,
            start_day TEXT NOT NULL, end_day TEXT, state TEXT NOT NULL,
            reserved INTEGER NOT NULL, max_tokens INTEGER NOT NULL,
            input_bound INTEGER NOT NULL, price_json TEXT NOT NULL,
            miss INTEGER, hit INTEGER, output INTEGER, charged INTEGER,
            calculated INTEGER, usage_hash TEXT, usage_json TEXT, reason TEXT,
            provider_request_id TEXT, owner_pid INTEGER, owner_birth TEXT, wire_hash TEXT,
            bound_at TEXT, settled_at TEXT);
        ''')
        try:
            con.execute('BEGIN IMMEDIATE')
            if con.execute("SELECT value FROM meta WHERE key='initialized'").fetchone():
                return {'initialized': True, 'existing': True}
            records = []
            pending = {}
            if legacy_ledger and Path(legacy_ledger).exists():
                records = [json.loads(line) for line in Path(legacy_ledger).read_text(encoding='utf-8').splitlines() if line]
            if legacy_pending and Path(legacy_pending).exists():
                pending = json.loads(Path(legacy_pending).read_text(encoding='utf-8'))
            latest = {}
            for r in records:
                key = (r['session_id'], r['attempt_id'])
                if key not in latest or integer(r['index']) > integer(latest[key]['index']):
                    latest[key] = r
            prices = self.config['peak_nano_cny_per_token']
            for (session, attempt), r in latest.items():
                counts = r['counts']
                miss, hit, output = (integer(counts[k]) for k in ('cache_miss_tokens', 'cache_hit_tokens', 'output_tokens'))
                charge = miss*prices['miss'] + hit*prices['hit'] + output*prices['output']
                day = r['date']
                # Legacy amounts are not invoices; repricing at peak is conservative.
                con.execute('''INSERT INTO attempts(attempt_id,request_id,session_id,purpose,payload_hash,
                  started_at,start_day,end_day,state,reserved,max_tokens,input_bound,price_json,
                  miss,hit,output,charged,calculated,usage_hash,usage_json)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                  ('legacy:'+fingerprint([session,attempt]), str(attempt),str(session),'legacy_import',
                   fingerprint(r),r.get('observed_at',day),day,day,'settled',charge,0,0,
                   json.dumps(self.price_snapshot()),miss,hit,output,charge,charge,fingerprint(r),json.dumps(r)))
            for key, value in pending.items():
                day = datetime.fromisoformat(value['observed_at']).astimezone(SHANGHAI).date().isoformat()
                reserve = self.config['input_bound_tokens']*prices['miss'] + self.config['max_output_tokens']*prices['output']
                con.execute('''INSERT INTO attempts(attempt_id,request_id,session_id,purpose,payload_hash,
                  started_at,start_day,state,reserved,max_tokens,input_bound,price_json,reason)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                  ('pending:'+fingerprint(key),key,'legacy','legacy_pending',fingerprint(value),
                   value['observed_at'],day,'unknown',reserve,self.config['max_output_tokens'],
                   self.config['input_bound_tokens'],json.dumps(self.price_snapshot()),'legacy_missing_usage'))
            con.execute("INSERT INTO meta VALUES('initialized',?)", (self.now().isoformat(),))
            con.execute("INSERT INTO meta VALUES('legacy_import',?)", (json.dumps({'records':len(latest),'pending':len(pending)}),))
            con.commit()
            return {'initialized': True, 'legacy_records':len(latest), 'legacy_pending':len(pending)}
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

    def _status(self, con, day):
        rows = con.execute('SELECT * FROM attempts WHERE start_day<=? AND (end_day IS NULL OR end_day>=?)', (day,day)).fetchall()
        accounted = ('settled', 'accounted_upper')
        settled = sum(r['charged'] for r in rows if r['state'] in accounted)
        reserved = sum(r['reserved'] for r in rows if r['state'] not in accounted)
        all_open = con.execute("SELECT state,owner_pid,owner_birth FROM attempts WHERE state NOT IN ('settled','accounted_upper')").fetchall()
        orphaned = sum(r['state']=='sent' and (not r['owner_pid'] or process_birth(r['owner_pid'])!=r['owner_birth']) for r in all_open)
        unknown = sum(r['state']=='unknown' for r in all_open)+orphaned
        available = max(0,self.config['daily_limit_nano_cny']-settled-reserved)
        limit_suspended = self.config.get('daily_limit_suspended_on') == day
        reason = 'unresolved_usage' if unknown and self.config.get('stop_on_unknown_usage', True) else ('daily_budget_exhausted' if not available and not limit_suspended else None)
        if not reason and not limit_suspended and available < self.config['input_bound_tokens']*self.config['peak_nano_cny_per_token']['miss']+self.config['min_output_tokens']*self.config['peak_nano_cny_per_token']['output']:
            reason = 'insufficient_budget_for_safe_request'
        if day > self.config['price_valid_through']:
            reason = 'price_review_expired'
        if con.execute("SELECT 1 FROM meta WHERE key='breach'").fetchone():
            reason = 'provider_bound_or_usage_breach'
        if self.config.get('maintenance_pause'):
            reason = 'maintenance_pause'
        return {'date':day,'timezone':'Asia/Shanghai','unit':'nano_CNY','daily_limit':self.config['daily_limit_nano_cny'],
                'daily_limit_enforced':not limit_suspended,'daily_limit_suspended_on':self.config.get('daily_limit_suspended_on'),
                'settled':settled,'unsettled_reservations':reserved,'available':available,
                'input_tokens':sum((r['miss'] or 0)+(r['hit'] or 0) for r in rows),
                'cache_miss_tokens':sum(r['miss'] or 0 for r in rows),
                'cache_hit_tokens':sum(r['hit'] or 0 for r in rows),'output_tokens':sum(r['output'] or 0 for r in rows),
                'calculated_official_price_cost':sum(r['calculated'] or 0 for r in rows),
                'unknown_attempts':unknown,'orphaned_attempts':orphaned,'open_attempts':sum(r['state'] not in accounted for r in rows),
                'upper_accounted_attempts':sum(r['state']=='accounted_upper' for r in rows),
                'upper_accounted_charge':sum(r['charged'] for r in rows if r['state']=='accounted_upper'),
                'upper_accounted_usage_unknown':any(r['state']=='accounted_upper' for r in rows),
                'warning':not limit_suspended and settled+reserved>=self.config['warning_nano_cny'],
                'conservative':not limit_suspended and settled+reserved>=self.config['conservative_nano_cny'],
                'stop_reason':reason,'stop_on_unknown_usage':self.config.get('stop_on_unknown_usage', True),'cost_kind':'official_price_calculation_or_conservative_upper; not_account_debit_evidence',
                'cross_day_policy':'charge/reserve on each Shanghai day spanned; conservative duplicate attribution',
                'price_checked_at':self.config['price_checked_at']}

    def bind(self, args):
        """One-shot binding to actual serialized bytes before the sender runs."""
        con = self.connect()
        try:
            con.execute('BEGIN IMMEDIATE')
            row = con.execute('SELECT * FROM attempts WHERE attempt_id=?',(args['attempt_id'],)).fetchone()
            if row is None or row['state']!='sent' or row['wire_hash'] is not None:
                raise BudgetDenied('attempt_not_sendable_or_already_bound')
            headroom = integer(args.get('output_headroom_tokens', 0))
            if headroom > 1 or integer(args['max_tokens']) != row['max_tokens'] - headroom or not isinstance(args.get('wire_hash'),str) or len(args['wire_hash'])!=64:
                raise BudgetDenied('wire_binding_mismatch')
            con.execute('UPDATE attempts SET wire_hash=?,bound_at=? WHERE attempt_id=?',(args['wire_hash'],self.now().isoformat(),args['attempt_id']))
            con.commit()
            return {'bound':True}
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

    def status(self, day=None):
        con = self.connect(readonly=True)
        try:
            con.execute('BEGIN')
            return self._status(con,day or self.now().date().isoformat())
        finally:
            con.close()

    def reserve(self, args):
        c = self.config
        if args.get('provider') != c['provider'] or args.get('model') != c['model']:
            raise BudgetDenied('unpriced_provider_or_model')
        for key in ('attempt_id','request_id','session_id','purpose','payload_hash'):
            if not isinstance(args.get(key),str) or not 1 <= len(args[key]) <= 256:
                raise BudgetDenied('invalid_identity')
        wanted = integer(args['max_tokens'])
        owner = integer(args['owner_pid'])
        birth = process_birth(owner)
        if not birth:
            raise BudgetDenied('owner_process_not_alive')
        now = self.now()
        day = now.date().isoformat()
        if day > c['price_valid_through']:
            raise BudgetDenied('price_review_expired')
        con = self.connect()
        try:
            con.execute('BEGIN IMMEDIATE')
            status = self._status(con, day)
            if status['stop_reason']:
                raise BudgetDenied(status['stop_reason'])
            if con.execute('SELECT 1 FROM attempts WHERE attempt_id=?',(args['attempt_id'],)).fetchone():
                raise BudgetDenied('attempt_already_admitted_do_not_resend')
            p = c['peak_nano_cny_per_token']
            input_cost = c['input_bound_tokens']*p['miss']
            max_output = min(wanted,c['max_output_tokens']) if not status['daily_limit_enforced'] else min(wanted,c['max_output_tokens'],(status['available']-input_cost)//p['output'])
            if status['conservative']:
                max_output = min(max_output,c['conservative_output_tokens'])
            if max_output < c['min_output_tokens']:
                raise BudgetDenied('insufficient_budget_for_safe_request')
            reserved = input_cost+max_output*p['output']
            con.execute('''INSERT INTO attempts(attempt_id,request_id,session_id,purpose,payload_hash,
              started_at,start_day,state,reserved,max_tokens,input_bound,price_json,owner_pid,owner_birth)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
              (args['attempt_id'],args['request_id'],args['session_id'],args['purpose'],args['payload_hash'],
               now.isoformat(),day,'sent',reserved,max_output,c['input_bound_tokens'],json.dumps(self.price_snapshot()),owner,birth))
            con.commit()
            return {'allowed':True,'attempt_id':args['attempt_id'],'max_tokens':max_output,'reserved':reserved,
                    'input_bound':c['input_bound_tokens'],'admitted_day':day}
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

    def unknown(self, attempt_id, reason='missing_or_ambiguous_usage'):
        con = self.connect()
        try:
            con.execute('BEGIN IMMEDIATE')
            changed = con.execute("UPDATE attempts SET state='unknown',reason=? WHERE attempt_id=? AND state NOT IN ('settled','accounted_upper')",(reason,attempt_id)).rowcount
            con.commit()
            return {'retained': bool(changed)}
        finally:
            con.close()

    def settle(self, args):
        con = self.connect()
        try:
            con.execute('BEGIN IMMEDIATE')
            r = con.execute('SELECT * FROM attempts WHERE attempt_id=?',(args['attempt_id'],)).fetchone()
            if r is None:
                raise BudgetDenied('usage_without_reservation')
            u = args.get('usage')
            # Raw Messages fields, disjoint. Required miss+output, caches default only
            # when transport has explicitly confirmed a complete terminal response.
            try:
                miss = integer(u['input_tokens'])+integer(u['cache_creation_input_tokens'])
                hit = integer(u['cache_read_input_tokens'])
                output = integer(u['output_tokens'])
            except (KeyError,TypeError,BudgetDenied):
                con.execute("UPDATE attempts SET state='unknown',reason='incomplete_usage' WHERE attempt_id=? AND state NOT IN ('settled','accounted_upper')",(args['attempt_id'],))
                con.commit()
                raise BudgetDenied('incomplete_usage_reservation_retained')
            digest = fingerprint([miss,hit,output])
            if r['state']=='settled':
                if r['usage_hash'] != digest:
                    con.execute("INSERT OR REPLACE INTO meta VALUES('breach','conflicting_usage')")
                    con.commit()
                    raise BudgetDenied('conflicting_duplicate_usage')
                return {'duplicate':True,'charged':r['charged']}
            p = json.loads(r['price_json'])
            charge = miss*p['miss']+hit*p['hit']+output*p['output']
            now = self.now()
            end_day = max(r['start_day'],now.date().isoformat())
            started = datetime.fromisoformat(r['started_at'])
            # Exact offpeak only for entirely weekend intervals; other intervals
            # use peak as an explicit conservative official-price calculation.
            weekend = started.date()==now.date() and started.weekday()>=5
            offpeak = p['offpeak']
            calculated = miss*offpeak['miss']+hit*offpeak['hit']+output*offpeak['output'] if weekend else charge
            con.execute('''UPDATE attempts SET state='settled',end_day=?,miss=?,hit=?,output=?,charged=?,
              calculated=?,usage_hash=?,usage_json=?,provider_request_id=?,settled_at=? WHERE attempt_id=?''',
              (end_day,miss,hit,output,charge,calculated,digest,json.dumps(u),args.get('provider_request_id'),now.isoformat(),args['attempt_id']))
            breach = miss+hit>r['input_bound'] or output>r['max_tokens'] or charge>r['reserved']
            if breach:
                con.execute("INSERT OR REPLACE INTO meta VALUES('breach','provider_bound_violation')")
            con.commit()
            if breach:
                raise BudgetDenied('provider_bound_violation_recorded_and_halted')
            return {'settled':True,'charged':charge,'calculated':calculated}
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

    def account_upper(self, args):
        """Control-side resolution: consume the entire reviewed reservation, never invent usage.

        Requires the exact expected amount, an explicitly confirmed maximum charge,
        and the original sender's exit. This is never exposed as an Agent tool.
        Original timestamps, reservation and unknown-usage reason remain auditable.
        No upper charge is released on a new day while actual usage stays unknown.
        """
        if args.get('confirm_full_reservation_charge') is not True:
            raise BudgetDenied('explicit_full_upper_charge_required')
        con = self.connect()
        try:
            con.execute('BEGIN IMMEDIATE')
            r = con.execute('SELECT * FROM attempts WHERE attempt_id=?', (args['attempt_id'],)).fetchone()
            if r is None or r['state'] != 'unknown':
                raise BudgetDenied('unknown_attempt_required')
            if integer(args['expected_reserved']) != r['reserved']:
                raise BudgetDenied('reservation_amount_changed')
            if r['owner_pid'] and process_birth(r['owner_pid']) == r['owner_birth']:
                raise BudgetDenied('stop_original_sender_before_accounting')
            if any(r[key] is not None for key in ('miss','hit','output','usage_json','calculated')):
                raise BudgetDenied('partially_settled_usage_requires_review')
            con.execute("UPDATE attempts SET state='accounted_upper',charged=reserved,settled_at=? WHERE attempt_id=?",
                        (self.now().isoformat(), args['attempt_id']))
            con.commit()
            return {'accounted_upper': True, 'attempt_id': args['attempt_id'], 'charged': r['reserved'],
                    'actual_usage_known': False, 'released_reservation': 0, 'carries_across_days': True}
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('init','status','reserve','bind','settle','unknown','account_upper'))
    parser.add_argument('--db',type=Path)
    options = parser.parse_args()
    authority = Authority(options.db)
    try:
        if options.operation=='init':
            result = authority.initialize(BASE/'reports/api_usage_events.jsonl',BASE/'reports/api_usage_pending.json')
        elif options.operation=='status':
            result = authority.status()
            result['cny'] = {key: f"{result[key]//1_000_000_000}.{result[key]%1_000_000_000:09d}"
                             for key in ('daily_limit','settled','unsettled_reservations','available','calculated_official_price_cost')}
        else:
            args = json.load(sys.stdin)
            result = authority.unknown(args['attempt_id'],args.get('reason','ambiguous')) if options.operation=='unknown' else getattr(authority,options.operation)(args)
        print(json.dumps({'result':result},ensure_ascii=False))
    except Exception as error:
        # Never echo request bodies, headers or arbitrary exceptions.
        print(json.dumps({'error':str(error) if isinstance(error,BudgetDenied) else type(error).__name__,'retryable':False}))
        sys.exit(2)

if __name__=='__main__':
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    main()
