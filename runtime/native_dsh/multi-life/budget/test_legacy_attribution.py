from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

guard=Path(__file__).resolve().parents[3]/'budget_guard'
spec=importlib.util.spec_from_file_location('legacy_authority',guard/'authority.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class LegacyAttributionTests(unittest.TestCase):
    def test_existing_ledger_adds_attribution_only_on_new_request_and_preserves_old_unknown(self):
        with tempfile.TemporaryDirectory(prefix='TEST-ONLY-legacy-cost-') as root:
            config=json.loads((guard/'config.json').read_text(encoding='utf-8'));config['budget_limits_enabled']=False
            authority=module.Authority(Path(root)/'budget.sqlite3',config,lambda:datetime(2026,10,6,20,tzinfo=module.SHANGHAI));authority.initialize()
            def reserve(identifier,attribution=None):
                return authority.reserve(dict(attempt_id=identifier,request_id='TEST-rpc',session_id='TEST-session',purpose='agent-loop',payload_hash='TEST-hash',provider=config['provider'],model=config['model'],max_tokens=256,owner_pid=os.getpid(),**({'attribution':attribution} if attribution else {})))
            reserve('TEST-old')
            con=authority.connect();con.execute('DROP TABLE request_attribution');con.commit();con.close()
            reserve('TEST-new',dict(life_id='life-TEST-legacy',run_id='TEST-session:turn:9',source_kind='host-notice',reason='developer_test',provenance='trusted_native_source'))
            con=authority.connect(readonly=True)
            try:
                self.assertEqual(con.execute('SELECT COUNT(*) FROM attempts').fetchone()[0],2)
                rows=con.execute('SELECT * FROM request_attribution').fetchall();self.assertEqual(len(rows),1)
                self.assertEqual(rows[0]['attempt_id'],'TEST-new');self.assertEqual(rows[0]['life_id'],'life-TEST-legacy')
                self.assertEqual(rows[0]['reason'],'developer_test')
            finally:con.close()

if __name__=='__main__':unittest.main()
