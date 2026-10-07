"""Real authenticated read-only MCP acceptance. Public counts/timings only in report."""
import asyncio, hashlib, json, statistics, time
from pathlib import Path
import httpx
from mcp_client import call, rpc
from backend import CONFIG
REPORTS=Path(__file__).resolve().parents[2]/'reports/xiaohongshu'

async def main():
    REPORTS.mkdir(parents=True,exist_ok=True)
    rows=[]; details=[]
    started=time.time()
    async def run(name,args=None,tag=None):
        t=time.perf_counter();r=await call(name,args)
        v=r['structuredContent'];d=v.get('data',{})
        row={'operation':name,'case':tag or name,'ok':v.get('ok',False),'server_ms':v.get('elapsed_ms'),
             'wall_ms':round((time.perf_counter()-t)*1000),'error':v.get('error'),
             'item_count':len(d.get('items',[])),'image_blocks':len([x for x in r.get('content',[]) if x['type']=='image'])}
        if name=='get_feed_detail' or name=='next_feed':
            n=d.get('note',d);row.update({'note_ref':n.get('note_ref'),'title':n.get('title'),'type':n.get('type'),
                'text_chars':len(n.get('text','')),'images':len(n.get('images',[])),
                'comment_count_reported':n.get('interactions',{}).get('commentCount')})
        if name=='read_comments':row.update({'loaded_count':d.get('loaded_count'),'returned_count':len(d.get('items',[])),
            'expanded_threads':d.get('expanded_threads'),'reply_count':sum(len(x.get('replies',[])) for x in d.get('items',[]))})
        if name=='user_profile':row['posts_count']=len(d.get('posts',{}).get('items',[]))
        rows.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
        return d if v.get('ok') else None
    status=await run('check_login_status',tag='initial_login')
    if not status or not status['logged_in']:raise RuntimeError('Human login needed')
    feed=await run('list_feeds',{'limit':10},'home_first_page')
    await run('list_feeds',{'collection_ref':feed['collection_ref'],'offset':feed['next_offset'],'limit':10},'home_continuation')
    for i in range(2):await run('next_feed',{'collection_ref':feed['collection_ref'],'index':i},'home_open_'+str(i))
    search=await run('search_feeds',{'keyword':'咖啡','limit':8},'ordinary_search')
    if search:
        for i in range(4):
            d=await run('next_feed',{'collection_ref':search['collection_ref'],'index':i},'search_open_'+str(i))
            if d:details.append(d['note'])
        image=next((d for d in details if d['images']),None)
        if image:
            await run('read_images',{'note_ref':image['note_ref'],'limit':1},'real_image_first')
            await run('read_images',{'note_ref':image['note_ref'],'limit':1},'real_image_cached')
        multi=next((d for d in details if len(d['images'])>1),None)
        if multi:
            await run('read_images',{'note_ref':multi['note_ref'],'limit':2},'multi_image_first')
            if len(multi['images'])>2:await run('read_images',{'note_ref':multi['note_ref'],'offset':2,'limit':2},'multi_image_continuation')
        if details:
            chosen=max(details,key=lambda d:int(str(d['interactions'].get('commentCount') or 0).replace('+','')))
            c=await run('read_comments',{'note_ref':chosen['note_ref'],'limit':20,'expand_replies':True},'many_comments_and_replies')
            if c and c.get('has_more'):await run('read_comments',{'note_ref':chosen['note_ref'],'offset':c['next_offset'],'limit':20},'comments_continuation')
            await run('user_profile',{'user_ref':chosen['author']['user_ref'],'limit':6},'author_public_profile')
    await run('search_feeds',{'keyword':'咖啡','filters':{'sort_by':'most_commented','note_type':'image'},'limit':5},'search_filters')
    for i in range(3):await run('list_feeds',{'collection_ref':feed['collection_ref'],'offset':20+i*5,'limit':5},'sustained_home_'+str(i))
    await run('check_login_status',{'refresh':True},'login_still_reusable')
    async with httpx.AsyncClient(trust_env=False) as c:health=(await c.get(f'http://127.0.0.1:{CONFIG["port"]}/health')).json()
    report={'started_at_unix':started,'duration_seconds':round(time.time()-started),'authenticated':True,
        'cases':rows,'health':health,'all_passed':all(x['ok'] for x in rows)}
    (REPORTS/'live-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'report':str(REPORTS/'live-acceptance.json'),'all_passed':report['all_passed']}))

if __name__=='__main__':asyncio.run(main())
