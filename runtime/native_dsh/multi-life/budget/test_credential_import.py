import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('intake', Path(__file__).with_name('credential-import.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class IntakeTests(unittest.TestCase):
    def test_check_import_clear_and_no_secret_in_result(self):
        with tempfile.TemporaryDirectory(prefix='TEST-ONLY-life-credential-') as root:
            path = Path(root)/'keys.json'; lives = {'life-TEST-A': module.reference('life-TEST-A'), 'life-TEST-B': module.reference('life-TEST-B')}
            keys = ['sk-TEST-ONLY-A-1234567890', 'sk-TEST-ONLY-B-1234567890']; store = {}
            rows = [dict(life_id=life, host_ref=ref, api_key=key) for (life,ref),key in zip(lives.items(),keys)]
            path.write_text(json.dumps({'schemaVersion':1,'credentials':rows}), encoding='utf-8')
            def broker(action, ref, value=None):
                if action == 'set': store[ref] = value
                return dict(configured=ref in store)
            before = path.read_bytes(); checked = module.intake(path,lives,broker)
            self.assertTrue(checked['intake_ready']); self.assertEqual(before,path.read_bytes()); self.assertFalse(store)
            result = module.intake(path,lives,broker,True)
            self.assertTrue(result['intake_cleared']); self.assertEqual(list(store.values()),keys)
            self.assertTrue(all(row['api_key']=='' for row in json.loads(path.read_text())['credentials']))
            self.assertFalse(any(key in json.dumps(result) for key in keys))
    def test_invalid_identity_duplicate_keys_and_partial_failure_retain_intake(self):
        with tempfile.TemporaryDirectory(prefix='TEST-ONLY-life-credential-') as root:
            path=Path(root)/'keys.json'; lives={'life-TEST-A':module.reference('life-TEST-A'),'life-TEST-B':module.reference('life-TEST-B')}
            rows=[dict(life_id=life,host_ref=ref,api_key='sk-TEST-ONLY-SAME-1234567890') for life,ref in lives.items()]
            def save():path.write_text(json.dumps({'schemaVersion':1,'credentials':rows}),encoding='utf-8')
            save(); before=path.read_bytes()
            with self.assertRaisesRegex(module.IntakeError,'DISTINCT'):module.intake(path,lives,lambda *_:{'configured':False},True)
            self.assertEqual(path.read_bytes(),before)
            rows[1]['host_ref']=rows[0]['host_ref']; save()
            with self.assertRaisesRegex(module.IntakeError,'MISMATCH'):module.intake(path,lives,lambda *_:{'configured':False},True)
            rows[1]['host_ref']=lives['life-TEST-B']; rows[1]['api_key']='sk-TEST-ONLY-B-1234567890';save();before=path.read_bytes()
            def failed(action, ref, value=None):
                if action=='set' and ref==lives['life-TEST-B']:raise RuntimeError('synthetic-secret-must-not-escape')
                return {'configured':action=='set'}
            with self.assertRaises(RuntimeError):module.intake(path,lives,failed,True)
            self.assertEqual(path.read_bytes(),before)
    def test_concurrent_intake_edit_keeps_new_file(self):
        with tempfile.TemporaryDirectory(prefix='TEST-ONLY-life-credential-') as root:
            path=Path(root)/'keys.json';lives={'life-TEST-A':module.reference('life-TEST-A')}
            path.write_text(json.dumps({'schemaVersion':1,'credentials':[dict(life_id='life-TEST-A',host_ref=lives['life-TEST-A'],api_key='sk-TEST-ONLY-A-1234567890')]}))
            def broker(action,ref,value=None):
                if action=='set':path.write_text('new user content')
                return {'configured':True}
            with self.assertRaisesRegex(module.IntakeError,'CHANGED'):module.intake(path,lives,broker,True)
            self.assertEqual(path.read_text(),'new user content')
    def test_clear_stored_compares_exactly_without_setting_again(self):
        with tempfile.TemporaryDirectory(prefix='TEST-ONLY-life-credential-') as root:
            path=Path(root)/'keys.json';lives={'life-TEST-A':module.reference('life-TEST-A')};key='sk-TEST-ONLY-A-1234567890'
            path.write_text(json.dumps({'schemaVersion':1,'credentials':[dict(life_id='life-TEST-A',host_ref=lives['life-TEST-A'],api_key=key)]}))
            before=path.read_bytes()
            def wrong(action,ref,value=None):
                self.assertNotEqual(action,'set')
                return {'configured':True,'value':'TEST different credential'}
            with self.assertRaisesRegex(module.IntakeError,'STORED_CREDENTIAL_MISMATCH'):module.intake(path,lives,wrong,clear_stored=True)
            self.assertEqual(path.read_bytes(),before)
            def matching(action,ref,value=None):
                self.assertNotEqual(action,'set')
                return {'configured':True,'value':key}
            result=module.intake(path,lives,matching,clear_stored=True)
            self.assertTrue(result['intake_cleared']);self.assertEqual(result['action'],'clear-stored')
            self.assertNotIn(key,json.dumps(result));self.assertNotIn(key,path.read_text())

if __name__=='__main__':unittest.main()
