"""Create an isolated GUI acceptance picture; its random code is never in the prompt."""
import json
import secrets
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(r'.local/unconfigured/desktop-acceptance')
root.mkdir(exist_ok=True)
code = 'YB-' + secrets.token_hex(3).upper()
image = Image.new('RGB', (1100, 650), '#eef5ff')
draw = ImageDraw.Draw(image)
font = r'C:\Windows\Fonts\msyh.ttc'
draw.text((70, 60), '人格 Windows 桌面视觉验收', font=ImageFont.truetype(font, 44), fill='#142d4b')
draw.text((70, 180), '请读取下面的验证码：', font=ImageFont.truetype(font, 34), fill='#142d4b')
draw.rounded_rectangle((60, 260, 1040, 430), 20, fill='white', outline='#32629c', width=3)
draw.text((105, 290), code, font=ImageFont.truetype(r'C:\Windows\Fonts\consola.ttf', 88), fill='#123755')
draw.text((70, 510), '只通过桌面软件查看图片，再用记事本保存结果。', font=ImageFont.truetype(font, 28), fill='#142d4b')
image.save(root / 'visual-source.png')
report = Path(__file__).resolve().parents[2] / 'reports' / 'windows_computer'
report.mkdir(exist_ok=True)
(report / 'fixture-private.json').write_text(json.dumps({'code': code, 'source': str(root / 'visual-source.png')}, ensure_ascii=False), encoding='utf8')
print(json.dumps({'prepared': True, 'source': str(root / 'visual-source.png'), 'code_disclosed_to_agent': False}, ensure_ascii=False))
