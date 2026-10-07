"""Control-side MCP smoke/latency client. No secret input or result dumps."""
import asyncio, json, time
import httpx
from backend import CONFIG
URL=f'http://127.0.0.1:{CONFIG["port"]}/mcp'
_http=None

async def rpc(method, params=None):
    global _http
    if _http is None:_http=httpx.AsyncClient(trust_env=False,timeout=35)
    r=await _http.post(URL,json={'jsonrpc':'2.0','id':1,'method':method,'params':params or {}},
                       headers={'Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'})
    r.raise_for_status()
    data=r.json()
    if 'error' in data: return {'protocol_error':data['error']['code']}
    return data['result']

async def close():
    global _http
    if _http:await _http.aclose();_http=None

async def call(name, arguments=None):
    result=await rpc('tools/call',{'name':name,'arguments':arguments or {}})
    result.setdefault('structuredContent',{})
    return result

async def smoke():
    ts=await rpc('tools/list')
    print(json.dumps({'tools':[t['name'] for t in ts['tools']]}))
    for name,args in [('check_login_status',{}),('list_feeds',{'limit':4}),('search_feeds',{'keyword':'咖啡','limit':5})]:
        r=await call(name,args)
        v=r['structuredContent']; d=v.get('data',{})
        print(json.dumps({'tool':name,'ok':v.get('ok'),'error':v.get('error'),'elapsed_ms':v.get('elapsed_ms'),
          'logged_in':d.get('logged_in'),'items':len(d.get('items',[]))},ensure_ascii=False))
        if not v.get('ok'): break
    if v.get('ok') and d.get('items'):
        r=await call('get_feed_detail',{'note_ref':d['items'][0]['note_ref']}); v=r['structuredContent']; d=v.get('data',{})
        print(json.dumps({'tool':'get_feed_detail','ok':v.get('ok'),'error':v.get('error'),'elapsed_ms':v.get('elapsed_ms'),
          'title':d.get('title'),'text_length':len(d.get('text','')),'images':len(d.get('images',[])),
          'comments':len(d.get('comments',{}).get('items',[]))},ensure_ascii=False))
        if v.get('ok') and d.get('images'):
            r=await call('read_images',{'note_ref':d['note_ref'],'limit':1});v=r['structuredContent']
            print(json.dumps({'tool':'read_images','ok':v.get('ok'),'error':v.get('error'),'elapsed_ms':v.get('elapsed_ms'),
              'image_blocks':len([b for b in r.get('content',[]) if b['type']=='image'])},ensure_ascii=False))

if __name__=='__main__': asyncio.run(smoke())
