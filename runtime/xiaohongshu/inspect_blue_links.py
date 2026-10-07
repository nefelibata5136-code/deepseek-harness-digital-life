"""Inspect already open AI chats read-only. Never navigate or submit in user tabs."""
import asyncio,json
from urllib.parse import urlsplit
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    output=[]
    async with async_playwright() as p:
        b=await p.chromium.connect_over_cdp('http://127.0.0.1:18745',timeout=15000)
        for page in b.contexts[0].pages:
            if urlsplit(page.url).path!='/ai_chat':continue
            state=await page.evaluate('''() => ({role:window.name,title:document.title,
                initial_keys:Object.keys(window.__INITIAL_STATE__||{}),
                chat_title:document.querySelector('.chat-title')?.innerText,
                messages:[...document.querySelectorAll('.user-message__text,.markdown-block')].map(e=>({class:e.className,text:e.innerText.slice(0,100)})),
                refs:[...document.querySelectorAll('.chat-container a,.chat-container [class*=reference],.chat-container [class*=link]')].map(e=>({tag:e.tagName,class:e.className,text:e.innerText.slice(0,100),path:(()=>{try{return new URL(e.getAttribute('href'),location.href).pathname}catch{return null}})(),attribute_names:[...e.attributes].map(a=>a.name),vue:!!e.__vueParentComponent})).slice(-40),
                blue_elements:[...document.querySelectorAll('.markdown-block *')].filter(e=>e.textContent.trim().startsWith('《')&&e.textContent.length<120).map(e=>({tag:e.tagName,class:e.className,text:e.textContent,attributes:[...e.attributes].map(a=>a.name),color:getComputedStyle(e).color,vue_props:Object.keys(e.__vueParentComponent?.props||{}),parent_class:e.parentElement.className})).slice(0,25),
                conversation_shape:Object.fromEntries(Object.entries(window.__INITIAL_STATE__?.conversation||{}).map(([k,v])=>[k,typeof v==='object'&&v!==null?Object.keys(v).slice(0,15):typeof v])),
                buttons:[...document.querySelectorAll('.chat-container button')].map(e=>({text:e.innerText,class:e.className})).slice(-12),
                textareas:[...document.querySelectorAll('textarea')].map(e=>({class:e.className,parent:e.parentElement.className,visible:e.getBoundingClientRect().width>0})),
                ai_classes:[...new Set([...document.querySelectorAll('[class*=chat],[class*=stream],[class*=loading]')].map(e=>e.className))].filter(x=>typeof x==='string').slice(-35)})''')
            output.append(state)
        await b.close()
    Path('.local/unconfigured/blue-link-shape.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(output,ensure_ascii=False))

asyncio.run(main())
