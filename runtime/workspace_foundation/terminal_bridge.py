"""Thin transport over the existing Windows restricted terminal, no duplicate file tools.

Workspace comes from trusted controller arguments, never from model tool input.
Native tools/execute lifecycle owns versions; legacy session directory copies are not used.
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from windows_terminal import run


def run_bound(request, workspace):
    if set(request) - {'command', 'timeout'}:
        raise ValueError('Only command and timeout accepted from tool input')
    command = request['command']
    timeout = request.get('timeout', 30)
    if not isinstance(command, str) or not command or len(command) > 32768:
        raise ValueError('Invalid terminal command')
    if not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120:
        raise ValueError('Terminal timeout must be 1..120 seconds')
    return run(command, workspace, timeout)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', default='.local/workspace')
    args = parser.parse_args()
    print(json.dumps(run_bound(json.load(sys.stdin), args.workspace), ensure_ascii=False))
