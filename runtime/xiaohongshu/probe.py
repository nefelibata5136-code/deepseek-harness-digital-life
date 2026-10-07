"""Control-side shape probe; never print raw state, cookies, URLs or tokens."""
import asyncio, json
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.connect_over_cdp('http://127.0.0.1:18745')
        ctx = b.contexts[0]
        pages = [x for x in ctx.pages if 'xiaohongshu.com' in x.url]
        print(json.dumps({'existing_xhs_tabs':len(pages)}))
        tab = await ctx.new_page()
        try:
            await tab.goto('https://www.xiaohongshu.com/explore', wait_until='domcontentloaded', timeout=20000)
            await tab.wait_for_function('() => window.__INITIAL_STATE__?.feed?.feeds', timeout=15000)
            print(json.dumps(await tab.evaluate('''() => {
                const s=window.__INITIAL_STATE__, u=x=>x?.value??x?._value??x;
                const f=u(s.feed.feeds), info=u(s.user?.userInfo);
                return {state_keys:Object.keys(s),user_keys:Object.keys(s.user||{}),user_info_keys:Object.keys(info||{}),
                    guest:info?.guest, feed_count:f?.length,feed_keys:Object.keys(f?.[0]||{}),
                    note_keys:Object.keys(f?.[0]?.noteCard||{}), cover_keys:Object.keys(f?.[0]?.noteCard?.cover||{}),
                    login_visible:!!document.querySelector('.login-container'), title:document.title};
            }'''),ensure_ascii=False))
        finally:
            await tab.close()
            await b.close()

asyncio.run(main())
