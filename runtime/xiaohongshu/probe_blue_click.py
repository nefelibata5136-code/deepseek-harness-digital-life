"""Click one existing blue reference in a separate tab, never change user's chat."""
import asyncio,json
from urllib.parse import urlsplit
from playwright.async_api import async_playwright
from backend import allowed_request
async def main():
    async with async_playwright() as p:
        b=await p.chromium.connect_over_cdp('http://127.0.0.1:18745',timeout=15000)
        ctx=b.contexts[0];original=None
        for page in ctx.pages:
            if urlsplit(page.url).path=='/ai_chat' and await page.locator('.markdown-block u').count()>0:original=page;break
        assert original,'No open blue-reference conversation'
        own=await ctx.new_page();await own.add_init_script("window.name='persona-blue-link-probe'")
        async def guard(route):
            if allowed_request(route.request.url,route.request.method):await route.continue_()
            else:await route.abort()
        await own.route('**/api/**',guard)
        await own.goto(original.url,wait_until='domcontentloaded',timeout=20000)
        await own.locator('.markdown-block u').first.wait_for(timeout=15000)
        shape=await own.evaluate('''() => {
            const u=x=>x?.value??x?._value??x;
            const shape=(x,d=0)=>{x=u(x);if(d>2)return Array.isArray(x)?'array':typeof x;
                if(Array.isArray(x))return x.slice(0,1).map(y=>shape(y,d+1));
                if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).filter(([k])=>!k.startsWith('_')&&k!=='dep').slice(0,35).map(([k,v])=>[k,shape(v,d+1)]));return typeof x;};
            const e=document.querySelector('.markdown-block u');
            return {conversation:shape(window.__INITIAL_STATE__.conversation.activeConversation),
                parent_tags:[e,e.parentElement,e.parentElement.parentElement].map(e=>({tag:e.tagName,class:e.className,attrs:[...e.attributes].map(a=>a.name)})),
                agent_adapter:shape(window.__INITIAL_STATE__.conversation.agentAdapter)};
        }''')
        before=set(ctx.pages);requests=[]
        own.on('request',lambda r:requests.append({'path':urlsplit(r.url).path,'method':r.method}) if '/api/' in r.url else None)
        await own.locator('.markdown-block u').first.click()
        await asyncio.sleep(3)
        changed=[]
        for x in [own,*[x for x in ctx.pages if x not in before]]:
            state=await x.evaluate('''() => ({path:location.pathname,title:document.title,
                visible_note:!!document.querySelector('.note-detail-mask'),
                search_keyword:document.querySelector('input#search-input')?.value,
                note_ids:Object.keys(window.__INITIAL_STATE__?.note?.noteDetailMap||{}),
                end_text:document.body.innerText.slice(-350)})''')
            changed.append(state)
        print(json.dumps({'shape':shape,'requests':requests,'after_click':changed},ensure_ascii=False),flush=True)
        await b.close()
asyncio.run(main())
