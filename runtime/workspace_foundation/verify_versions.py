"""Independent destructive fixtures only. Run by verify.mjs with a fresh reports/task_B folder."""
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
from snapshots import Versions, now


def verify(root):
    root = Path(root).absolute()
    ws, store = root / 'workspace', root / 'versions'
    ws.mkdir(parents=True, exist_ok=False)
    (ws / 'note.txt').write_bytes(b'baseline\r\n')
    (ws / 'rename.txt').write_bytes(b'rename content')
    (ws / 'delete.txt').write_bytes(b'delete content')
    (ws / '.env').write_bytes(b'DUMMY=exclude')
    (ws / 'secret.txt').write_bytes(b'api_key=' + b'X' * 24)
    (ws / '.gitignore').write_text('note.txt\n', encoding='utf-8')
    v = Versions(ws, store)
    baseline = v.snapshot('initial-baseline')
    assert baseline['files'] == 4  # .gitignore cannot override protected capture policy
    assert v.status()['changes'] == []
    (ws / 'note.txt').write_bytes(b'existing unsaved change')
    start = v.begin('technical-session', '1', os.getpid())
    assert start['new_commit']
    try:
        v.begin('concurrent', '1', os.getpid())
        raise AssertionError('live-turn concurrency accepted')
    except RuntimeError:
        pass
    (ws / 'note.txt').write_bytes(b'file tool equivalent')
    (ws / 'rename.txt').rename(ws / 'renamed.txt')
    (ws / 'delete.txt').unlink()
    (ws / 'new.bin').write_bytes(bytes(range(256)))
    finish = v.end(start['token'])
    diff = v.git('diff', '--name-status', baseline['commit'], finish['commit']).stdout.decode()
    assert 'renamed.txt' in diff and 'delete.txt' in diff and 'new.bin' in diff
    before_restore = v.head()
    plan = v.restore(baseline['commit'], 'note.txt')
    assert plan['dry_run'] and (ws / 'note.txt').read_bytes() == b'file tool equivalent'
    restored = v.restore(baseline['commit'], 'note.txt', True)
    assert (ws / 'note.txt').read_bytes() == b'baseline\r\n'
    assert restored['after']['new_commit']
    v.git('merge-base', '--is-ancestor', before_restore, v.head())
    full = v.restore(baseline['commit'], apply=True)
    assert (ws / 'rename.txt').is_file() and (ws / 'delete.txt').is_file()
    assert not (ws / 'renamed.txt').exists() and not (ws / 'new.bin').exists()
    assert (ws / '.env').read_bytes() == b'DUMMY=exclude'
    assert (ws / 'secret.txt').read_bytes() == b'api_key=' + b'X' * 24
    worker = Path(__file__).with_name('crash_fixture.py')
    crashed = subprocess.run([sys.executable, '-B', str(worker), str(ws), str(store)], capture_output=True)
    assert crashed.returncode == 23
    assert (store / 'active-turn.json').is_file()
    resumed = v.recover()
    assert resumed['recovered_interruption']
    assert v.git('show', resumed['commit'] + ':interrupted.txt').stdout == b'left behind after abrupt exit'
    next_turn = v.begin('technical-session-resumed', '1', os.getpid())
    v.end(next_turn['token'])
    assert not (store / 'active-turn.json').exists()
    try:
        v.restore(baseline['commit'], '../outside.txt', True)
        raise AssertionError('traversal accepted')
    except ValueError:
        pass
    # Explicit restore remains available even if the free workspace was removed.
    assert ws.is_relative_to(root) and ws != root
    shutil.rmtree(ws)
    missing_plan = v.restore(baseline['commit'])
    assert missing_plan['dry_run'] and not ws.exists()
    v.restore(baseline['commit'], apply=True)
    assert (ws / 'note.txt').read_bytes() == b'baseline\r\n'
    v.git('fsck', '--full')
    return {'observed_at': now(), 'baseline': baseline, 'pre_turn': start, 'post_turn': finish,
            'diff_name_status': diff, 'file_restore': restored, 'full_restore': full,
            'interruption_recovery': resumed, 'checks': ['baseline', 'preexisting-change',
            'live-turn-conflict', 'rename', 'delete', 'binary', 'ignore-cannot-disable',
            'credential-exclusions', 'file-restore-dry-run', 'file-restore-append-history',
            'full-version-restore', 'abrupt-exit-next-start-preserves', 'traversal-denied',
            'deleted-workspace-explicit-restore', 'git-fsck']}


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1]), ensure_ascii=False, indent=2))
