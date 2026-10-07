"""No platform writes: audit tool discovery, rejected write calls/routes and secret handling."""
import asyncio,json
from pathlib import Path
import httpx
from backend import Browser,allowed_request,CONFIG
from mcp_client import rpc,close
from server import TOOLS

FORBIDDEN=('publish_content','publish_video','post_comment_to_feed','reply_comment_in_feed','like_feed','favorite_feed','follow_user','delete_cookies','unlike_feed','unfavorite_feed','unfollow_user')
async def main():
    actual=await rpc('tools/list')
    names=[x['name'] for x in actual['tools']]
    assert set(names)==set(TOOLS)
    assert not set(names)&set(FORBIDDEN)
    assert 'xsec_token' not in json.dumps(actual) and 'cookie' not in json.dumps([t['inputSchema'] for t in actual['tools']]).lower()
    rejected=[]
    for name in FORBIDDEN:
        r=await rpc('tools/call',{'name':name,'arguments':{}})
        assert r.get('protocol_error') is not None or r.get('isError') is True,name
        rejected.append(name)
    async with httpx.AsyncClient(trust_env=False) as c:
        root=f'http://127.0.0.1:{CONFIG["port"]}'
        paths=['/api/v1/publish','/api/v1/publish_video','/api/v1/feeds/comment','/api/v1/feeds/comment/reply','/api/v1/feeds/like','/api/v1/feeds/favorite','/api/v1/user/follow','/api/v1/login/cookies']
        for path in paths:
            assert (await c.post(root+path,json={})).status_code==404
        assert (await c.delete(root+'/api/v1/login/cookies')).status_code==404
        assert (await c.get(root+'/health',headers={'Host':'evil.invalid'})).status_code==403
        assert (await c.get(root+'/health',headers={'Origin':'https://evil.invalid'})).status_code==403
        assert (await c.post(root+'/mcp',content='x=y',headers={'content-type':'application/x-www-form-urlencoded'})).status_code==415
    b=Browser()
    b.secret_values.add('SYNTHETIC_ONLY_XSEC_TOKEN_12345')
    raw={'xsecToken':'SYNTHETIC_ONLY_XSEC_TOKEN_12345','nested':{'cookie':'synthetic'},'text':'SYNTHETIC_ONLY_XSEC_TOKEN_12345'}
    assert 'SYNTHETIC_ONLY' not in json.dumps(b.sanitize(raw)) and 'cookie' not in json.dumps(b.sanitize(raw))
    await b.close()
    for path in ['/api/sns/web/v1/note/like','/api/sns/web/v1/note/collect','/api/sns/web/v1/comment/post','/api/sns/web/v1/comment/reply','/api/sns/web/v1/user/follow','/api/sns/web/v1/login/logout']:
        assert not allowed_request('https://edith.xiaohongshu.com'+path,'POST')
    assert allowed_request('https://edith.xiaohongshu.com/api/sns/web/v2/search/notes','POST')
    report={'passed':True,'tools':names,'write_tools_absent':True,'write_calls_rejected':rejected,
            'write_routes_404':paths,'loopback_host_origin_checks':True,'synthetic_secret_redaction':True,
            'real_post_sent':False,'real_comment_sent':False,'upstream_write_code_exists':True}
    reports=Path(__file__).resolve().parents[2]/'reports/xiaohongshu';reports.mkdir(parents=True,exist_ok=True)
    (reports/'read-only-contract.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False));await close()

asyncio.run(main())
