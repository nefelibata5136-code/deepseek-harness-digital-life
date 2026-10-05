import io,tempfile,unittest
from pathlib import Path
from PIL import Image
from general_ocr import stitch,restore_pages
C={'batch_images':5,'max_side':16384,'max_pixels':167000000,'max_bytes':20*1024*1024}
class Batching(unittest.TestCase):
    def test_41_pages_preserve_pixels_order_and_last_page(self):
        with tempfile.TemporaryDirectory() as root:
            paths=[]
            for i in range(41):
                p=Path(root)/f'{i}.png';Image.new('RGB',(12,20),(i,100,200)).save(p);paths.append(p)
            batches=stitch(paths,C)
            self.assertEqual([len(b.spans) for b in batches],[5]*8+[1])
            self.assertEqual([s['image_index'] for b in batches for s in b.spans],list(range(1,42)))
            for b in batches:
                picture=Image.open(io.BytesIO(b.png))
                for s in b.spans:self.assertEqual(picture.getpixel((0,s['top'])),(s['image_index']-1,100,200))
    def test_dimension_limit_splits_without_resizing(self):
        with tempfile.TemporaryDirectory() as root:
            paths=[]
            for i in range(3):
                p=Path(root)/f'{i}.png';Image.new('RGB',(2,8000)).save(p);paths.append(p)
            batches=stitch(paths,C)
            self.assertEqual([b.height for b in batches],[16000,8000])
            self.assertEqual([b.width for b in batches],[2,2])
    def test_page_coordinates_and_boundary_warning(self):
        from general_ocr import Batch
        batch=Batch(b'',10,40,[{'image_index':1,'top':0,'bottom':20},{'image_index':2,'top':20,'bottom':40}])
        lines=[{'Text':'second','Location':{'X':1,'Y':25,'H':4}},{'Text':'first','Location':{'X':1,'Y':2,'H':3}},
            {'Text':'boundary','Location':{'X':1,'Y':19,'H':4}}]
        pages,warnings=restore_pages(lines,batch)
        self.assertEqual(pages[1][0]['text'],'first');self.assertEqual(pages[2][-1]['location']['Y'],5)
        self.assertIn('OCR_LINE_CROSSES_JOIN_BOUNDARY',warnings)
if __name__=='__main__':unittest.main()
