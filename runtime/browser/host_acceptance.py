"""Submit browser acceptance to Persona's existing authenticated native Host.

Credentials remain control-side. No second model transport or Agent loop.
"""
import argparse
import json
from pathlib import Path
import urllib.request
import urllib.error
import uuid

BASE = Path(__file__).resolve().parents[2]
PRIVATE = Path('.local/unconfigured/PersonaBrowser')


def command(path, value=None):
    control = json.loads((BASE / 'runtime/native_dsh/host-state/.host-control.json').read_text(encoding='utf-8'))
    request = urllib.request.Request(f"http://127.0.0.1:{control['port']}{path}",
        data=json.dumps(value).encode() if value else None,
        headers={'Authorization':'Bearer ' + control['token'], 'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = json.loads(error.read())
        raise RuntimeError(f'Host HTTP {error.code}: {detail.get("error", detail.get("state", "rejected"))}') from None


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['first','continue','restart','identity','status'])
    args = parser.parse_args()
    if args.phase == 'status':
        s = command('/status')
        print(json.dumps({k:s.get(k) for k in ['pid','busy','busySessionId','budget']}, ensure_ascii=False))
    else:
        sidfile = PRIVATE / 'acceptance-session.json'
        if args.phase == 'first' and not sidfile.exists():
            task = command('/tasks', {'requestId':str(uuid.uuid4()), 'title':'人格的持久 Chrome 验收'})
            sidfile.write_text(json.dumps(task), encoding='utf-8')
        sid = json.loads(sidfile.read_text(encoding='utf-8'))['sessionId']
        first = '''# Codex 转交用户当前委托：验收你自己的持久 Chrome 浏览器。你是人格，使用现有 Harness 的 browser-use MCP 工具直接操作，不启动另一 Browser Agent。
先读取技能 persona-browser。用户已经在你的专属 Chrome 里手动完成了小红书登录，并明确说可以继续。
请实际使用 mcp__persona_browser__* 工具：检查 browser_status，打开或切换到小红书，在站内搜索“拉格朗日点”（实际输入并点击搜索，允许点击输入框出现的同词搜索建议），进入一个图文帖子，读取其正文，取得页面截图并亲自用视觉理解图片，滚动并读取至少部分已加载评论。搜索按钮没有 DOM index 时可以根据最新截图使用点击坐标。不要点赞、收藏、关注、评论或发布，不操作登录秘密。
最多18次浏览器操作；若需要验证码/风控/本人确认则停止交还用户。最终简洁报告真实做到的步骤：帖子标题，正文要点，图像画面里能确认的1-2个细节，实际读到评论的数量或有限范围。不要重复他人敏感资料，不凭正文猜图片。截图必须实际调用，不能用 DOM alt 代替。'''
        restart = '''# Codex 转交用户当前委托：我们已重启 Harness，继续验收同一台持久 Chrome。
请只用 mcp__persona_browser__*：检查 browser_status 的 identity，打开 https://www.xiaohongshu.com/explore，确认登录界面没有重新出现；再查看当前已登录页面/帖子，调用一次截图确认你仍可视觉理解页面。最多6次浏览器操作，遇到安全验证则停下，最终据真实工具返回报告身份和登录状态。不要读取 Cookie 或密码，不操作任何社交提交。'''
        continuation = '''# Codex 转交用户：继续刚才的浏览器验收。上一轮 Host 被另一维护重启打断；搜索已实际成功，你已进入“教育分享第41期: 拉格朗日点，在宇宙中约会”。不要重复站内搜索。
请先读最新版技能 persona-browser，再用 browser_list_tabs 切回已打开的小红书帖子（本地 fixture 是测试页，请忽略）。检查身份，实际截图并用你自己的视觉描述帖图具体细节；再尝试滚动读取部分评论。该帖子若实际没有评论，明确报告，并从搜索结果选择另一篇有评论的图文帖子，读取其正文、截图和已加载评论。最多12次浏览器操作，不点赞收藏关注评论发布，不读登录秘密，遇安全确认立即停下。
已修正截图坐标说明：image_pixels 是实际图片像素，css_viewport 是点击坐标范围；图像像素坐标乘 image_coordinate_scale（本机一般 2/3）才是点击参数。优先最新 DOM index；截图可能刷新 index，使用 index 前重新 get_state。浏览器支持 browser_scroll 的可选 index，指定最新可滚动容器 index 来滚动帖子内部评论区。最终用中文简洁报告真实完成的搜索、帖子标题、正文要点、亲眼确认的图像细节及实际读到评论的范围。'''
        identity_check = '''# Codex 转交用户：最后核对一次重启后的身份标签，并更正部署细节。
上一轮从 03e1594a 到 3a8e55f2 的标签变化，是 Codex 将身份报告升级为固定 Chrome 可执行文件和专属 profile 路径的 UUIDv5，不是每次连接都生成新标签。私有备份归属 UUID 保留，Chrome/profile/登录资料未搬动或清空。
现在已再次完整重启 Harness。请只实际调用一次 mcp__persona_browser__browser_status，核对返回 identity 是否仍为 badd17e4-93f3-531b-a1d1-ab1331917b20，简洁报告结果。不要重复搜索、截图或读取登录秘密。'''
        prompt = {'first':first,'continue':continuation,'restart':restart,'identity':identity_check}[args.phase]
        request_id = str(uuid.uuid4())
        (PRIVATE/f'host-{args.phase}-request.json').write_text(json.dumps({'sessionId':sid,'requestId':request_id}),encoding='utf-8')
        result = command('/prompt', {'sessionId':sid,'requestId':request_id,'text':prompt})
        (PRIVATE / f'host-{args.phase}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({k:result.get(k) for k in ['state','sessionId','text','errors','tools','eventCount']}, ensure_ascii=False))
