import unittest
from qwen import Qwen

class Transport:
    def __init__(self,payload,ok=True):self.payload=payload;self.ok=ok;self.calls=0
    def embed(self,*args):self.calls+=1;return {'ok':self.ok,'status_code':200 if self.ok else 500,'operation':'embedding','request_id':'test-id','payload':self.payload}
    def rerank(self,*args):self.calls+=1;return {'ok':self.ok,'status_code':200 if self.ok else 500,'operation':'rerank','request_id':'test-id','payload':self.payload}

def client(payload,ok=True):
    q=Qwen.__new__(Qwen);q.config={'embedding_model':'http-fixture','rerank_model':'http-fixture','dimension':2};q.key_source='test-not-a-key';q.records=[];q.audit=q.records.append;q.client=Transport(payload,ok);return q

class Tests(unittest.TestCase):
    def test_embedding_complete_unique_finite_nonzero(self):
        q=client({'data':[{'index':1,'embedding':[2,3]},{'index':0,'embedding':[1,2]}]})
        self.assertEqual(q.embed(['a','b']),[[1,2],[2,3]])
        for vectors in ([{'index':0,'embedding':[1,2]},{'index':0,'embedding':[2,3]}], [{'index':0,'embedding':[0,0]}], [{'index':0,'embedding':[float('nan'),1]}]):
            with self.assertRaises(ValueError):client({'data':vectors}).embed(['a','b'] if len(vectors)==2 else ['a'])
    def test_rerank_must_be_complete_unique_finite(self):
        for rows in ([{'index':0,'relevance_score':.5},{'index':0,'relevance_score':.4}], [{'index':0,'relevance_score':.5}], [{'index':0,'relevance_score':float('inf')},{'index':1,'relevance_score':.4}]):
            with self.assertRaises(ValueError):client({'results':rows}).rerank('query',['a','b'])
    def test_credentials_and_oversized_input_rejected_before_http(self):
        q=client({})
        for text in ('sk-'+'a'*40,'字'*1400):
            with self.assertRaises(ValueError):q.embed([text])
        self.assertEqual(q.client.calls,0)
    def test_failed_http_audited_without_retry_or_raw_text(self):
        q=client({},False)
        with self.assertRaises(RuntimeError):q.embed(['private-entrance-text'])
        self.assertEqual(q.client.calls,1);self.assertEqual(len(q.records),1)
        self.assertNotIn('private-entrance-text',str(q.records));self.assertEqual(q.records[0]['status_code'],500)

if __name__=='__main__':unittest.main()
