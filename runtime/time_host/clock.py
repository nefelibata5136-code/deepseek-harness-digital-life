"""Runtime clock for A's Python migration letter; no cached date or tzdata dependency."""
import json
import time
from datetime import datetime, timezone, timedelta

TIME_ZONE = 'Asia/Shanghai'
SHANGHAI = timezone(timedelta(hours=8), TIME_ZONE)

def current_time():
    sampled = time.time_ns() // 1_000_000
    instant = datetime.fromtimestamp(sampled / 1000, timezone.utc)
    return {'epochMs': sampled, 'utc': instant.isoformat(timespec='milliseconds'),
            'local': instant.astimezone(SHANGHAI).isoformat(timespec='seconds'),
            'timeZone': TIME_ZONE, 'source': 'OS system clock'}

if __name__ == '__main__':
    print(json.dumps(current_time(), ensure_ascii=True, indent=2))
