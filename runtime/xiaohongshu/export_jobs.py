"""Bounded local export jobs; expensive OCR never blocks browsing or MCP timeout."""
import asyncio,json,time,secrets
from pathlib import Path
from export_article import export

class Exports:
    def __init__(self,browser,root):
        self.b=browser;self.root=Path(root)/'exports';self.jobs={};self.tasks=set();self.lock=asyncio.Lock()
    async def start(self,note_ref):
        detail=await self.b.detail(note_ref)
        for job in self.jobs.values():
            if job['note_ref']==note_ref and (job['status'] in ('queued','running') or
                job['status']=='completed' and not job.get('manifest',{}).get('ocr_summary',{}).get('failures')):return self.public(job)
        ref='e_'+secrets.token_hex(10)
        path=self.root/detail['note_id']/(str(time.time_ns())+'-'+secrets.token_hex(3))
        job={'export_ref':ref,'note_ref':note_ref,'note_id':detail['note_id'],'title':detail['title'],
            'status':'queued','path':str(path),'created_at_unix':time.time()}
        self.jobs[ref]=job
        async def work():
            async with self.lock:
                job['status']='running'
                try:
                    # Cached metadata and CDN downloads; bounded direct OCR API
                    # awaits outside the browser operation lock.
                    manifest=await export(self.b,job['note_id'],path)
                    job['status']='completed';job['manifest']=manifest
                except Exception as e:
                    job['status']='failed';job['error_type']=type(e).__name__
        task=asyncio.create_task(work());self.tasks.add(task);task.add_done_callback(self.tasks.discard)
        return self.public(job)
    def public(self,job):
        result={k:v for k,v in job.items() if k!='manifest'}
        if job.get('manifest'):
            m=job['manifest'];result.update(image_count=m['image_count'],ocr_characters=m['ocr_characters'],
                images=[{k:v for k,v in x.items() if k!='ocr_lines'} for x in m['images']],
                text_file=str(Path(job['path'])/'全文-OCR.txt'),markdown_file=str(Path(job['path'])/'全文-OCR.md'),
                manifest_file=str(Path(job['path'])/'manifest.json'),ocr_verified=m['ocr_verified'],ocr_summary=m.get('ocr_summary'))
        result['next_action']='read_export' if job['status'] in ('queued','running') else 'read_export_pages_or_read_image'
        return result
    def read(self,ref,offset=0,limit=3):
        job=self.jobs.get(ref)
        if not job:raise self.b.error('EXPORT_REFERENCE_EXPIRED','export_note_again',False)
        if not 0<=offset<=100 or not 1<=limit<=5:raise self.b.error('INVALID_ARGUMENT','correct_input',False)
        result=self.public(job)
        if job['status']=='completed':
            pages=job['manifest']['images'][offset:offset+limit]
            result['pages']=[{'image_index':p['index'],'image_file':str(Path(job['path'])/p['file']),
                'text':'\n'.join(x['text'] for x in p['ocr_lines']),
                'ocr_status':p.get('ocr_status'),'confidence_available':any(x.get('confidence') is not None for x in p['ocr_lines']),
                'low_confidence_lines':sum(x.get('confidence') is not None and x['confidence']<.8 for x in p['ocr_lines'])} for p in pages]
            result['next_offset']=offset+len(pages);result['has_more']=offset+len(pages)<job['manifest']['image_count']
            result['ocr_warning']='qwen3.5-ocr output, not a verified transcription. Original images and coordinates retained. No provider confidence; failed pages are explicit.'
        return result
    async def close(self):
        # Don't leave worker threads touching disposed browser/http resources.
        for task in self.tasks:task.cancel()
        await asyncio.gather(*self.tasks,return_exceptions=True)
