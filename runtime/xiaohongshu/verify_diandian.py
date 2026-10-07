"""Real content-finding, multi-turn private AI + actual blue-reference acceptance."""
import asyncio,json,time,uuid
from pathlib import Path
from mcp_client import call,close
ROWS=[]
async def run(name,args):
    t=time.perf_counter();r=await call(name,args);v=r['structuredContent'];data=v.get('data',{})
    row={'operation':name,'ok':v.get('ok'),'server_ms':v.get('elapsed_ms'),'wall_ms':round((time.perf_counter()-t)*1000),
        'error':v.get('error'),'reply_complete':data.get('reply_complete'),'rounds':len(data.get('rounds',[])),
        'answer_characters':[len(x.get('answer','')) for x in data.get('rounds',[])],
        'references':len(data.get('references',[])),'opened_kind':data.get('opened_kind'),'items':len(data.get('items',[])),
        'title':data.get('title'),'text_length':len(data.get('text',''))}
    ROWS.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
    if not v.get('ok'):raise RuntimeError(json.dumps(v.get('error')))
    return data
async def wait(ref,offset):
    for _ in range(12):
        d=await run('diandian_read',{'conversation_ref':ref,'wait_seconds':8,'round_offset':offset,'limit':1})
        if d['reply_complete']:return d
    raise RuntimeError('AI_REPLY_DID_NOT_COMPLETE_WITHIN_96_SECONDS')
async def main():
    report={'all_passed':False,'private_ai_queries_only':True,'public_posts_or_comments_sent':False}
    try:
        existing=None
        try: existing=await run('diandian_read',{'limit':5})
        except RuntimeError as e:
            if 'NO_OPEN_AI_CONVERSATION' not in str(e):raise
            report['existing_conversation_not_available']=True
        existing=existing or {'references':[]}
        if existing['references']:
            opened=await run('diandian_open_reference',{'reference_ref':existing['references'][0]['reference_ref'],'limit':5})
            assert opened['items'],'Blue link returned no real notes'
            note=await run('next_feed',{'collection_ref':opened['collection_ref'],'index':0})
            report['existing_reference_verified']={'opened_kind':opened['opened_kind'],'exact_note_verified':opened['exact_note_verified'],'actual_note_title':note['note']['title']}
        else:report['existing_conversation_changed_no_blue_references']=True
        message='我想看小红书里真实用户给AI伴侣做长期记忆的实践笔记，重点是上下文丢失、记忆检索和人格稳定。请先帮我检索相关笔记，给出能点击查看的蓝色引用；优先亲身实践和具体踩坑，不要泛泛讲常识。'
        rid=uuid.uuid4().hex
        d=await run('diandian_chat',{'message':message,'request_id':rid})
        ref=d['conversation_ref'];answer=await wait(ref,0)
        assert answer['rounds'][0]['question']==message
        dedupe=await run('diandian_chat',{'message':message,'request_id':rid,'conversation_ref':ref})
        assert dedupe.get('deduplicated')
        follow='只保留作者亲身实践、提到具体工具或代码的帖子，帮我挑三篇，给出可点击的蓝色引用，并说明各篇作者和需要我去原帖核实的要点。'
        await run('diandian_chat',{'message':follow,'request_id':uuid.uuid4().hex,'conversation_ref':ref})
        continued=await wait(ref,1)
        assert continued['loaded_rounds']==2 and continued['rounds'][0]['question']==follow
        assert continued['references'],'Content-finding answer did not expose blue links'
        selected=await run('diandian_open_reference',{'reference_ref':continued['references'][-1]['reference_ref'],'limit':5})
        assert selected['items']
        actual=await run('next_feed',{'collection_ref':selected['collection_ref'],'index':0})
        assert actual['note']['created_at_ms']
        report.update(all_passed=True,conversation_ref=ref,continuous_rounds=2,request_deduplicated=True,
            new_reference_verified={'opened_kind':selected['opened_kind'],'actual_note_title':actual['note']['title']})
    except Exception as e:report['failure']=str(e)
    report['operations']=ROWS
    (Path(__file__).resolve().parents[2]/'reports/xiaohongshu/diandian-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'all_passed':report['all_passed'],'failure':report.get('failure')},ensure_ascii=False),flush=True)
    await close()
asyncio.run(main())
