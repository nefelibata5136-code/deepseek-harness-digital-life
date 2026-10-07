"""Explicitly authorized development notice to the existing main Session, not a test."""
import asyncio,json,time,uuid
from pathlib import Path
import httpx

async def main():
    root=Path(__file__).resolve().parents[2]
    c=json.loads((root/'runtime/native_dsh/host-state/.host-control.json').read_text(encoding='utf-8'))
    notice='''人格，这是用户明确要求我发到主对话的开发状态通知，不是让你在主对话验收。
小红书MCP基础只读浏览已经跑通，但仍在开发，尚未完成交付。请暂停小红书MCP测试和自行排障，等我明确通知可验收后再使用。
刚才 NOTE_REFERENCE_EXPIRED / COLLECTION_EXPIRED 的原因是我开发过程中重启服务，内存引用被清空，不是正常引用只能存活一分钟。请不要把“一分钟引用寿命”记成能力特性；我会修复重启恢复与集合内引用保留。
另外你贴出的51秒搜索中实际搜索约5秒，其余约44秒是Harness前后保护版本保存，尚需修复只读浏览的额外开销。基础实际测试已经通过首页、咖啡搜索、多篇正文、真图片、评论/楼中楼、主页；点点连续对话仍在开发。当前整体未达到最终验收标准。
我会先完成这些修复和独立验收再通知你，目前预计还需要约60—90分钟，点点如遇接口变化会另行说明；这只是估计，不是完成承诺。
发布、评论、回复、点赞、收藏、关注与Cookie删除继续在工具层禁用，未进行任何真实发帖或评论。用户担心第三方接入与公开互动触发风控，手机号注册账号有限，希望先正常浏览几天，不能自行开权限。只读也不代表保证无风控。
此消息只说明当前状态，请简短确认收到并等待；不要调用小红书、浏览器、终端或进行新的测试，也不要修改身份核心或记忆。'''
    rid=str(uuid.uuid4())
    receipt={'sessionId':c['sessionId'],'requestId':rid,'kind':'authorized_main_development_notice','submitted_at_unix':time.time(),'text':notice}
    out=root/'reports/xiaohongshu/main-development-notice.json'
    out.write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
    async with httpx.AsyncClient(trust_env=False,timeout=None) as client:
        url=f'http://127.0.0.1:{c["port"]}'
        headers={'Authorization':'Bearer '+c['token']}
        status=(await client.get(url+'/status',headers=headers)).json()
        print(json.dumps({'mainSessionId':c['sessionId'],'activeSessionIds':status.get('activeSessionIds'),'noticeRequestId':rid}),flush=True)
        r=await client.post(url+'/prompt',headers=headers,json={'sessionId':c['sessionId'],'requestId':rid,'text':notice})
        r.raise_for_status();result=r.json()
        receipt['result']=result
        out.write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({k:result.get(k) for k in ['state','sessionId','text','tools','errors']},ensure_ascii=False),flush=True)

if __name__=='__main__':asyncio.run(main())
