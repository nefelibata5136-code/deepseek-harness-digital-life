import json,tempfile,unittest
from pathlib import Path
from PIL import Image
from long_article_ocr import batches
from qwen_ocr_client import parse_words
from general_ocr import OcrError
LIMITS={'batch_images':4,'max_side':10000,'max_pixels':15679488,'max_bytes':10485760}
class Qwen(unittest.TestCase):
    def test_41_images_tail_order_and_pixels(self):
        import io
        with tempfile.TemporaryDirectory() as folder:
            paths=[]
            for i in range(41):
                p=Path(folder)/f'{i}.png';Image.new('RGB',(13,21),(i,10,20)).save(p);paths.append(p)
            bs=batches(paths,LIMITS)
            self.assertEqual([len(b.spans) for b in bs],[4]*10+[1])
            self.assertEqual([s['image_index'] for b in bs for s in b.spans],list(range(1,42)))
            for b in bs:
                im=Image.open(io.BytesIO(b.png))
                for s in b.spans:self.assertEqual(im.getpixel((s['left'],s['top'])),(s['image_index']-1,10,20))
    def test_grid_restores_coordinates_and_page_order(self):
        from general_ocr import Batch
        b=Batch(b'',40,60,[{'image_index':4,'left':20,'right':40,'top':30,'bottom':60}])
        r=parse_words([{'text':'last','location':[22,50,36,50,36,54,22,54]},
                       {'text':'first','location':[22,32,36,32,36,35,22,35]}],b)
        self.assertEqual(r['pages'][0]['text'],'first\nlast');self.assertEqual(r['pages'][0]['lines'][0]['box'][0],[2,2])
    def test_invalid_provider_coordinates_never_silently_pass(self):
        from general_ocr import Batch
        b=Batch(b'',40,60,[{'image_index':1,'left':0,'right':20,'top':0,'bottom':60},{'image_index':2,'left':20,'right':40,'top':0,'bottom':60}])
        r=parse_words([{'text':'outside','location':[2,99,36,99,36,110,2,110]}],b)
        self.assertIn('OCR_LINE_OUTSIDE_ORIGINAL_IMAGE',r['warnings']);self.assertIn('OCR_PAGE_EMPTY',r['warnings'])
if __name__=='__main__':unittest.main()
