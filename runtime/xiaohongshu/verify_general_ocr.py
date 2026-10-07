"""Real, billable A/B benchmark. No retries, no credential/URL output."""
import asyncio,json,time,datetime,re,difflib
from pathlib import Path
from general_ocr import stitch
from aliyun_cli_benchmark import CLIGeneralOCR as GeneralOCR
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]/'reports/xiaohongshu'
SOURCE=ROOT/'exports/换窗之后-猎月'
OUT=ROOT/'general-ocr'
def canonical(text):return ''.join(re.findall(r'[\u4e00-\u9fffA-Za-z0-9]',text))
async def main():
    config=json.loads((HERE/'config.json').read_text(encoding='utf-8'))['ocr'];provider=GeneralOCR(config)
    paths=[SOURCE/f'{i:02d}.webp' for i in range(1,11)];OUT.mkdir(parents=True,exist_ok=True)
    report={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_note_id':'6a8bab80000000001600a47f',
        'image_count':10,'api':'Green/2022-03-02/ImageModeration','service':'generalOcr','unit_price_cny':.003,
        'actual_billing':{'status':'not_queried','charged_cny':None},'completed':False}
    try:
        # Authentication and upload permission preflight has no OCR request.
        await provider.upload_token()
        original=stitch(paths,config,1);t=time.perf_counter();records=[]
        for index,batch in enumerate(original,1):
            result=await provider.recognize(batch,f'xhs-a-{index}-{int(time.time())}')
            records.append(result);print(json.dumps({k:result.get(k) for k in ['label','success','ocr_ms','wall_ms','cleanup','error']},ensure_ascii=False),flush=True)
        report['A']={'wall_ms':round((time.perf_counter()-t)*1000),'requests':records,'successful_requests':sum(x['success'] for x in records)}
        report['A']['theoretical_cny']=round(report['A']['successful_requests']*.003,6)
        # Formal article pipeline clock includes stitching, uploading, OCR and cleanup.
        t=time.perf_counter();batches=await asyncio.to_thread(stitch,paths,config,5)
        for index,batch in enumerate(batches,1):(OUT/f'batch-{index}.png').write_bytes(batch.png)
        joined=await asyncio.gather(*(provider.recognize(b,f'xhs-b-{i}-{int(time.time())}') for i,b in enumerate(batches,1)))
        report['B']={'wall_ms':round((time.perf_counter()-t)*1000),'download_ms':0,'download_state':'originals_already_downloaded',
            'requests':joined,'successful_requests':sum(x['success'] for x in joined),'theoretical_cny':round(sum(x['success'] for x in joined)*.003,6)}
        actual={int(k):v for r in joined for k,v in r.get('pages',{}).items()};comparisons=[]
        for index,result in enumerate(records,1):
            base=canonical(result.get('text',''));rows=actual.get(index,[]);text='\n'.join(x['text'] for x in rows);new=canonical(text)
            (OUT/f'{index:02d}-single.txt').write_text(result.get('text',''),encoding='utf-8');(OUT/f'{index:02d}-joined.txt').write_text(text,encoding='utf-8')
            matcher=difflib.SequenceMatcher(None,base,new,autojunk=False)
            differences=[{'operation':op,'single':base[a:b],'joined':new[c:d]} for op,a,b,c,d in matcher.get_opcodes() if op!='equal']
            comparisons.append({'image_index':index,'single_lines':len(result.get('lines',[])),'joined_lines':len(rows),'single_characters':len(base),
                'joined_characters':len(new),'agreement':round(matcher.ratio(),5),'differences':differences})
        report['comparison']=comparisons
        ten=stitch(paths,config,10)
        if len(ten)==1:
            result=await provider.recognize(ten[0],f'xhs-c-{int(time.time())}');report['C']={'tested':True,'request':result,'theoretical_cny':.003 if result['success'] else 0}
        else:report['C']={'tested':False,'reason':'10 original pages total 18000px exceeds 16384px; no downscaling','required_height':18000}
        report['completed']=True
    except Exception as e:report['failure']=getattr(e,'code',type(e).__name__)
    finally:
        (OUT/'benchmark.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'completed':report['completed'],'failure':report.get('failure'),'A_success':report.get('A',{}).get('successful_requests'),
            'B_success':report.get('B',{}).get('successful_requests'),'B_wall_ms':report.get('B',{}).get('wall_ms')},ensure_ascii=False),flush=True)
if __name__=='__main__':asyncio.run(main())
