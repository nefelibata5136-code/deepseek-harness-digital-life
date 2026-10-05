"""Build only C's isolated D-authority ledgers; do not import formal usage."""
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'budget_guard'))
from authority import Authority

authority = Authority(sys.argv[1])
authority.initialize()
if sys.argv[2] == 'unknown':
    authority.reserve(dict(attempt_id='c-test-unknown', request_id='c-test', session_id='c-test',
        purpose='schedule', payload_hash='c-technical-fake-payload', provider='deepseek-official',
        model='deepseek-flash', max_tokens=16384, owner_pid=os.getpid()))
    authority.unknown('c-test-unknown', 'C isolated unknown-usage fixture')
print('isolated_fixture_ready')
