import asyncio,json,time
from pathlib import Path
from backend import Browser
async def main():
 b=Browser();t=time.perf_counter()
 try:
  await b.connect()
  d=await b.ai.read('d_c0d43c9dfb65b68f915c',0,0,5)
  assert d['references']
  opened=await b.ai.open_reference(d['references'][0]['reference_ref'],5)
  assert opened['items']
  unavailable=[];note=None
  for item in opened['items'][:3]:
   try:
    note=await b.detail(item['note_ref']);break
   except b.error as e:unavailable.append({'note_ref':item['note_ref'],'code':e.code})
  result={'passed':True,'via':'production_backend','conversation_ref':d['conversation_ref'],'answer_characters':[len(x.get('answer','')) for x in d['rounds']],'reference':opened['label'],'opened_kind':opened['opened_kind'],'items':len(opened['items']),'loaded_count':opened['loaded_count'],'exact_note_verified':False,'actual_note_title':note['title'] if note else None,'unavailable':unavailable,'wall_ms':round((time.perf_counter()-t)*1000)}
  (Path(__file__).resolve().parents[2]/'reports/xiaohongshu/diandian-blue-final.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
  print(json.dumps(result,ensure_ascii=False),flush=True)
 finally:
  await b.http.aclose()
  if b.playwright:await b.playwright.stop()
  if b.scoped_cdp:await b.scoped_cdp.close()
asyncio.run(main())
