"""Original-image batching, bounded provider calls and ordered OCR persistence."""
import asyncio,hashlib,json,time,uuid,traceback
from pathlib import Path
from general_ocr import OcrError
from ocr_layouts import layout
from qwen_ocr_client import QwenOCRClient

def batches(paths,config):
    count=config.get('batch_images',4);result=[]
    def emit(items,indexes):
        try:b=layout(items,min(2,len(items)),config)
        except OcrError:
            if len(items)==1:raise
            mid=len(items)//2;emit(items[:mid],indexes[:mid]);emit(items[mid:],indexes[mid:]);return
        for span,index in zip(b.spans,indexes):span['image_index']=index
        result.append(b)
    for start in range(0,len(paths),count):
        items=paths[start:start+count];emit(items,list(range(start+1,start+len(items)+1)))
    return result

class LongArticleOCR:
    def __init__(self,config):
        if config.get('provider')!='qwen3.5-ocr':raise OcrError('OCR_PROVIDER_NOT_CONFIGURED')
        self.config=config;self.client=QwenOCRClient(config);self.cache=Path(config['cache_root'])
        self.cache.mkdir(parents=True,exist_ok=True)
    async def recognize(self,paths):
        started=time.perf_counter();prepared=await asyncio.to_thread(batches,paths,self.config)
        async def one(batch,index):
            identity=batch.png+json.dumps(batch.spans,sort_keys=True).encode()+b'qwen3.5-ocr:advanced_recognition:v1'
            key=hashlib.sha256(identity).hexdigest();cache=self.cache/(key+'.json')
            if cache.exists():
                record=json.loads(cache.read_text(encoding='utf-8'));record['cache_hit']=True;return record
            # Do not pay again for an identical completed but invalid grid;
            # reuse its evidence and recover only the affected single images.
            failed=next(self.cache.glob(key+'.failed-*.json'),None)
            if failed:
                record=json.loads(failed.read_text(encoding='utf-8'));record['cache_hit']=True;return record
            record=await self.client.recognize(batch,'xhs-ocr-'+key[:16])
            record['cache_hit']=False;record['batch_sha256']=hashlib.sha256(batch.png).hexdigest()
            # This Windows runtime rejects os.replace even inside AppData with
            # EXDEV. Each export is serialized; unique failed records and an
            # exclusive immutable cache file do not require directory moves.
            target=cache if record['success'] else self.cache/(key+'.failed-'+uuid.uuid4().hex+'.json')
            try:
                with target.open('x',encoding='utf-8') as f:json.dump(record,f,ensure_ascii=False)
            except FileExistsError:pass
            return record
        records=await asyncio.gather(*(one(b,i) for i,b in enumerate(prepared)),return_exceptions=True)
        pages=[];failures=[]
        all_records=[];fallback=[]
        for batch,record in zip(prepared,records):
            if isinstance(record,BaseException):failures.append({'image_indexes':[s['image_index'] for s in batch.spans],'error':getattr(record,'code',type(record).__name__),'errno':getattr(record,'errno',None)})
            elif record['success']:pages.extend(record['pages']);all_records.append(record)
            else:
                all_records.append(record)
                # Completed but invalid page coordinates are a quality failure,
                # not an uncertain send. One bounded same-provider single-image
                # pass can recover provenance; transport errors never auto-retry.
                for s in batch.spans:
                    idx=s['image_index'];single=layout([paths[idx-1]],1,self.config);single.spans[0]['image_index']=idx
                    fallback.append(single)
        if fallback:
            recovered=await asyncio.gather(*(one(b,i) for i,b in enumerate(fallback)),return_exceptions=True)
            for b,r in zip(fallback,recovered):
                if isinstance(r,dict):
                    all_records.append(r)
                    if r['success']:pages.extend(r['pages']);continue
                failures.append({'image_indexes':[s['image_index'] for s in b.spans],'error':getattr(r,'code',type(r).__name__) if isinstance(r,BaseException) else 'QWEN_SINGLE_IMAGE_OCR_FAILED'})
        records=all_records
        pages.sort(key=lambda p:p['image_index'])
        return {'provider':'qwen3.5-ocr','pages':pages,'failures':failures,'batch_images':self.config['batch_images'],
            'layout':'two_columns','max_concurrency':self.config['max_concurrency'],'wall_ms':round((time.perf_counter()-started)*1000),
            'single_image_quality_recovery_count':len(fallback),'submitted_new_requests':sum(not r.get('cache_hit') for r in records if isinstance(r,dict)),
            'successful_new_requests':sum(not r.get('cache_hit') and r['success'] for r in records if isinstance(r,dict)),
            'cache_hits':sum(r.get('cache_hit',False) for r in records if isinstance(r,dict)),
            'estimated_cny':round(sum(r.get('estimated_cny',0) for r in records if isinstance(r,dict) and not r.get('cache_hit')),8),
            'requests':[{k:r.get(k) for k in ['request_id','ocr_ms','usage','estimated_cny','cache_hit','batch_sha256']} for r in records if isinstance(r,dict)],
            'cli_process_used':False,'original_pixels_preserved':True,'actual_account_debit_verified':False}
