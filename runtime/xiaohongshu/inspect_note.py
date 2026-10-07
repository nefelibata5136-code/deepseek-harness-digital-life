import asyncio,json
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.connect_over_cdp('http://127.0.0.1:18745',timeout=5000)
        for page in b.contexts[0].pages:
            if 'xiaohongshu.com' not in page.url: continue
            role=await page.evaluate('() => window.name')
            if role!='persona-xhs-detail':continue
            print(json.dumps(await page.evaluate('''() => {
                const m=window.__INITIAL_STATE__?.note?.noteDetailMap||{}, d=Object.values(m).find(x=>x.note?.title), c=d?.comments||{};
                return {map_notes:Object.entries(m).map(([id,x])=>({id,entry_keys:Object.keys(x),note_keys:Object.keys(x.note||{}),time:x.note?.time,desc_length:x.note?.desc?.length,image_count:x.note?.imageList?.length})),
                  comment_keys:Object.keys(c),hasMore:c.hasMore,list_length:c.list?.length,
                  item_keys:Object.keys(c.list?.[0]||{}),
                  classes:[...new Set([...document.querySelectorAll('[class*=comment]')].map(e=>e.className))].filter(x=>typeof x==='string'),
                  expands:[...document.querySelectorAll('span,div')].filter(e=>/^展开.*(回复|条)/.test(e.innerText)&&e.innerText.length<30).map(e=>({class:e.className,parent:e.parentElement.className})).slice(0,10),
                  close_parents:[...document.querySelectorAll('.close-icon,.close-circle')].map(e=>({class:e.className,parent:e.parentElement.className,gparent:e.parentElement.parentElement.className}))};
            }'''),ensure_ascii=False))
        await b.close()
asyncio.run(main())
