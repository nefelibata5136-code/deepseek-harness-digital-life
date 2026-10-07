"""Host-only official billing preflight; no secret or raw response output."""
import argparse
from datetime import datetime, timezone, timedelta
import importlib.util
import json
import os
from pathlib import Path
import urllib.request
import urllib.error

ENDPOINT = 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost'
REFERENCE = 'DL_DEEPSEEK_PLATFORM_TOKEN'
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
              'AppleWebKit/537.36 (KHTML, like Gecko) '
              'Chrome/130.0.0.0 Safari/537.36')
HERE = Path(__file__).resolve().parent


def broker():
    path = HERE.parent / 'native_dsh/capabilities/credentials.py'
    spec = importlib.util.spec_from_file_location('billing_credentials', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.operation


def today_window(now=None):
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(timezone(timedelta(hours=8)))
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return dict(start=int(start.timestamp()), end=int(now.timestamp()), tz=28800)


def shape(value, depth=0):
    # Structural evidence only; even unexpected response strings are discarded.
    if depth > 10:
        return 'depth_limit'
    if isinstance(value, dict):
        return {key: shape(item, depth+1) for key, item in value.items()
                if isinstance(key, str) and len(key) <= 64 and
                all(c.isalnum() or c in '_-' for c in key)}
    if isinstance(value, list):
        return {'type': 'array', 'length': len(value),
                'item_shapes': [shape(item, depth+1) for item in value[:3]]}
    return type(value).__name__


def preflight(operation=None):
    operation = operation or broker()
    return {'credential_ref': REFERENCE,
            'credential_configured': bool(operation('describe', REFERENCE).get('configured')),
            'host_environment_available': bool(os.getenv('DEEPSEEK_PLATFORM_TOKEN')),
            'source': 'deepseek_platform', 'window': today_window(),
            'secret_values_returned': False}


def response_evidence(value, http_status):
    result = {'ok': False, 'http_status': http_status,
              'response_shape': shape(value), 'authenticated_billing_verified': False}
    if not isinstance(value, dict):
        return {**result, 'error': 'BILLING_ENVELOPE_UNVERIFIED'}
    code = value.get('code')
    # Only integer codes can escape; never propagate the platform error message.
    if type(code) is int:
        result['business_code'] = code
    if code == 40003:
        return {**result, 'error': 'PLATFORM_AUTHENTICATION_INVALID'}
    if value.get('data') is None:
        return {**result, 'error': 'BILLING_DATA_UNAVAILABLE'}
    return {**result, 'error': 'BILLING_SCHEMA_REQUIRES_VERIFICATION'}


def probe(operation=None, opener=None):
    operation = operation or broker()
    credential = operation('resolve', REFERENCE)
    token = (credential or {}).get('value') or os.getenv('DEEPSEEK_PLATFORM_TOKEN')
    if not token:
        return {'ok': False, 'error': 'PLATFORM_CREDENTIAL_REQUIRED'}
    from urllib.parse import urlencode
    request = urllib.request.Request(ENDPOINT+'?'+urlencode(today_window()),
        headers={'Authorization': 'Bearer '+token, 'Accept': 'application/json',
                 'User-Agent': USER_AGENT, 'Referer': 'https://platform.deepseek.com/usage'}, method='GET')
    # Forbid redirects so authentication never crosses hosts.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = opener or urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            raw = response.read(4*1024*1024+1)
            if len(raw) > 4*1024*1024:
                return {'ok': False, 'error': 'BILLING_RESPONSE_TOO_LARGE'}
            value = json.loads(raw)
            return response_evidence(value, response.status)
    except urllib.error.HTTPError as error:
        return {'ok': False, 'http_status': error.code, 'error': 'PLATFORM_HTTP_FAILURE'}
    except Exception:
        return {'ok': False, 'error': 'PLATFORM_QUERY_FAILED'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(probe() if args.probe else preflight(), ensure_ascii=False))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'BILLING_PREFLIGHT_FAILED'}))
