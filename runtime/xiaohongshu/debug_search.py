import asyncio,json
from backend import Browser
async def main():
    b=Browser()
    try:
        r=await b.call('search',lambda:b.search('咖啡',limit=3))
        print(json.dumps({'ok':r['ok'],'error':r.get('error'),'blocked_paths':b.blocked_paths},ensure_ascii=False))
    finally: await b.close()
asyncio.run(main())
