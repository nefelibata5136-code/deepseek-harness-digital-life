"""Lossless benchmark layouts; retain original image coordinate provenance."""
import io,hashlib,json
from pathlib import Path
from PIL import Image,ImageOps
from general_ocr import Batch,OcrError

def layout(paths,columns,limits):
    pictures=[]
    for p in paths:
        with Image.open(p) as src:pictures.append(ImageOps.exif_transpose(src).convert('RGB'))
    if not pictures or columns<1:raise OcrError('OCR_LAYOUT_INVALID')
    rows=[pictures[i:i+columns] for i in range(0,len(pictures),columns)]
    width=max(sum(p.width for p in row) for row in rows)
    height=sum(max(p.height for p in row) for row in rows)
    if max(width,height)>limits['max_side'] or width*height>limits['max_pixels']:
        raise OcrError('OCR_LAYOUT_EXCEEDS_DIMENSION_LIMIT')
    image=Image.new('RGB',(width,height),'white');spans=[];top=0;index=0
    for row in rows:
        left=0
        for p in row:
            index+=1;image.paste(p,(left,top))
            spans.append({'image_index':index,'left':left,'right':left+p.width,
                'top':top,'bottom':top+p.height,'width':p.width,'height':p.height})
            left+=p.width
        top+=max(p.height for p in row)
    output=io.BytesIO();image.save(output,format='PNG',compress_level=3)
    png=output.getvalue()
    if len(png)>limits['max_bytes']:raise OcrError('OCR_LAYOUT_EXCEEDS_BYTE_LIMIT')
    # Compare every original pixel against its cell after lossless PNG encoding.
    restored=Image.open(io.BytesIO(png)).convert('RGB')
    for p,s in zip(pictures,spans):
        if restored.crop((s['left'],s['top'],s['right'],s['bottom'])).tobytes()!=p.tobytes():
            raise OcrError('OCR_LAYOUT_PIXEL_VERIFICATION_FAILED')
    return Batch(png,width,height,spans)

def prepare(source,out,config):
    paths=[source/f'{i:02d}.webp' for i in range(1,6)]
    out.mkdir(parents=True,exist_ok=True);records=[]
    for name,items,columns in [('five-horizontal',paths,5),('five-vertical',paths,1),('four-grid',paths[:4],2)]:
        batch=layout(items,columns,config);p=out/(name+'.png');p.write_bytes(batch.png)
        records.append({'layout':name,'file':str(p.resolve()),'image_count':len(items),
            'width':batch.width,'height':batch.height,'bytes':len(batch.png),
            'sha256':hashlib.sha256(batch.png).hexdigest(),'pixels_preserved':True,'cells':batch.spans})
    report={'prepared':True,'model':'awaiting_user_model_identifier','api_requests':0,
        'test_order':['five-horizontal','five-vertical','four-grid'],
        'stop_after_first_quality_pass':True,'layouts':records}
    (out/'preparation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report

if __name__=='__main__':
    here=Path(__file__).resolve().parent;root=here.parents[1]/'reports/xiaohongshu'
    config=json.loads((here/'config.json').read_text(encoding='utf-8'))['ocr']
    report=prepare(root/'exports/换窗之后-猎月',root/'ocr-layouts',config)
    print(json.dumps({'prepared':True,'layouts':[{k:r[k] for k in ['layout','image_count','width','height','bytes','pixels_preserved']} for r in report['layouts']]}))
