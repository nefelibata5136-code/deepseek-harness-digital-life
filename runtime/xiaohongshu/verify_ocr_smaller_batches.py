"""Quality follow-up justified by actual 5+5 omissions; direct SDK, no CLI."""
import asyncio,json,time,difflib,re
from pathlib import Path
from general_ocr import GeneralOCR,stitch
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]/'reports/xiaohongshu'
OUT=ROOT/'general-ocr'
def canonical(s):return ''.join(re.findall(r'[\u4e00-\u9fffA-Za-z0-9]',s))
async def main():
    config=json.loads((HERE/'config.json').read_text(encoding='utf-8'))['ocr']
    source=ROOT/'exports/换窗之后-猎月'
    baseline=json.loads((OUT/'benchmark.json').read_text(encoding='utf-8'))['A']['requests']
    t=time.perf_counter();batches=stitch([source/f'{i:02d}.webp' for i in range(1,11)],config,2)
    provider=GeneralOCR(config)
    results=await asyncio.gather(*(provider.recognize(b,f'xhs-sdk-pair-{i}-{int(time.time())}') for i,b in enumerate(batches,1)))
    report={'batch_images':2,'cli_process_used':False,'wall_ms':round((time.perf_counter()-t)*1000),
            'successful_requests':sum(r['success'] for r in results),'requests':results,'comparison':[]}
    actual={int(k):v for r in results for k,v in r.get('pages',{}).items()}
    for i,base in enumerate(baseline,1):
        a=canonical(base['text']);rows=actual.get(i,[]);text='\n'.join(x['text'] for x in rows);b=canonical(text)
        matcher=difflib.SequenceMatcher(None,a,b,autojunk=False)
        report['comparison'].append({'image_index':i,'agreement':round(matcher.ratio(),5),'single_characters':len(a),
            'joined_characters':len(b),'differences':[{'operation':op,'single':a[x:y],'joined':b[u:v]} for op,x,y,u,v in matcher.get_opcodes() if op!='equal']})
        (OUT/f'{i:02d}-pair.txt').write_text(text,encoding='utf-8')
    report['theoretical_cny']=report['successful_requests']*.003
    (OUT/'sdk-pairs.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('requests','comparison')},ensure_ascii=False))
    print(json.dumps(report['comparison'],ensure_ascii=False))
if __name__=='__main__':asyncio.run(main())
