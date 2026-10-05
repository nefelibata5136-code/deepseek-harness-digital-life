"""User-authorized local original-image archive and offline OCR; no social writes."""
import asyncio,json,time,hashlib,io,argparse
from pathlib import Path
from PIL import Image,ImageOps
from backend import Browser,CONFIG

def ocr_image(engine,path):
    import numpy as np
    image=ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    lines=[]
    # Overlapping original-resolution tiles avoid global shrink on tall notes.
    stride=1400 if image.height>3000 else image.height;tile_height=1600 if image.height>3000 else image.height
    for top in range(0,image.height,stride):
        crop=image.crop((0,top,image.width,min(top+tile_height,image.height)))
        results,_=engine(np.asarray(crop),use_cls=False)
        for box,text,confidence in results or []:
            cy=sum(p[1] for p in box)/4+top
            if top>0 and cy<top+100:continue
            if top+tile_height<image.height and cy>=top+tile_height-100:continue
            lines.append({'text':text,'confidence':round(float(confidence),5),
                'box':[[round(float(x),2),round(float(y+top),2)] for x,y in box]})
        if top+tile_height>=image.height:break
    lines.sort(key=lambda x:(round(min(p[1] for p in x['box'])/8),min(p[0] for p in x['box'])))
    return lines

async def export(b,note_id,out):
    started=time.perf_counter()
    note=await b.capture_open_note(note_id)
    out.mkdir(parents=True,exist_ok=True)
    assert not out.is_symlink() and not out.is_junction()
    manifest={'note_id':note['note_id'],'title':note['title'],'author':note['author'],'text_caption':note['text'],
        'source_url':note['source_url'],'exported_at_unix':time.time(),'image_count':len(note['images']),
        'images':[],'method':'Actual image bytes accessible to the authenticated browser; no save UI or permission changes.',
        'ocr_engine':'RapidOCR ONNX Runtime local CPU','ocr_verified':False}
    for i,meta in enumerate(note['images']):
        raw=await b.image_original(meta['media_ref'])
        img=Image.open(io.BytesIO(raw));ext={'JPEG':'jpg','PNG':'png','WEBP':'webp','AVIF':'avif'}.get(img.format,'bin')
        path=out/f'{i+1:02d}.{ext}';path.write_bytes(raw)
        manifest['images'].append({'index':i+1,'file':path.name,'width':img.width,'height':img.height,
            'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)})
        print(json.dumps({'saved_image':i+1,'total':len(note['images']),'width':img.width,'height':img.height,'bytes':len(raw)}),flush=True)
    manifest['download_ms']=round((time.perf_counter()-started)*1000)
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    from long_article_ocr import LongArticleOCR
    recognized=await LongArticleOCR(CONFIG['ocr']).recognize([out/meta['file'] for meta in manifest['images']])
    manifest['ocr_engine']='qwen3.5-ocr / direct DashScope OpenAPI'
    manifest['ocr_summary']={k:v for k,v in recognized.items() if k!='pages'}
    page_map={p['image_index']:p for p in recognized['pages']}
    markdown=[f'# {note["title"]}',f'作者：{note["author"].get("nickname","")}',f'来源：{note["source_url"]}',
        '以下是qwen3.5-ocr逐页识别结果。页序对应原图；可能存在错字、漏字，请对照图片。']
    plain=[]
    for meta in manifest['images']:
        page=page_map.get(meta['index']);lines=page['lines'] if page else []
        meta['ocr_lines']=lines;meta['ocr_status']='recognized' if page else 'failed'
        text='\n'.join(x['text'] for x in lines)
        (out/f'{meta["index"]:02d}.txt').write_text(text+'\n',encoding='utf-8')
        markdown.extend([f'## 图片 {meta["index"]}',f'![原图]({meta["file"]})',text]);plain.append(text)
        print(json.dumps({'ocr_image':meta['index'],'lines':len(lines),'characters':len(text),'status':meta['ocr_status']},ensure_ascii=False),flush=True)
    (out/'全文-OCR.md').write_text('\n\n'.join(markdown)+'\n',encoding='utf-8')
    (out/'全文-OCR.txt').write_text('\n\n'.join(plain)+'\n',encoding='utf-8')
    manifest['total_ms']=round((time.perf_counter()-started)*1000)
    manifest['ocr_characters']=sum(len(x) for x in plain)
    manifest['all_images_saved']=len(manifest['images'])==manifest['image_count']
    manifest['all_images_ocr_nonempty']=all(x['ocr_lines'] for x in manifest['images'])
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    return manifest

async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--note-id',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args();b=Browser()
    try:
        await b.connect();m=await export(b,args.note_id,Path(args.output).resolve());b.persist()
        print(json.dumps({k:m[k] for k in ['title','image_count','all_images_saved','all_images_ocr_nonempty','download_ms','total_ms','ocr_characters']},ensure_ascii=False),flush=True)
    finally:await b.close()

if __name__=='__main__':asyncio.run(main())
