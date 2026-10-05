"""Guard and audit the reused Qwen transport. Inputs are memory entrances only."""
from __future__ import annotations
import hashlib
import json
import math
import os
import re
from pathlib import Path
from qwen_legacy import ApiClient, parse_embeddings, parse_rerank, resolve_api_key

SECRET=re.compile(r'(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|(?i:(?:api[_-]?key|password|cookie|authorization)\s*[=:]\s*[\"\']?[^\s\"\']{8,})')
def hash_text(text):return hashlib.sha256(text.encode('utf-8')).hexdigest()
def safe_text(text):
    if not isinstance(text,str) or not text.strip():raise ValueError('Nonempty text required')
    if SECRET.search(text):raise ValueError('Credential-like content must remain local for review')
    return text

class Qwen:
    def __init__(self, config, audit):
        self.config=config
        self.audit=audit
        key=os.environ.get('DASHSCOPE_API_KEY')
        if key:self.key_source='capability-reference-or-process'
        else:key,self.key_source=resolve_api_key()
        if not key:raise RuntimeError('DASHSCOPE_API_KEY unavailable; no request made')
        self.client=ApiClient(key,config['workspace_id'],config.get('timeout',20),0,.15,False)

    def _call(self, op, texts, callback):
        for text in texts:
            safe_text(text)
            # UTF-8 bytes upper-bound ordinary text tokens. Reject an oversized
            # entrance; never split or silently truncate the event or source.
            if len(text.encode('utf-8'))>4000:raise ValueError('Entrance/query exceeds conservative API bound; revise semantic entrance, no automatic slicing')
        result=callback()
        record={k:result.get(k) for k in ('ok','status_code','request_id','attempts','latency_ms','operation','code')}
        record.update({'model':self.config['embedding_model'] if op=='embedding' else self.config['rerank_model'],
                       'input_hashes':[hash_text(t) for t in texts],'key_source':self.key_source,
                       'usage':result.get('payload',{}).get('usage'),'account_debit_verified':False})
        self.audit(record)
        if not result.get('ok'):raise RuntimeError('Qwen request failed: '+str(result.get('status_code'))+' '+str(result.get('code'))+'; inspect request audit; no automatic retry')
        return result['payload']

    def embed(self,texts):
        if not 1<=len(texts)<=10:raise ValueError('Embedding batch must have 1..10 entrances')
        payload=self._call('embedding',texts,lambda:self.client.embed(texts,self.config['embedding_model'],self.config['dimension']))
        raw=payload.get('data',payload.get('output',{}).get('embeddings',[]))
        indices=[r.get('index',r.get('text_index',i)) for i,r in enumerate(raw)]
        if len(set(indices))!=len(texts):raise ValueError('Duplicate/missing embedding indices')
        vectors=parse_embeddings(payload,len(texts),self.config['dimension'])
        for vector in vectors:
            if not all(math.isfinite(v) for v in vector) or not any(vector):raise ValueError('Nonfinite/zero embedding rejected')
        return vectors

    def rerank(self,query,documents):
        if not 1<=len(documents)<=30:raise ValueError('Rerank candidate limit 1..30')
        payload=self._call('rerank',[query,*documents],lambda:self.client.rerank(query,documents,self.config['rerank_model'],len(documents)))
        rows=parse_rerank(payload,len(documents),len(documents))
        if len(rows)!=len(documents) or len({r['index'] for r in rows})!=len(documents) or not all(math.isfinite(r['score']) for r in rows):
            raise ValueError('Incomplete/duplicate/nonfinite rerank results rejected')
        return rows
