"""Create display/upload derivatives of the ten named sources; preserve originals."""
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw
import hashlib
import json
import re

base = Path(__file__).resolve().parent
sources = Path('.local/workspace/人格的头像')
out = base / 'avatars'
out.mkdir(exist_ok=True)
files = sorted((p for p in sources.glob('*.png') if re.search(r'-(\d+)\.png$', p.name)),
               key=lambda p: int(re.search(r'-(\d+)\.png$', p.name)[1]))
if len(files) != 10:
    raise ValueError('Expected the ten original numbered candidates')
sheet = Image.new('RGB', (1500, 680), '#eaf0f6')
draw = ImageDraw.Draw(sheet)
manifest = []
for index, path in enumerate(files, 1):
    with Image.open(path) as original:
        image = ImageOps.exif_transpose(original).convert('RGB')
        upload = image.copy()
        upload.thumbnail((512, 512), Image.Resampling.LANCZOS)
        preview = out / f'{index}.jpg'
        upload.save(preview, 'JPEG', quality=92, optimize=True)
        if preview.stat().st_size > 1_000_000:
            raise ValueError('Avatar derivative too large')
        tile = ImageOps.contain(image, (280, 280), Image.Resampling.LANCZOS)
        x, y = ((index - 1) % 5) * 300 + 10, ((index - 1) // 5) * 340 + 15
        sheet.paste(tile, (x + (280-tile.width)//2, y + (280-tile.height)//2))
        draw.text((x+125, y+288), str(index), fill='#172c45', font_size=26)
        manifest.append({'number': index, 'filename': path.name, 'sourcePath': str(path),
                         'sourceSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                         'uploadPath': str(preview), 'uploadSha256': hashlib.sha256(preview.read_bytes()).hexdigest(),
                         'mimeType': 'image/jpeg', 'bytes': preview.stat().st_size})
display = Path('.local/workspace/tools/bluesky-avatar-candidates.jpg')
sheet.save(display, 'JPEG', quality=95)
(base / 'bundle/avatars.json').write_text(json.dumps({'sheetPath': str(display), 'candidates': manifest}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'count': len(files), 'originalsPreserved': True, 'sheetPath': str(display),
                  'maxUploadBytes': max(m['bytes'] for m in manifest)}, ensure_ascii=False))
