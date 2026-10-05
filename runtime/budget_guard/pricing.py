"""Reporting prices; budget reservations remain conservative and independent."""
from datetime import datetime, timedelta
from .authority import SHANGHAI

# State Council 2026 notice, verified 2026-10-04:
# https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html
HOLIDAYS = (("2026-01-01", "2026-01-03"), ("2026-02-15", "2026-02-23"),
            ("2026-04-04", "2026-04-06"), ("2026-05-01", "2026-05-05"),
            ("2026-06-19", "2026-06-21"), ("2026-09-25", "2026-09-27"),
            ("2026-10-01", "2026-10-07"))

def band(moment):
    local = moment.astimezone(SHANGHAI)
    day = local.date().isoformat()
    if local.weekday() >= 5 or any(first <= day <= last for first, last in HOLIDAYS):
        return 'offpeak'
    # Future calendars must be checked; do not silently price a holiday at peak.
    if local.year != 2026:
        return None
    return 'peak' if 9 <= local.hour < 12 or 14 <= local.hour < 18 else 'offpeak'

def cost_bounds(row):
    """Use captured rates and a full request interval; boundaries yield a range."""
    import json
    prices = json.loads(row['price_json'])
    def cost(rates):
        return row['miss'] * rates['miss'] + row['hit'] * rates['hit'] + row['output'] * rates['output']
    low, high = cost(prices['offpeak']), cost(prices)
    try:
        start = datetime.fromisoformat(row['started_at'])
        end = datetime.fromisoformat(row['settled_at'])
        if start.tzinfo is None or end.tzinfo is None or end < start:
            return low, high
        bands = {band(start), band(end)}
        cursor = start.astimezone(SHANGHAI).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        while cursor < end and len(bands) == 1:
            bands.add(band(cursor))
            cursor += timedelta(hours=1)
        if bands == {'offpeak'}:
            return low, low
        if bands == {'peak'}:
            return high, high
    except (ValueError, TypeError):
        pass
    return low, high
