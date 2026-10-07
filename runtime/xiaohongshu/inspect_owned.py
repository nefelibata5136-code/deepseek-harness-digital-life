import asyncio,json
from backend import Browser
async def main():
    b=Browser()
    try:
        await b.connect()
        for p in b.context.pages:
            r=await p.evaluate('''()=>({role:window.name,path:location.pathname,title:document.title,
                chats:document.querySelectorAll('.chat-container').length,
                welcome:document.querySelectorAll('.ai-chat-welcome__input').length,
                body_end:document.body?.innerText.slice(-250),
                conversation_present:!!(window.__INITIAL_STATE__?.conversation?.activeConversation?.value??window.__INITIAL_STATE__?.conversation?.activeConversation?._value),
                input_boxes:[...document.querySelectorAll('textarea')].map(e=>({class:e.className,visible:e.getBoundingClientRect().width>0}))})''')
            if r['role'].startswith('persona'):print(json.dumps(r,ensure_ascii=False),flush=True)
    finally:await b.close()
asyncio.run(main())
