"""Live authenticated two-process restart acceptance, without any social writes."""
import asyncio,json,subprocess,time
from pathlib import Path
from mcp_client import call,close
HERE=Path(__file__).resolve().parent
async def main():
    first=await call('search_feeds',{'keyword':'给AI伴侣做记忆 踩坑','limit':8})
    v=first['structuredContent'];assert v['ok'],v
    ref=v['data']['items'][0]['note_ref'];collection=v['data']['collection_ref']
    # Real encrypted persisted bytes, never display the tokens.
    private=list(Path('.local/unconfigured/PersonaXiaohongshu').glob('references.[01].dpapi'))
    assert private and all(b'"token"' not in x.read_bytes() for x in private)
    await close()
    proc=await asyncio.create_subprocess_exec('powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(HERE/'restart.ps1'),stdout=asyncio.subprocess.DEVNULL)
    assert await proc.wait()==0
    rows=[]
    for name,args in [('get_feed_detail',{'note_ref':ref}),('next_feed',{'collection_ref':collection,'index':1}),
                      ('search_feeds',{'keyword':'咖啡','limit':5}),
                      ('search_feeds',{'keyword':'咖啡','filters':{'sort_by':'most_commented','note_type':'image'},'limit':5}),
                      ('search_feeds',{'keyword':'咖啡','filters':{},'limit':5})]:
        t=time.perf_counter();r=await call(name,args);d=r['structuredContent'];rows.append({'operation':name,'ok':d['ok'],'server_ms':d.get('elapsed_ms'),'wall_ms':round((time.perf_counter()-t)*1000),'error':d.get('error')})
        print(json.dumps(rows[-1]),flush=True)
    report={'all_passed':all(x['ok'] for x in rows),'dpapi_ciphertext_verified':True,'cross_process_note_and_collection':rows[:2],'operations':rows}
    (HERE.parents[1]/'reports/xiaohongshu/restart-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    await close()
asyncio.run(main())
