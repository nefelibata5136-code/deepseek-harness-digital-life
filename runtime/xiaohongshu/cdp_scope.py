"""Local private CDP relay: don't initialize unrelated or frozen browser tabs.

Not an MCP endpoint. Random path, no Origin, loopback, no protocol logging.
Only Playwright's connection uses it; it preserves actual browser/login profile.
"""
import asyncio,json,secrets
from urllib.parse import urlsplit
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

class ScopedCDP:
    def __init__(self,http,endpoint):
        self.http=http;self.endpoint=endpoint;self.server=None
        self.path='/'+secrets.token_hex(32);self.excluded=set();self.frozen=0
    async def start(self):
        targets=(await self.http.get(self.endpoint+'/json/list',timeout=2)).json()
        version=(await self.http.get(self.endpoint+'/json/version',timeout=2)).json()
        self.upstream=version['webSocketDebuggerUrl']
        async def responsive(t):
            if t.get('type')!='page':return
            if urlsplit(t.get('url','')).hostname!='www.xiaohongshu.com':
                self.excluded.add(t['id']);return
            try:
                async with connect(t['webSocketDebuggerUrl'],proxy=None,open_timeout=1,close_timeout=.1,max_size=4*1024*1024) as ws:
                    await ws.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':'document.readyState','returnByValue':True}}))
                    async with asyncio.timeout(.7):
                        while True:
                            r=json.loads(await ws.recv())
                            if r.get('id')==1:
                                if 'error' in r:raise ValueError('unavailable')
                                break
            except Exception:self.excluded.add(t['id']);self.frozen+=1
        await asyncio.gather(*(responsive(t) for t in targets))
        self.server=await serve(self.relay,'127.0.0.1',0,origins=[None],max_size=32*1024*1024,compression=None)
        port=self.server.sockets[0].getsockname()[1]
        return f'ws://127.0.0.1:{port}{self.path}'
    async def relay(self,down):
        if down.request.path!=self.path:
            await down.close(code=1008);return
        async with connect(self.upstream,proxy=None,open_timeout=3,max_size=32*1024*1024,compression=None) as up:
            methods={};hidden_sessions=set();internal=-1
            async def downstream():
                async for raw in down:
                    r=json.loads(raw)
                    if 'id' in r:methods[r['id']]=r.get('method')
                    await up.send(raw)
            async def upstream():
                nonlocal internal
                async for raw in up:
                    r=json.loads(raw)
                    if r.get('id',0)<0:continue
                    if r.get('sessionId') in hidden_sessions:continue
                    if r.get('method')=='Target.attachedToTarget':
                        info=r['params']['targetInfo'];sid=r['params']['sessionId']
                        if info['targetId'] in self.excluded or info['type']=='browser_ui':
                            hidden_sessions.add(sid)
                            await up.send(json.dumps({'id':internal,'method':'Target.detachFromTarget','params':{'sessionId':sid}}));internal-=1
                            continue
                    method=methods.pop(r.get('id'),None)
                    if method=='Target.getTargets' and 'result' in r:
                        r['result']['targetInfos']=[t for t in r['result']['targetInfos'] if t['targetId'] not in self.excluded]
                        raw=json.dumps(r)
                    await down.send(raw)
            tasks=[asyncio.create_task(downstream()),asyncio.create_task(upstream())]
            try:await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:task.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
    async def close(self):
        if self.server:self.server.close();await self.server.wait_closed()
