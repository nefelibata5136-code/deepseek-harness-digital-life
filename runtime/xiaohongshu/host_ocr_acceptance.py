"""Explicitly new native Session for actual Persona OCR calls; never main chat."""
import asyncio,json,time,uuid
from pathlib import Path
import httpx
ROOT=Path(__file__).resolve().parents[2]
async def main():
    control=json.loads((ROOT/'runtime/native_dsh/host-state/.host-control.json').read_text(encoding='utf-8'))
    out=ROOT/'reports/xiaohongshu';receipt=out/'host-ocr-request.json'
    async with httpx.AsyncClient(trust_env=False,timeout=None) as client:
        async def host(path,data=None):
            r=await client.request('POST' if data is not None else 'GET',f'http://127.0.0.1:{control["port"]}{path}',
                headers={'Authorization':'Bearer '+control['token'],'Content-Type':'application/json'},json=data)
            r.raise_for_status();return r.json()
        task=await host('/tasks',{'requestId':str(uuid.uuid4()),'title':'小红书千问3.5 OCR正式调用验收'})
        sid=task['sessionId'];assert sid!=control['sessionId'] and not task.get('existing')
        request=str(uuid.uuid4())
        text='''这是用户授权的小红书MCP OCR独立验收对话。请保持当前身份，不写核心、记忆或便签。新版实际模型是qwen3.5-ocr。
实际执行：
1. 读取技能persona-xiaohongshu；capability_search({"capability":"xiaohongshu","limit":30})取得当前工具。
2. get_feed_detail({"note_ref":"n_6a8bab80000000001600a47f"})，确认《换窗之后，他还是他吗？》有10张图片。
3. 必须亲自调用export_note({"note_ref":"n_6a8bab80000000001600a47f"})，保存返回export_ref。
4. 后台识别期间，调用search_feeds({"keyword":"咖啡","limit":3})，检验搜索不会被OCR阻塞。
5. read_export用同一个export_ref查询。若running可读两篇咖啡结果的get_feed_detail，再查询。完成后read_export(offset=0,limit=5)和read_export(offset=5,limit=5)，实际阅读全部10页OCR。
6. 报告provider、总图片/识别页数、失败页、实际OCR耗时、成功新请求数/缓存命中、estimated_cny，以及第2张末行和第10张结束文字。不把OCR当人工校对原文，不展示Cookie/令牌/Key。
最多18个工具调用。只用此次发现的小红书MCP和原生skill/capability_search；禁止terminal/网络脚本/Computer Use绕过。若仍未完成，准确报告export_ref和状态，不无限轮询。
发布、公开评论/回复、点赞、收藏、关注、删除Cookie仍未开放。第三方MCP只读也不保证没有风控，账号有限，先浏览运行几天再决定权限。'''
        receipt.write_text(json.dumps({'sessionId':sid,'title':task['title'],'requestId':request,'text':text,'submitted_at_unix':time.time()},ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'submitted':True,'sessionId':sid,'title':task['title'],'requestId':request},ensure_ascii=False),flush=True)
        result=await host('/prompt',{'sessionId':sid,'requestId':request,'text':text})
        (out/'host-ocr-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({k:result.get(k) for k in ['state','sessionId','requestId','text','errors','tools','eventCount']},ensure_ascii=False),flush=True)
if __name__=='__main__':asyncio.run(main())
