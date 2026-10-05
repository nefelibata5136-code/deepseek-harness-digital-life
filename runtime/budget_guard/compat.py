"""A-owned shared-file shim: one ledger, read-only legacy status compatibility."""
from .authority import Authority, BudgetDenied

def money(value):
    return f'{value//1_000_000_000}.{value%1_000_000_000:09d}'

def summary():
    value=Authority().status()
    value['cny']={key:money(value[key]) for key in ('daily_limit','settled','unsettled_reservations','available','calculated_official_price_cost')}
    value['calculated_cost_cny']=money(value['calculated_official_price_cost'])
    value['daily_target_cny']=money(value['daily_limit'])
    value['model']='deepseek-flash'
    value['provider']='deepseek-official'
    return value

def budget_check(arguments=None):
    # Informational preflight only. Every actual HTTP call must reserve via gate.
    value=summary()
    value['allowed']=value['stop_reason'] is None
    value['reason']=value['stop_reason']
    return value

def usage_start(arguments):
    raise BudgetDenied('legacy_usage_start_disabled_use_wire_gate')

def record_usage(arguments):
    raise BudgetDenied('legacy_usage_writer_disabled_use_wire_gate')
