import asyncio,json
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.connect_over_cdp('http://127.0.0.1:18745',timeout=5000)
        for page in b.contexts[0].pages:
            if not 'xiaohongshu.com' in page.url: continue
            role=await page.evaluate('() => window.name')
            if not role.startswith('persona-xhs-'):continue
            print(json.dumps(await page.evaluate('''() => ({role:window.name,
                path:location.pathname, note_state_keys:Object.keys(window.__INITIAL_STATE__?.note||{}),
                detail_ids:Object.keys(window.__INITIAL_STATE__?.note?.noteDetailMap||{}),
                relevant_text:document.body.innerText.slice(-700),
                anchors:[...document.querySelectorAll('section.note-item a')].slice(0,4).map(a=>({class:a.className,path:new URL(a.href).pathname})),
                parent_comments:document.querySelectorAll('.parent-comment').length,
                more_reply_buttons:[...document.querySelectorAll('.parent-comment')].slice(0,2).map(e=>[...e.querySelectorAll('div,span')].filter(x=>/^展开.*回复|^展开.*条/.test(x.innerText)&&x.innerText.length<35).map(x=>({class:x.className,text:x.innerText}))),
                close_classes:[...document.querySelectorAll('[class*=close]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.className).slice(0,8)})'''),ensure_ascii=False))
        await b.close()
asyncio.run(main())
