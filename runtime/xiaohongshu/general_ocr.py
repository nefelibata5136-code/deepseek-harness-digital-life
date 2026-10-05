"""Green 2022-03-02 generalOcr via official SDK and refreshable CLI-profile credentials.

Original pixels -> lossless PNG batches -> temporary upload -> bounded OCR.
Secret CLI responses and signed URLs stay in memory. No automatic paid retries.
"""
import asyncio,io,json,os,secrets,time,hashlib,re
from dataclasses import dataclass
from pathlib import Path
from PIL import Image,ImageOps

class OcrError(Exception):
    def __init__(self,code):self.code=code;super().__init__(code)

@dataclass
class Batch:
    png:bytes
    width:int
    height:int
    spans:list

def stitch(paths,config,batch_size=None):
    """No resize; narrow images are padded on the right, never interpolated."""
    maximum=batch_size or config['batch_images']; groups=[];pending=[]
    def emit(items):
        width=max(x[1].width for x in items);height=sum(x[1].height for x in items)
        image=Image.new('RGB',(width,height),'white');top=0;spans=[]
        for index,picture in items:
            image.paste(picture,(0,top));spans.append({'image_index':index,'top':top,'bottom':top+picture.height,'width':picture.width});top+=picture.height
        output=io.BytesIO();image.save(output,format='PNG',compress_level=3)
        blob=output.getvalue()
        if len(blob)>config['max_bytes']:
            if len(items)==1:raise OcrError('OCR_IMAGE_EXCEEDS_BYTE_LIMIT')
            mid=len(items)//2;emit(items[:mid]);emit(items[mid:]);return
        groups.append(Batch(blob,width,height,spans))
    for index,path in enumerate(paths,1):
        with Image.open(path) as source:picture=ImageOps.exif_transpose(source).convert('RGB')
        if max(picture.size)>config['max_side'] or picture.width*picture.height>config['max_pixels']:
            raise OcrError('OCR_SINGLE_IMAGE_EXCEEDS_DIMENSION_LIMIT')
        candidate=pending+[(index,picture)]
        width=max(x[1].width for x in candidate);height=sum(x[1].height for x in candidate)
        if pending and (len(candidate)>maximum or height>config['max_side'] or width*height>config['max_pixels']):
            emit(pending);pending=[]
        pending.append((index,picture))
    if pending:emit(pending)
    return groups

def restore_pages(lines,batch):
    """Keep raw lines and original coordinate provenance; flag cross-boundary lines."""
    pages={s['image_index']:[] for s in batch.spans};warnings=[]
    for raw in lines:
        loc=raw.get('Location',{});y=float(loc.get('Y',0));height=float(loc.get('H',0));center=y+height/2
        x=float(loc.get('X',0));width=float(loc.get('W',0));center_x=x+width/2
        span=next((s for s in batch.spans if s['top']<=center<s['bottom']
            and s.get('left',0)<=center_x<s.get('right',batch.width)),None)
        if span is None:
            warnings.append('OCR_LINE_OUTSIDE_ORIGINAL_IMAGE');continue
        item={'text':raw.get('Text',''),'location':{**loc,'Y':y-span['top'],'X':x-span.get('left',0)},'batch_location':loc}
        pages[span['image_index']].append(item)
        if y<span['top'] or y+height>span['bottom'] or x<span.get('left',0) or x+width>span.get('right',batch.width):
            warnings.append('OCR_LINE_CROSSES_JOIN_BOUNDARY')
    for rows in pages.values():rows.sort(key=lambda x:(x['location'].get('Y',0),x['location'].get('X',0)))
    return pages,sorted(set(warnings))

class GeneralOCR:
    def __init__(self,config):
        from aliyun_ocr_client import AliyunOCRClient
        self.transport=AliyunOCRClient(config)
        self.config=config;self.token=None;self.token_lock=asyncio.Lock();self.semaphore=asyncio.Semaphore(config['max_concurrency'])
    async def upload_token(self):
        async with self.token_lock:
            if self.token and self.token.get('_valid_until',0)>time.time()+60:return self.token
            body=await self.transport.call('DescribeUploadToken')
            if body.get('Code')!=200:raise OcrError('GREEN_UPLOAD_TOKEN_UNAVAILABLE')
            data=body.get('Data',{})
            if not all(data.get(k) for k in ['AccessKeyId','AccessKeySecret','SecurityToken','BucketName','OssInternetEndPoint','FileNamePrefix']):
                raise OcrError('GREEN_UPLOAD_TOKEN_FIELDS_MISSING')
            data['_valid_until']=time.time()+300;self.token=data;return data
    async def recognize(self,batch,label):
        async with self.semaphore:
            started=time.perf_counter();token=await self.upload_token()
            import oss2
            endpoint=token['OssInternetEndPoint']
            if not endpoint.startswith('https://'):endpoint='https://'+endpoint.removeprefix('http://')
            auth=oss2.StsAuth(token['AccessKeyId'],token['AccessKeySecret'],token['SecurityToken'])
            bucket=oss2.Bucket(auth,endpoint,token['BucketName'],connect_timeout=10)
            key=token['FileNamePrefix'].rstrip('/')+'/'+secrets.token_hex(16)+'.png'
            record={'label':label,'success':False,'width':batch.width,'height':batch.height,'bytes':len(batch.png),
                'image_indexes':[x['image_index'] for x in batch.spans],'sha256':hashlib.sha256(batch.png).hexdigest(),
                'cleanup':'not_uploaded','ocr_submitted':False}
            try:
                t=time.perf_counter();await asyncio.to_thread(bucket.put_object,key,batch.png,headers={'Content-Type':'image/png'})
                record['upload_ms']=round((time.perf_counter()-t)*1000);record['cleanup']='pending'
                # Provider-owned temporary storage grants upload only. Green
                # reads it internally; generating a GET URL with that STS fails.
                params=json.dumps({'ossBucketName':token['BucketName'],
                    'ossObjectName':key,'dataId':label},separators=(',',':'))
                record['ocr_submitted']=True;t=time.perf_counter()
                response=await self.transport.call('ImageModeration',{'Service':'generalOcr','ServiceParameters':params})
                record.update(ocr_ms=round((time.perf_counter()-t)*1000),code=response.get('Code'),request_id=response.get('RequestId'),success=response.get('Code')==200)
                record['message']=re.sub(r'https?://[^\s]+','[url-redacted]',str(response.get('Msg','')))[:300]
                record['lines']=response.get('Data',{}).get('Ext',{}).get('OcrResult',[])
                record['text']='\n'.join(x.get('Text','') for x in record['lines'])
                if record['success']:
                    pages,warnings=restore_pages(record['lines'],batch);record['pages']=pages;record['warnings']=warnings
            except OcrError as e:record['error']=e.code
            except Exception as e:record['error']=type(e).__name__
            finally:
                if record['cleanup']=='pending':
                    try:
                        await asyncio.to_thread(bucket.delete_object,key);record['cleanup']='deleted'
                    except Exception:record['cleanup']='provider_temporary_upload_30min_expiry_delete_not_confirmed'
                record['wall_ms']=round((time.perf_counter()-started)*1000)
            return record
