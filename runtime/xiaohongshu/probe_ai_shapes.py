import asyncio,json
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.connect_over_cdp('http://127.0.0.1:18745',timeout=15000)
        for page in b.contexts[0].pages:
            if not page.url.startswith('https://www.xiaohongshu.com/ai_chat'):continue
            if await page.evaluate('()=>window.name')!='persona-blue-link-probe':continue
            state=await page.evaluate('''() => {
                const u=x=>x?.value??x?._value??x;
                const shape=(x,d=0)=>{x=u(x);if(d>4)return Array.isArray(x)?'array':typeof x;
                    if(Array.isArray(x))return x.slice(0,1).map(y=>shape(y,d+1));
                    if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).filter(([k])=>!k.startsWith('_')&&k!=='dep').slice(0,30).map(([k,v])=>[k,shape(v,d+1)]));return typeof x;};
                const s=window.__INITIAL_STATE__,c=u(s.conversation.activeConversation),rounds=u(c?.rounds)||[];
                return {first_round:shape(rounds[0]),last_round:shape(rounds.at(-1)),
                    right_panel:shape(s.rightPanelStore),aiSearchFeedLayout:shape(s.aiSearchFeedLayout),
                    agentSession:shape(s.agentSession),buttons:[...document.querySelectorAll('.ai-input-action-btn')].map(e=>({class:e.className,disabled:e.disabled,aria:e.getAttribute('aria-label'),html_tags:[...e.children].map(x=>({tag:x.tagName,class:x.className,attrs:[...x.attributes].map(a=>a.name)}))})),
                    input_values:[...document.querySelectorAll('textarea')].map(e=>({class:e.className,placeholder:e.placeholder,len:e.value.length}))};
            }''')
            print(json.dumps(state,ensure_ascii=False))
        await b.close()
asyncio.run(main())
