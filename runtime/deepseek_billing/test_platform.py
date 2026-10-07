import unittest
from datetime import datetime, timezone
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('billing_platform', Path(__file__).with_name('official_platform.py'))
billing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(billing)


class PreflightTests(unittest.TestCase):
    def test_http_success_does_not_mask_invalid_authentication(self):
        result = billing.response_evidence({'code':40003,'msg':'TEST_ONLY_SECRET','data':None},200)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'PLATFORM_AUTHENTICATION_INVALID')
        self.assertNotIn('TEST_ONLY_SECRET',str(result))

    def test_unverified_schema_never_becomes_billing_success(self):
        result = billing.response_evidence({'code':0,'data':{'unexpected':[]}},200)
        self.assertFalse(result['ok'])
        self.assertFalse(result['authenticated_billing_verified'])

    def test_beijing_midnight(self):
        before = billing.today_window(datetime(2026, 10, 6, 15, 59, 59, tzinfo=timezone.utc))
        after = billing.today_window(datetime(2026, 10, 6, 16, 0, 0, tzinfo=timezone.utc))
        self.assertEqual(after['start']-before['start'], 86400)
        self.assertEqual(after['start'], after['end'])
        self.assertEqual(after['tz'], 28800)

    def test_shape_never_returns_secret_values(self):
        secret = 'TEST_ONLY_SECRET'
        self.assertNotIn(secret, str(billing.shape({'token':secret,'series':[{'cost':'0.001'}]})))

    def test_preflight_only_describes(self):
        calls = []
        def operation(action, name):
            calls.append(action)
            return {'configured': False}
        result = billing.preflight(operation)
        self.assertEqual(calls, ['describe'])
        self.assertFalse(result['credential_configured'])


if __name__ == '__main__':
    unittest.main()
