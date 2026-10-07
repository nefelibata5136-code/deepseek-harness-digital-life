"""Measure the same real 10 images with whole-page OCR and retain both outputs."""
import json,time,asyncio,re,shutil
from pathlib import Path
from export_article import ocr_image

async def main():
    root=Path(__file__).resolve().parents[2]/'reports/xiaohongshu/exports'
    src=root/'换窗之后-猎月';out=root/'换窗之后-猎月-整页OCR';out.mkdir(exist_ok=True)
    from rapidocr_onnxruntime import RapidOCR
    t=time.perf_counter();engine=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1,det_limit_side_len=960)
    rows=[];markdown=['# 换窗之后，他还是他吗？','作者：猎月','本地整页OCR，保留原始识别结果；疑似标点错误未自动改写。'];alltext=[]
    manifest=json.loads((src/'manifest.json').read_text(encoding='utf-8'))
    for item in manifest['images']:
        ts=time.perf_counter();lines=await asyncio.to_thread(ocr_image,engine,src/item['file']);text='\n'.join(x['text'] for x in lines)
        row={'index':item['index'],'ocr_ms':round((time.perf_counter()-ts)*1000),'lines':len(lines),'characters':len(text),'low_confidence_lines':sum(x['confidence']<.8 for x in lines)}
        rows.append(row);alltext.append(text);print(json.dumps(row),flush=True)
        shutil.copyfile(src/item['file'],out/item['file'])
        (out/f'{item["index"]:02d}.txt').write_text(text+'\n',encoding='utf-8')
        item['ocr_lines']=lines;item['ocr_ms']=row['ocr_ms']
        markdown.extend([f'## 图片 {item["index"]}',f'![原图]({item["file"]})',text])
    total=round((time.perf_counter()-t)*1000)
    report={'pages':len(rows),'total_ms':total,'operations':rows,'previous_tiled_total_ms':manifest['total_ms'],'all_nonempty':all(r['characters'] for r in rows),
        'method':'Local PP-OCRv4 ONNX; whole page at native source resolution; model detection resize only, recognition crops from original.'}
    manifest['images']=manifest['images'];manifest['total_ms']=total;manifest['ocr_characters']=sum(len(x) for x in alltext)
    manifest['method']='Whole-page offline OCR; original image bytes preserved';manifest['ocr_verified']=False
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'全文-OCR.md').write_text('\n\n'.join(markdown)+'\n',encoding='utf-8')
    (out/'全文-OCR.txt').write_text('\n\n'.join(alltext)+'\n',encoding='utf-8')
    (root.parent/'ocr-quality-performance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'pages':len(rows),'total_ms':total,'all_nonempty':report['all_nonempty']}),flush=True)
asyncio.run(main())
