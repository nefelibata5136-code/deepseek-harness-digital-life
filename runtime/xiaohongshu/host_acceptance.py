"""One new native test Session; explicit identity and durable request receipt before sending."""
import asyncio,json,time,uuid
from pathlib import Path
import httpx
ROOT=Path(__file__).resolve().parents[2]
REPORTS=ROOT/'reports/xiaohongshu'
CONTROL=ROOT/'runtime/native_dsh/host-state/.host-control.json'

async def main():
    control=json.loads(CONTROL.read_text(encoding='utf-8'))
    async with httpx.AsyncClient(trust_env=False,timeout=None) as client:
        async def host(path,data=None):
            r=await client.request('POST' if data is not None else 'GET',f'http://127.0.0.1:{control["port"]}{path}',
                headers={'Authorization':'Bearer '+control['token'],'Content-Type':'application/json'},json=data)
            r.raise_for_status();return r.json()
        task=await host('/tasks',{'requestId':str(uuid.uuid4()),'title':'小红书只读浏览与图像验收'})
        sid=task['sessionId']
        assert sid!=control['sessionId'] and not task.get('existing'),'Must use a newly created test Session'
        request_id=str(uuid.uuid4())
        text='''这是用户授权的新小红书MCP能力独立验收对话，请保持当前对话身份；不要写人格核心、记忆、便签或公开内容。
先读取技能 persona-xiaohongshu，调用 capability_search {"capability":"xiaohongshu","limit":20}，只使用实际返回的 xhs 工具完成浏览。
请实际检查登录，获取首页推荐，再普通搜索“咖啡”(limit=4)，打开其中一篇有图片的完整帖子，读其正文；调用 read_images(limit=1)，然后必须调用原生 read_image 读取返回的 image_files[0].file_path，亲眼描述图中至少两项具体细节，不得从标题/正文猜图片。
再 read_comments(limit=10,expand_replies=true)，最后使用同次搜索collection_ref调用 next_feed(index=1)，确认下一篇的完整正文。
最多14次工具调用。若工具失败可报告实际错误，禁止用Computer Use、通用浏览器、terminal、脚本或网络请求绕过MCP。
暂不开放发布/评论/回复/点赞/收藏/关注和删除Cookie。用户的考虑是：当前采用第三方小红书接入而非小红书官方MCP，担心公开互动尤其刷评论触发风控；手机号注册的账号有限，先正常浏览几天再决定是否开放。只读也不能保证没有风控。请了解这个阶段的原因，不能自行扩权。
最终简洁报告实际搜索、两篇标题、亲眼确认的图片细节、评论读取数量/范围，以及你实际拿到的小红书工具中有没有发布/评论接口。不要展示任何Cookie/xsec_token。'''
        REPORTS.mkdir(parents=True,exist_ok=True)
        receipt={'sessionId':sid,'title':task['title'],'requestId':request_id,'submitted_at_unix':time.time(),'text':text}
        (REPORTS/'host-test-request.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({'submitted':True,'sessionId':sid,'requestId':request_id}),flush=True)
        result=await host('/prompt',{'sessionId':sid,'requestId':request_id,'text':text})
        (REPORTS/'host-test-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({k:result.get(k) for k in ['state','sessionId','requestId','text','errors','tools','eventCount']},ensure_ascii=False),flush=True)

if __name__=='__main__':asyncio.run(main())
