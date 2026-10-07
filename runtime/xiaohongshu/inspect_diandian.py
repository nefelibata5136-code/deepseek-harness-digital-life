"""Discover the actual DianDian UI and read API shapes without sending a message."""
import asyncio,json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright
PRIVATE=Path('.local/unconfigured/PersonaXiaohongshu')
async def main():
    async with async_playwright() as p:
        b=await p.chromium.connect_over_cdp('http://127.0.0.1:18745',timeout=5000)
        ctx=b.contexts[0]
        page=None
        for candidate in ctx.pages:
            if 'xiaohongshu.com' in candidate.url and await candidate.evaluate('() => window.name')=='persona-diandian-research':page=candidate;break
        if page is None:
            page=await ctx.new_page()
            await page.add_init_script("window.name='persona-diandian-research'")
            await page.goto('https://www.xiaohongshu.com/explore',wait_until='domcontentloaded',timeout=20000)
        print(json.dumps(await page.evaluate('''() => ({path:location.pathname, ai_links:[...document.querySelectorAll('a')].filter(e=>/点点|问点点/.test(e.innerText)).map(e=>({label:e.innerText,path:new URL(e.href).pathname,class:e.className})).slice(0,8)})'''),ensure_ascii=False),flush=True)
        target=page.get_by_text('点点',exact=True).first
        if await target.count():
            await target.click()
            await asyncio.sleep(2)
        print(json.dumps(await page.evaluate('''() => ({path:location.pathname,
          inputs:[...document.querySelectorAll('textarea,input,[contenteditable=true]')].map(e=>({tag:e.tagName,placeholder:e.getAttribute('placeholder'),class:e.className})),
          buttons:[...document.querySelectorAll('button')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({text:e.innerText,class:e.className,aria:e.getAttribute('aria-label')})).slice(-15),
          ai_classes:[...new Set([...document.querySelectorAll('[class*=chat],[class*=wendian],[class*=ai-input]')].map(e=>e.className))].filter(x=>typeof x==='string').slice(-25),
          text_excerpt:document.body.innerText.slice(-600)})'''),ensure_ascii=False),flush=True)
        PRIVATE.mkdir(exist_ok=True,parents=True)
        await page.screenshot(path=str(PRIVATE/'diandian-ui.png'))
        await b.close()
asyncio.run(main())
