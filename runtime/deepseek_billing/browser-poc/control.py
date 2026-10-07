"""Reuse the existing owned-Chrome lifecycle with a separate billing identity."""
import importlib.util
import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('owned_chrome', HERE.parents[1] / 'browser/browser_control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
root = Path(os.environ['LOCALAPPDATA']) / 'PersonaHost/DeepSeekBillingBrowser'
control.CONFIG = {**control.CONFIG, 'private_root': str(root),
                  'profile': str(root / 'deepseek-billing-profile'), 'cdp_port': 18746}
control.ROOT = root
control.PROFILE = root / 'deepseek-billing-profile'
control.ENDPOINT = 'http://127.0.0.1:18746'

try:
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if action == 'open':
        control.ensure()
    elif action == 'stop':
        control.stop()
    elif action != 'status':
        raise ValueError()
    state=control.status()
    import win32gui, win32process
    foreground_pid=win32process.GetWindowThreadProcessId(win32gui.GetForegroundWindow())[1]
    state['foreground_is_dedicated_browser']=foreground_pid in {p.pid for p in control.owned_processes()}
    print(json.dumps(state))
except Exception:
    print(json.dumps({'error': 'BILLING_BROWSER_LIFECYCLE_FAILED'}))
    sys.exit(1)
