import asyncio,json
from backend import Browser
async def main():
    b=Browser()
    try:
        await b.connect()
        for p in b.context.pages:
            if await p.evaluate('()=>window.name')!='persona-xhs-diandian':continue
            result=await p.evaluate('''()=>({title:document.title,boxes:[...document.querySelectorAll('textarea')].map(e=>({
                class:e.className,placeholder:e.placeholder,readOnly:e.readOnly,disabled:e.disabled,
                len:e.value.length,style:{display:getComputedStyle(e).display,opacity:getComputedStyle(e).opacity,position:getComputedStyle(e).position},
                rect:{width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height},
                ancestors:[e.parentElement,e.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement].map(x=>x?.className)}))})''')
            print(json.dumps(result,ensure_ascii=False),flush=True)
    finally:await b.close()
asyncio.run(main())
