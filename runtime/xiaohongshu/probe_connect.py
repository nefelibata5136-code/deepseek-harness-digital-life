import asyncio,time
from backend import Browser
async def main():
    b=Browser();t=time.monotonic()
    try:
        await b.connect();print('connected',round(time.monotonic()-t,2),'pages',len(b.context.pages),flush=True)
    except Exception as e:
        print('connect_error',type(e).__name__,round(time.monotonic()-t,2),flush=True)
        # Only fixed connection-log milestones, never browser endpoint strings.
        message=str(e)
        print({k:k in message for k in ['ws connected','retrieving websocket url','browser endpoint','closed','timed out']},flush=True)
    finally:await b.close()
asyncio.run(main())
