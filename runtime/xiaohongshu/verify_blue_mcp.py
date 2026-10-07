import asyncio,json
from pathlib import Path
from mcp_client import call,close
async def run(name,args):
 r=(await call(name,args))['structuredContent'];assert r.get('ok'),r.get('error');return r['data']
async def main():
 try:
  d=await run('diandian_read',{'conversation_ref':'d_c0d43c9dfb65b68f915c','limit':5})
  o=await run('diandian_open_reference',{'reference_ref':d['references'][0]['reference_ref'],'limit':3})
  n=await run('get_feed_detail',{'note_ref':o['items'][0]['note_ref']})
  assert n['title'] and n.get('created_at_ms')
  report={'passed':True,'via':'live_mcp_after_reload','answer_characters':[len(x['answer']) for x in d['rounds']],'opened_kind':o['opened_kind'],'loaded_count':o['loaded_count'],'actual_note_title':n['title'],'exact_note_verified':False}
  (Path(__file__).resolve().parents[2]/'reports/xiaohongshu/diandian-mcp-final.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
  print(json.dumps(report,ensure_ascii=False))
 finally:await close()
asyncio.run(main())
