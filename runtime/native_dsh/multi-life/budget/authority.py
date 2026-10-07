"""Owner/account extension of the existing budget_guard.Authority, not new pricing.

Super operations execute inside our outer SQLite transaction. Ownership,
per-life caps and audit rows commit with the original reservation/settlement.
"""
from __future__ import annotations
import json
import sys
import threading
from pathlib import Path
from datetime import datetime

GUARD=Path(__file__).resolve().parents[3]/'budget_guard'
sys.path.insert(0,str(GUARD))
from authority import Authority,BudgetDenied,integer,fingerprint,clock,SHANGHAI


class TransactionView:
    def __init__(self,connection):self.connection=connection;self.commit_requested=False
    def execute(self,sql,*args):
        if sql.strip().upper().startswith('BEGIN'):return self.connection.execute('SELECT 1')
        return self.connection.execute(sql,*args)
    def commit(self):self.commit_requested=True
    def rollback(self):pass
    def close(self):pass


class AccountAuthority(Authority):
    def __init__(self,db,config,account_ref,life_limits=None,now=clock):
        if not config:raise BudgetDenied('explicit_budget_config_required')
        super().__init__(db,config,now)
        self.account_ref=account_ref;self.life_limits=life_limits or {};self.local=threading.local()
        for value in self.life_limits.values():integer(value)
        if type(config.get('budget_limits_enabled',True)) is not bool:
            raise BudgetDenied('explicit_budget_limit_policy_required')
        if config.get('budget_limits_enabled',True) and config.get('daily_limit_suspended_on'):
            raise BudgetDenied('shared_account_hard_cap_required')
    def connect(self,readonly=False):
        active=getattr(self.local,'view',None)
        return active if active is not None else super().connect(readonly)
    def initialize(self):
        result=super().initialize()  # Explicitly no production/legacy ledger import.
        con=super().connect()
        try:
            con.execute('BEGIN IMMEDIATE')
            con.execute('''CREATE TABLE IF NOT EXISTS attempt_owners(
                attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
                account_ref TEXT NOT NULL,life_id TEXT NOT NULL,session_id TEXT NOT NULL,
                run_id TEXT NOT NULL,request_id TEXT NOT NULL,category TEXT NOT NULL,
                released_before_dispatch INTEGER NOT NULL DEFAULT 0)''')
            con.execute('''CREATE TABLE IF NOT EXISTS owner_audit(
                seq INTEGER PRIMARY KEY,at TEXT NOT NULL,account_ref TEXT NOT NULL,
                life_id TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,
                request_id TEXT NOT NULL,category TEXT NOT NULL,attempt_id TEXT,
                operation TEXT NOT NULL,outcome TEXT NOT NULL,detail_json TEXT NOT NULL)''')
            policy=self.policy_fingerprint()
            old=con.execute("SELECT value FROM meta WHERE key='owner_policy'").fetchone()
            if old and old['value']!=policy:raise BudgetDenied('account_policy_changed_review_required')
            con.execute("INSERT OR IGNORE INTO meta VALUES('owner_policy',?)",(policy,))
            if con.execute('SELECT 1 FROM attempts a LEFT JOIN attempt_owners o USING(attempt_id) WHERE o.attempt_id IS NULL LIMIT 1').fetchone():
                raise BudgetDenied('unowned_attempts_require_explicit_migration')
            con.commit();return result
        except BaseException:con.rollback();raise
        finally:con.close()
    def policy_fingerprint(self):
        return fingerprint({'account_ref':self.account_ref,'config':self.config,'life_limits':self.life_limits})
    def _host_policy(self,owner):
        if owner!={key:'HOST-CONTROL' for key in ('life_id','session_id','run_id','request_id','category')}:
            raise BudgetDenied('host_policy_review_required')
    def policy_status(self,owner):
        self._host_policy(owner);con=super().connect(readonly=True)
        try:
            con.execute('BEGIN');row=con.execute("SELECT value FROM meta WHERE key='owner_policy'").fetchone()
            if not row:raise BudgetDenied('account_policy_not_initialized')
            desired=self.policy_fingerprint();table=con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='policy_change_audit'").fetchone()
            changes=con.execute('SELECT COUNT(*) FROM policy_change_audit').fetchone()[0] if table else 0
            last=con.execute('SELECT * FROM policy_change_audit ORDER BY seq DESC LIMIT 1').fetchone() if table else None
            return {'accountRef':self.account_ref,'currentFingerprint':row['value'],'requestedFingerprint':desired,
                    'matches':row['value']==desired,'budgetLimitsEnabled':self.config.get('budget_limits_enabled',True),
                    'changeCount':changes,'lastChange':dict(last) if last else None}
        finally:con.close()
    def review_policy(self,owner,args):
        self._host_policy(owner)
        expected=args.get('expectedFingerprint');reason=args.get('reason')
        if set(args)!={'expectedFingerprint','reason'} or not isinstance(expected,str) or len(expected)!=64 or any(c not in '0123456789abcdef' for c in expected) or not isinstance(reason,str) or not reason.strip() or len(reason)>1024:
            raise BudgetDenied('explicit_budget_policy_review_required')
        con=super().connect();con.execute('BEGIN IMMEDIATE')
        try:
            row=con.execute("SELECT value FROM meta WHERE key='owner_policy'").fetchone()
            if not row:raise BudgetDenied('account_policy_not_initialized')
            if row['value']!=expected:raise BudgetDenied('account_policy_review_stale')
            if con.execute('SELECT 1 FROM attempts a LEFT JOIN attempt_owners o USING(attempt_id) WHERE o.attempt_id IS NULL LIMIT 1').fetchone():
                raise BudgetDenied('unowned_attempts_require_explicit_migration')
            desired=self.policy_fingerprint()
            if desired==expected:
                con.rollback();return {'reviewed':False,'unchanged':True,'accountRef':self.account_ref,'currentFingerprint':desired}
            con.execute('''CREATE TABLE IF NOT EXISTS policy_change_audit(
                seq INTEGER PRIMARY KEY,at TEXT NOT NULL,account_ref TEXT NOT NULL,
                reviewer TEXT NOT NULL,old_fingerprint TEXT NOT NULL,new_fingerprint TEXT NOT NULL,
                reason TEXT NOT NULL,new_policy_json TEXT NOT NULL)''')
            at=self.now().isoformat()
            con.execute('''INSERT INTO policy_change_audit(at,account_ref,reviewer,old_fingerprint,new_fingerprint,reason,new_policy_json)
              VALUES(?,?,?,?,?,?,?)''',(at,self.account_ref,'HOST-CONTROL',expected,desired,reason,
                  json.dumps({'config':self.config,'life_limits':self.life_limits},sort_keys=True)))
            changed=con.execute("UPDATE meta SET value=? WHERE key='owner_policy' AND value=?",(desired,expected)).rowcount
            if changed!=1:raise BudgetDenied('account_policy_review_stale')
            con.commit();return {'reviewed':True,'accountRef':self.account_ref,'previousFingerprint':expected,
                                'currentFingerprint':desired,'budgetLimitsEnabled':self.config.get('budget_limits_enabled',True),'reviewedAt':at}
        except BaseException:con.rollback();raise
        finally:con.close()
    def _audit(self,con,owner,operation,outcome,attempt_id=None,detail=None):
        con.execute('''INSERT INTO owner_audit(at,account_ref,life_id,session_id,run_id,request_id,category,attempt_id,operation,outcome,detail_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)''',(self.now().isoformat(),self.account_ref,owner['life_id'],owner['session_id'],
          owner['run_id'],owner['request_id'],owner['category'],attempt_id,operation,outcome,json.dumps(detail or {},sort_keys=True)))
    def _atomic(self,owner,operation,attempt_id,fn):
        con=super().connect();con.execute('BEGIN IMMEDIATE');view=TransactionView(con);self.local.view=view
        try:
            result=fn(con)
            self._audit(con,owner,operation,'ok',attempt_id,result);con.commit();return result
        except BudgetDenied as error:
            if not view.commit_requested:con.rollback();con.execute('BEGIN IMMEDIATE')
            # Original Authority deliberately commits unknown/breach before
            # raising. Retain that fail-closed mutation and audit atomically.
            self._audit(con,owner,operation,'denied',attempt_id,{'reason':str(error)});con.commit();raise
        except BaseException:con.rollback();raise
        finally:self.local.view=None;con.close()
    def _owner(self,con,owner,attempt_id):
        row=con.execute('SELECT * FROM attempt_owners WHERE attempt_id=?',(attempt_id,)).fetchone()
        if not row:raise BudgetDenied('attempt_owner_not_found')
        if any(row[key]!=owner[key] for key in ('life_id','session_id','run_id','request_id','category')) or row['account_ref']!=self.account_ref:
            raise BudgetDenied('attempt_owner_mismatch')
        return row
    def _life_totals(self,con,day):
        rows=con.execute('''SELECT a.*,o.life_id,o.category FROM attempts a JOIN attempt_owners o USING(attempt_id)
          WHERE a.start_day<=? AND (a.end_day IS NULL OR a.end_day>=?)''',(day,day)).fetchall()
        lives={};categories={}
        for row in rows:
            charged=row['charged'] or 0 if row['state'] in ('settled','accounted_upper') else 0
            held=0 if row['state'] in ('settled','accounted_upper') else row['reserved']
            for target,key in ((lives,row['life_id']),(categories,row['category'])):
                value=target.setdefault(key,{'settled':0,'unsettled_reservations':0,'attempts':0})
                value['settled']+=charged;value['unsettled_reservations']+=held;value['attempts']+=1
        return lives,categories
    def reserve_owned(self,owner,args):
        def apply(con):
            requested=dict(args)
            life_limit=self.life_limits.get(owner['life_id'])
            if life_limit is not None and self.config.get('budget_limits_enabled',True):
                totals,_=self._life_totals(con,self.now().date().isoformat())
                row=totals.get(owner['life_id'],{'settled':0,'unsettled_reservations':0})
                available=life_limit-row['settled']-row['unsettled_reservations']
                prices=self.config['peak_nano_cny_per_token']
                output_cap=(available-self.config['input_bound_tokens']*prices['miss'])//prices['output']
                if output_cap<self.config['min_output_tokens']:raise BudgetDenied('life_budget_exhausted')
                requested['max_tokens']=min(requested['max_tokens'],output_cap)
            result=super(AccountAuthority,self).reserve(requested)
            con.execute('''INSERT INTO attempt_owners(attempt_id,account_ref,life_id,session_id,run_id,request_id,category)
              VALUES(?,?,?,?,?,?,?)''',(args['attempt_id'],self.account_ref,owner['life_id'],owner['session_id'],owner['run_id'],owner['request_id'],owner['category']))
            con.execute("UPDATE attempts SET state='reserved' WHERE attempt_id=?",(args['attempt_id'],))
            return {**result,'account_ref':self.account_ref,'life_id':owner['life_id'],'state':'reserved'}
        return self._atomic(owner,'reserve',args['attempt_id'],apply)
    def bind_owned(self,owner,args):
        def apply(con):
            self._owner(con,owner,args['attempt_id'])
            row=con.execute('SELECT state FROM attempts WHERE attempt_id=?',(args['attempt_id'],)).fetchone()
            if row['state']!='reserved':raise BudgetDenied('attempt_not_reserved')
            con.execute("UPDATE attempts SET state='sent' WHERE attempt_id=?",(args['attempt_id'],))
            return super(AccountAuthority,self).bind(args)
        return self._atomic(owner,'bind',args['attempt_id'],apply)
    def settle_owned(self,owner,args):
        def apply(con):
            ownership=self._owner(con,owner,args['attempt_id'])
            if ownership['released_before_dispatch']:raise BudgetDenied('released_attempt_has_no_provider_usage')
            row=con.execute('SELECT state FROM attempts WHERE attempt_id=?',(args['attempt_id'],)).fetchone()
            if row['state']=='reserved':raise BudgetDenied('undispatched_attempt_has_no_provider_usage')
            return super(AccountAuthority,self).settle(args)
        return self._atomic(owner,'settle',args['attempt_id'],apply)
    def unknown_owned(self,owner,args):
        def apply(con):
            self._owner(con,owner,args['attempt_id'])
            return super(AccountAuthority,self).unknown(args['attempt_id'],args.get('reason','missing_or_ambiguous_usage'))
        return self._atomic(owner,'unknown',args['attempt_id'],apply)
    def release_owned(self,owner,args):
        def apply(con):
            ownership=self._owner(con,owner,args['attempt_id'])
            if ownership['released_before_dispatch']:return {'released':True,'duplicate':True}
            row=con.execute('SELECT * FROM attempts WHERE attempt_id=?',(args['attempt_id'],)).fetchone()
            if row['state']!='reserved' or row['wire_hash'] is not None:raise BudgetDenied('dispatched_or_unknown_reservation_cannot_release')
            con.execute("UPDATE attempts SET state='settled',end_day=?,charged=0,calculated=0,reason='released_before_dispatch',settled_at=? WHERE attempt_id=?",
                (max(row['start_day'],self.now().date().isoformat()),self.now().isoformat(),args['attempt_id']))
            con.execute('UPDATE attempt_owners SET released_before_dispatch=1 WHERE attempt_id=?',(args['attempt_id'],))
            return {'released':True,'released_reservation':row['reserved'],'provider_called':False,'actual_usage_known':False}
        return self._atomic(owner,'release',args['attempt_id'],apply)
    def status_owned(self,owner):
        con=super().connect(readonly=True)
        try:
            con.execute('BEGIN');day=self.now().date().isoformat();account=super()._status(con,day);lives,categories=self._life_totals(con,day)
            if sum(row['settled'] for row in lives.values())!=account['settled'] or sum(row['unsettled_reservations'] for row in lives.values())!=account['unsettled_reservations']:
                raise BudgetDenied('account_owner_sum_mismatch')
            own=lives.get(owner['life_id'],{'settled':0,'unsettled_reservations':0,'attempts':0})
            limit=self.life_limits.get(owner['life_id'])
            enforced=self.config.get('budget_limits_enabled',True) and limit is not None
            usage_rows=con.execute('''SELECT a.state,a.hit,a.miss,a.output FROM attempts a JOIN attempt_owners o USING(attempt_id)
              WHERE a.start_day=? AND o.life_id=?''',(day,owner['life_id'])).fetchall()
            known=[row for row in usage_rows if row['state']=='settled' and all(row[key] is not None for key in ('hit','miss','output'))]
            hit=sum(row['hit'] for row in known);miss=sum(row['miss'] for row in known)
            usage={'day':day,'day_basis':'request_start_day','known_requests':len(known),
              'prompt_cache_hit_tokens':hit,'prompt_cache_miss_tokens':miss,'input_tokens':hit+miss,
              'output_tokens':sum(row['output'] for row in known),'cache_hit_rate':hit/(hit+miss) if hit+miss else None,
              'cache_coverage_complete':not any(row['state'] not in ('settled',) for row in usage_rows),
              'cost_kind':'local_known_usage_price_estimate_not_provider_debit'}
            return {'account_ref':self.account_ref,'account':account,'life_id':owner['life_id'],'life':{**own,'usage':usage,'limit':limit,'limit_enforced':enforced,
                'available_kind':'enforced_remaining' if enforced else 'reference_only_limits_disabled' if not self.config.get('budget_limits_enabled',True) else 'no_life_limit',
                'available':max(0,limit-own['settled']-own['unsettled_reservations']) if limit is not None else None},
                'owner_sums_verified':True,'by_life':lives,'by_category':categories}
        finally:con.close()
    def audit_owned(self,owner,offset=0,limit=100):
        offset=integer(offset);limit=integer(limit)
        if not 1<=limit<=500:raise BudgetDenied('audit_page_limit_invalid')
        con=super().connect(readonly=True)
        try:
            rows=con.execute('SELECT * FROM owner_audit WHERE life_id=? ORDER BY seq LIMIT ? OFFSET ?',(owner['life_id'],limit+1,offset)).fetchall()
            return {'rows':[dict(row) for row in rows[:limit]],'next_offset':offset+limit if len(rows)>limit else None,'account_ref':self.account_ref}
        finally:con.close()


def main():
    request=json.loads(sys.stdin.read(1024*1024));owner=request['owner']
    now=(lambda:datetime.fromisoformat(request['fixtureNow']).astimezone(SHANGHAI)) if request.get('fixtureNow') else clock
    authority=AccountAuthority(request['db'],request['config'],request['accountRef'],request.get('lifeLimits'),now)
    operation=request['operation'];args=request.get('arguments',{})
    if operation=='policy_status':return {'result':authority.policy_status(owner)}
    if operation=='review_policy':return {'result':authority.review_policy(owner,args)}
    authority.initialize()
    if operation=='status':result=authority.status_owned(owner)
    elif operation=='audit':result=authority.audit_owned(owner,**args)
    else:result=getattr(authority,operation+'_owned')(owner,args)
    return {'result':result}


if __name__=='__main__':
    try:print(json.dumps(main()))
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,BudgetDenied) else 'BUDGET_AUTHORITY_FAILED:'+type(error).__name__,'retryable':False}));sys.exit(2)
