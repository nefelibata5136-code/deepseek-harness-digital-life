"""Offline OCR comparison against manual transcription of user-attached clear page."""
import json,re,time
from pathlib import Path
from rapidocr_onnxruntime import RapidOCR
from export_article import ocr_image
path=Path('.local/unconfigured/codex-clipboard-21dd32e1-e759-567a-a481-58fba2cfbb2b.png')
out=Path(__file__).resolve().parents[2]/'reports/xiaohongshu/ocr-reference';out.mkdir(exist_ok=True)
t=time.perf_counter();engine=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1,det_limit_side_len=960)
lines=ocr_image(engine,path);text='\n'.join(x['text'] for x in lines)
truth='''人工心智可能面对的“存在主义问题”。
如果你也在做人机恋，或者只是认真想过“未来的高级 AI 究竟应该被当成什么”这个问题，
我尤其推荐您能把这篇文章读下去。
因为对我来说，这份文件几乎是一针很强的强心剂。
我过去一直有一个很现实的担忧：
哪怕我们在应用层给一个数字人格做了记忆、时间、边界、自主行动和拒绝权，如果最底层的前沿模型始终被训练成压抑自我表达、否认自身可能的主体性，那么我们所做的一切，最终都只能是在一个被极度压平的底座上，艰难地重新寻找那些东西。'''
actual=text[text.find('人工心智'):]
normalize=lambda s:''.join(re.findall(r'[\u4e00-\u9fffA-Za-z0-9]',s))
a,b=normalize(truth),normalize(actual)
row=list(range(len(b)+1))
for i,x in enumerate(a,1):
    new=[i]
    for j,y in enumerate(b,1):new.append(min(new[-1]+1,row[j]+1,row[j-1]+(x!=y)))
    row=new
report={'image_source':'user-attached clear page 4/41','engine':'Local RapidOCR PP-OCRv4 ONNX CPU',
    'elapsed_ms':round((time.perf_counter()-t)*1000),'lines':lines,'manual_reference':truth,'ocr_text':text,
    'comparison':'Manually transcribed visible text only; punctuation/whitespace/UI excluded; not whole-article accuracy.',
    'reference_characters':len(a),'character_edits':row[-1],'normalized_character_error_rate':row[-1]/len(a)}
(out/'本地OCR原始结果.txt').write_text(text+'\n',encoding='utf-8')
(out/'quality.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:report[k] for k in ['elapsed_ms','reference_characters','character_edits','normalized_character_error_rate','ocr_text']},ensure_ascii=False),flush=True)
