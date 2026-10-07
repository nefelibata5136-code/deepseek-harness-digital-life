"""Move the official OAuth Copy-button clipboard into the existing broker.

No browser storage, secret command arguments, files, logs or credential output.
"""
import importlib.util
import json
import sys
import win32clipboard
from configure_slack import api, CREDENTIALS, WORKSPACE_ID

try:
    kind = sys.argv[1]
    expected = {'user': ('xoxp-', 'DL_DOTS_SLACK_USER_TOKEN', 'UNCONFIGURED_ACCOUNT'),
                'bot': ('xoxb-', 'DL_DOTS_SLACK_TOKEN', 'UNCONFIGURED_ACCOUNT')}[kind]
    win32clipboard.OpenClipboard()
    try:
        value = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT).strip()
        win32clipboard.EmptyClipboard()
    finally:
        win32clipboard.CloseClipboard()
    if not value.startswith(expected[0]):
        raise ValueError('UNEXPECTED_OAUTH_TOKEN_TYPE')
    auth = api(value, 'auth.test', {})
    if auth.get('team_id') != WORKSPACE_ID or auth.get('user_id') != expected[2]:
        raise ValueError('OAUTH_IDENTITY_MISMATCH')
    spec = importlib.util.spec_from_file_location('broker', CREDENTIALS)
    broker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(broker)
    broker.operation('set', expected[1], value)
    value = None
    print(json.dumps({'ok': True, 'reference': expected[1], 'team_id': auth['team_id'],
                      'user_id': auth['user_id'], 'source': 'official-oauth-copy-button'}))
except Exception:
    print(json.dumps({'ok': False, 'code': 'OAUTH_CAPTURE_OR_VALIDATION_FAILED'}))
    sys.exit(1)
