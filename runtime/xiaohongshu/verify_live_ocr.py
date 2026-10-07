"""One real MCP export and bounded receipt read; does not start another model."""
import asyncio,json,time
from pathlib import Path
from mcp_client import call,close
async def main():
    t=time.perf_counter();out=Path(__file__).resolve().parents[2]/'reports/xiaohongshu'
    try:
        r=(await call('export_note',{'note_ref':'n_6a8bab80000000001600a47f'}))['structuredContent']
        assert r.get('ok'),r.get('error');ref=r['data']['export_ref']
        for i in range(40):
            await asyncio.sleep(2)
            r=(await call('read_export',{'export_ref':ref,'offset':0,'limit':5}))['structuredContent'];d=r.get('data',{})
            if d.get('status') not in ('queued','running'):break
        r2=(await call('read_export',{'export_ref':ref,'offset':5,'limit':5}))['structuredContent']
        pages=d.get('pages',[])+r2.get('data',{}).get('pages',[])
        report={'export_ref':ref,'status':d.get('status'),'image_count':d.get('image_count'),
            'pages':pages,'summary':d.get('ocr_summary'),'manifest_file':d.get('manifest_file'),
            'wall_ms':round((time.perf_counter()-t)*1000),'passed':len(pages)==10 and all(p.get('text') for p in pages)}
        (out/'live-ocr-final.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({k:v for k,v in report.items() if k!='pages'},ensure_ascii=False),flush=True)
    finally:await close()
if __name__=='__main__':asyncio.run(main())
