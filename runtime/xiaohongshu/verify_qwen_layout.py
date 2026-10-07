"""One layout at a time; quality is reviewed before any next paid request."""
import asyncio,argparse,json,time
from pathlib import Path
from ocr_layouts import layout
from qwen_ocr_client import QwenOCRClient

async def main():
    parser=argparse.ArgumentParser();parser.add_argument('layout',choices=['five-horizontal','five-vertical','four-grid'])
    args=parser.parse_args();here=Path(__file__).resolve().parent;root=here.parents[1]/'reports/xiaohongshu'
    source=root/'exports/换窗之后-猎月';out=root/'ocr-layouts';out.mkdir(exist_ok=True)
    count,columns={'five-horizontal':(5,5),'five-vertical':(5,1),'four-grid':(4,2)}[args.layout]
    config=json.loads((here/'config.json').read_text(encoding='utf-8'))['ocr']
    t=time.perf_counter();batch=layout([source/f'{i:02d}.webp' for i in range(1,count+1)],columns,config)
    report={'layout':args.layout,'model':'qwen3.5-ocr','source_note_id':'6a8bab80000000001600a47f','image_count':count}
    try:
        report['result']=await QwenOCRClient().recognize(batch,'xhs-qwen-'+args.layout)
        report['quality_status']='requires_original_image_review'
        for p in report['result'].get('pages',[]):(out/f'qwen-{args.layout}-{p["image_index"]:02d}.txt').write_text(p['text'],encoding='utf-8')
    except Exception as e:report['error']=getattr(e,'code',type(e).__name__)
    report['wall_ms']=round((time.perf_counter()-t)*1000)
    (out/f'qwen-{args.layout}.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    safe={k:v for k,v in report.items() if k!='result'}
    safe['result']={k:v for k,v in report.get('result',{}).items() if k not in ('raw_text','pages')}
    print(json.dumps(safe,ensure_ascii=False),flush=True)

if __name__=='__main__':asyncio.run(main())
