"""User-provided short link only; test readable bytes, do not alter save permission."""
import asyncio,json
from pathlib import Path
from backend import Browser
from export_article import export
async def main():
    b=Browser()
    try:
        await b.connect()
        note=await b.resolve_short_link('https://xhslink.cn/o/33SY050t69A')
        print(json.dumps({'note_id':note['note_id'],'title':note['title'],'images':len(note['images'])},ensure_ascii=False),flush=True)
        b.persist()
        out=Path(__file__).resolve().parents[2]/'reports/xiaohongshu/exports'/('保存受限样本-'+note['note_id'])
        result=await export(b,note['note_id'],out)
        print(json.dumps({k:result[k] for k in ['title','image_count','all_images_saved','all_images_ocr_nonempty','download_ms','total_ms','ocr_characters']},ensure_ascii=False),flush=True)
    except Exception as e:
        print(json.dumps({'ok':False,'error_type':type(e).__name__,'code':getattr(e,'code',None)},ensure_ascii=False),flush=True)
    finally:await b.close()
asyncio.run(main())
