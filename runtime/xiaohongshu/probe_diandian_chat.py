"""One explicitly authorized private DianDian test exchange; never social publishing."""
import asyncio,json,time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright
PRIVATE=Path('.local/unconfigured/PersonaXiaohongshu')

async def main():
    async with async_playwright() as p:
        b=await p.chromium.connect_over_cdp('http://127.0.0.1:18745',timeout=5000)
        page=None
        for x in b.contexts[0].pages:
            if 'xiaohongshu.com' in x.url and await x.evaluate('() => window.name')=='persona-diandian-research':page=x;break
        if not page:raise RuntimeError('Run inspect_diandian first')
        requests=[];responses=[]
        def request(r):
            u=urlsplit(r.url)
            if '/api/' in u.path:
                keys=[]
                try:keys=list(r.post_data_json or {})
                except Exception:pass
                requests.append({'host':u.hostname,'path':u.path,'method':r.method,'body_keys':keys})
        async def response(r):
            u=urlsplit(r.url)
            if '/api/' in u.path and any(x in u.path for x in ['chat','ai','conversation','qa','wendian']):
                row={'path':u.path,'status':r.status,'content_type':r.headers.get('content-type')}
                if 'application/json' in (row['content_type'] or ''):
                    try:
                        v=await r.json();row['keys']=list(v);row['data_keys']=list(v.get('data',{})) if isinstance(v.get('data'),dict) else None
                    except Exception:pass
                responses.append(row)
        page.on('request',request);page.on('response',response)
        inputs=page.locator('.ai-chat-welcome__input textarea')
        target=inputs.first
        question='请帮我找三篇关于手冲咖啡入门的小红书笔记，重点是水温和研磨度，给出可以点击打开的笔记链接。'
        if await target.count()==0:target=page.locator('.textarea-container-chat-section textarea').first
        await target.fill(question)
        # A private AI query in the explicitly identified AI-chat input; no comment form.
        await target.press('Enter')
        t=time.monotonic()
        await asyncio.sleep(3)
        while time.monotonic()-t<55:
            state=await page.evaluate('''() => ({path:location.pathname,
                text_length:document.querySelector('.chat-container')?.innerText.length,
                classes:[...new Set([...document.querySelectorAll('[class*=message],[class*=answer],[class*=markdown],[class*=citation],[class*=reference]')].map(e=>e.className))].filter(x=>typeof x==='string').slice(-30),
                links:[...document.querySelectorAll('.chat-container a')].map(e=>({text:e.innerText,path:(()=>{try{return new URL(e.href).pathname}catch{return ''}})(),class:e.className})).slice(-20),
                chat_excerpt:document.querySelector('.chat-container')?.innerText.slice(-1600)})''')
            if state.get('text_length',0)>250:break
            await asyncio.sleep(2)
        await page.screenshot(path=str(PRIVATE/'diandian-first-reply.png'))
        print(json.dumps({'elapsed_seconds':round(time.monotonic()-t),'requests':requests,'responses':responses,'state':state},ensure_ascii=False),flush=True)
        (PRIVATE/'diandian-probe-shape.json').write_text(json.dumps({'requests':requests,'responses':responses,'state':state},ensure_ascii=False,indent=2),encoding='utf-8')
        await b.close()
asyncio.run(main())
