"""Prepare real original-resolution A/B assets without an API call."""
import json,hashlib
from pathlib import Path
from general_ocr import stitch
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]/'reports/xiaohongshu'
def main():
    config=json.loads((HERE/'config.json').read_text(encoding='utf-8'))['ocr']
    source=ROOT/'exports/换窗之后-猎月';out=ROOT/'general-ocr';out.mkdir(exist_ok=True,parents=True)
    paths=[source/f'{i:02d}.webp' for i in range(1,11)]
    batches=stitch(paths,config,5);rows=[]
    for i,b in enumerate(batches,1):
        (out/f'batch-{i}.png').write_bytes(b.png)
        rows.append({'batch':i,'width':b.width,'height':b.height,'bytes':len(b.png),
            'sha256':hashlib.sha256(b.png).hexdigest(),'image_indexes':[s['image_index'] for s in b.spans],
            'pixels_preserved':True,'spans':b.spans})
    report={'ready':True,'source_note_id':'6a8bab80000000001600a47f','source_image_count':10,
        'batch_count':len(batches),'batch_images':5,'batches':rows,'cloud_ocr_called':False,
        '10_in_1_permitted':False,'10_in_1_height':18000,'side_limit':16384}
    (out/'preparation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False),flush=True)
if __name__=='__main__':main()
