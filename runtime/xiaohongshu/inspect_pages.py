import asyncio,json
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.connect_over_cdp('http://127.0.0.1:18745',timeout=5000)
        for page in b.contexts[0].pages:
            if 'xiaohongshu.com/search_result' in page.url:
                print(json.dumps(await page.evaluate('''() => {
                    const s=window.__INITIAL_STATE__?.search||{},u=x=>x?.value??x?._value??x;
                    return {search_keys:Object.keys(s),state:u(s.state),feed_count:u(s.feeds)?.length,
                      state_type:typeof s.state, visible_error:[...document.querySelectorAll('.error-container,.login-container,.r-captcha-modal')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.className),
                      title:document.title,body_excerpt:document.body.innerText.slice(0,180)};
                }'''),ensure_ascii=False))
        await b.close()
asyncio.run(main())
