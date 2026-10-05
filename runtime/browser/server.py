"""Thin deployment adapter around browser-use's official direct-action MCP server.

No model, Agent, Playwright driver, credential API or arbitrary-code tool.
Chrome lifetime belongs to browser_control, not the MCP/Harness Session.
"""
import os
os.environ.update(ANONYMIZED_TELEMETRY='false', BROWSER_USE_CLOUD_SYNC='false',
    BROWSER_USE_SETUP_LOGGING='false', BROWSER_USE_LOGGING_LEVEL='critical',
    BROWSER_USE_VERSION_CHECK='false', BROWSER_USE_CONFIG_DIR=os.path.join(os.environ['LOCALAPPDATA'], 'PersonaBrowser', 'library-config'))
# The browser subprocess receives no model/provider credentials.
for key in list(os.environ):
    if any(part in key.upper() for part in ('API_KEY', 'TOKEN', 'SECRET', 'PASSWORD')):
        os.environ.pop(key, None)
import asyncio
import json
import logging
import re
import base64
import struct
from urllib.parse import urlsplit, urlunsplit
from browser_control import ROOT, ENDPOINT, ensure
from browser_use.mcp.server import BrowserUseServer
from browser_use.browser import BrowserSession, BrowserProfile
import mcp.types as types
from mcp.server import Server
logging.disable(logging.CRITICAL)

DIRECT = {'browser_navigate', 'browser_click', 'browser_type', 'browser_get_state',
    'browser_screenshot', 'browser_scroll', 'browser_go_back', 'browser_list_tabs',
    'browser_switch_tab', 'browser_close_tab'}
PENDING = ROOT / 'human-pending.json'


def safe_url(value):
    p = urlsplit(str(value))
    return urlunsplit((p.scheme, p.hostname + (':' + str(p.port) if p.port else '') if p.hostname else '', p.path, '', ''))


def scrub(value):
    if isinstance(value, dict):
        return {k: safe_url(v) if k in {'url', 'href', 'src'} and isinstance(v, str) else scrub(v)
                for k, v in value.items() if k.lower() not in {'cookie', 'cookies', 'password', 'token', 'value'}}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r'(?i)\b(?:sk-[\w-]{16,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)', '[redacted]', value)
        value = re.sub(r'(?i)(password|authorization|access[_-]?token|refresh[_-]?token|cookie)\s*[:=]\s*[^\s,;]+', r'\1=[redacted]', value)
        value = re.sub(r'https?://[^\s"<>]+', lambda m: safe_url(m.group()), value)
    return value


# Read only rendered text and image descriptions. Never reads storage, script
# state, form values or network headers. Input values are absent from innerText.
PAGE_JS = """(() => {
 const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
 const password = [...document.querySelectorAll('input[type=password],input[autocomplete=one-time-code]')].some(visible);
 const challenge = [...document.querySelectorAll('[class*=captcha],[id*=captcha],iframe[src*=captcha],[class*=geetest],[class*=verify-slider]')].some(visible);
 const login = [...document.querySelectorAll('.login-container,.login-modal,.login-box,.login-mask')].some(visible);
 const text = document.body?.innerText || '';
 const verification = /安全验证|请完成验证|拖动滑块|访问过于频繁|异常访问|验证你的身份|verify you are human|unusual traffic/i.test(text);
 return {url: location.href, title: document.title, human_required: password || challenge || login || verification,
 text: password || challenge || login || verification ? '' : text,
 images: [...document.images].filter(visible).map(i=>({alt:i.alt,width:i.naturalWidth,height:i.naturalHeight})),
 viewport: {width: innerWidth,height: innerHeight}, device_pixel_ratio:devicePixelRatio,
 scroll: {x:scrollX,y:scrollY}};
})()"""


class PersonaBrowser(BrowserUseServer):
    def __init__(self):
        super().__init__()
        self._call_lock = asyncio.Lock()
        self.server = Server('persona-browser-use', version='0.13.10',
            instructions='人格的固定持久 Chrome。先读取技能 persona-browser。仅直接操作；human_required 时停下交给用户。')
        self._setup_handlers()
        # Retain upstream action schemas; remove second-Agent and raw HTML tools.
        upstream = self.server.get_request_handler('tools/list').handler
        async def listed(context, params):
            result = await upstream(context, params)
            tools = [t for t in result.tools if t.name in DIRECT]
            for t in tools:
                if t.name == 'browser_get_state':
                    t.input_schema['properties'].update(offset={'type':'integer','minimum':0},
                        limit={'type':'integer','minimum':1,'maximum':200})
                if t.name == 'browser_scroll':
                    t.input_schema['properties'].update(index={'type':'integer','description':'Optional current DOM index for a nested scroll area, e.g. post comments.'})
                    t.description += ' For nested comments, supply the current scroll-area index. Read again to verify new content.'
                if t.name == 'browser_click':
                    t.description += ' Coordinates are CSS viewport pixels; screenshot image_coordinate_scale gives image-pixel to CSS conversion.'
            tools.extend([
                types.Tool(name='browser_read_page', description='分页读取当前可见正文、评论、图片描述。offset 从0，按 next_offset 续读；图片内容请用截图理解。',
                    input_schema={'type':'object','properties':{'offset':{'type':'integer','minimum':0},'limit':{'type':'integer','minimum':1,'maximum':20000}}}),
                types.Tool(name='browser_status', description='固定浏览器身份、连接与人工接管状态；不读取 Cookie 或登录凭据。', input_schema={'type':'object','properties':{}})])
            return types.ListToolsResult(tools=tools)
        async def called(context, params):
            async with self._call_lock:
                try:
                    blocks = await self._dispatch(params.name, params.arguments or {})
                    return types.CallToolResult(content=blocks)
                except Exception:
                    # Upstream exceptions can contain URLs or input text.
                    return types.CallToolResult(is_error=True, content=[types.TextContent(type='text', text='Browser operation failed. Refresh browser_get_state; check local Chrome. No automatic retry.')])
        self.server.add_request_handler('tools/list', types.PaginatedRequestParams, listed)
        self.server.add_request_handler('tools/call', types.CallToolRequestParams, called)
        logging.disable(logging.CRITICAL)

    async def _init_browser_session(self, **kwargs):
        await asyncio.to_thread(ensure)
        self.browser_session = BrowserSession(browser_profile=BrowserProfile(
            cdp_url=ENDPOINT, is_local=False, keep_alive=True, headless=False,
            enable_default_extensions=False, disable_security=False))
        await self.browser_session.start()

    async def _page(self):
        session = await self.browser_session.get_or_create_cdp_session()
        result = await session.cdp_client.send.Runtime.evaluate(
            params={'expression': PAGE_JS, 'returnByValue': True}, session_id=session.session_id)
        return result['result']['value']

    async def _dispatch(self, name, args):
        text = lambda value: [types.TextContent(type='text', text=json.dumps(scrub(value), ensure_ascii=False))]
        if name not in DIRECT | {'browser_read_page', 'browser_status'}:
            raise ValueError('Tool not exposed')
        if name == 'browser_status':
            from browser_control import status
            return text({**await asyncio.to_thread(status), 'human_required': PENDING.exists()})
        if PENDING.exists():
            return text({'human_required': True, 'reason': 'Waiting for manual login/security confirmation. Human must return control using browser_control.py resume.'})
        if not self.browser_session:
            await self._init_browser_session()
        if name == 'browser_navigate':
            url = urlsplit(args['url'])
            if url.scheme not in {'https', 'http'} or url.username or url.password:
                raise ValueError('Only ordinary HTTP(S) pages allowed')
        page = await self._page()
        if page['human_required']:
            PENDING.write_text(json.dumps({'reason': 'manual_login_or_security_confirmation'}), encoding='utf-8')
            return text({'human_required': True, 'reason': 'Complete login/security verification in Chrome, then return control.'})
        if name == 'browser_type':
            element = await self.browser_session.get_dom_element_by_index(args['index'])
            attrs = element.attributes if element else {}
            if attrs.get('type') in {'password', 'tel'} or attrs.get('autocomplete') in {'one-time-code','current-password','new-password'}:
                raise ValueError('Credential entry belongs to the human')
        if name == 'browser_read_page':
            offset, limit = args.get('offset', 0), args.get('limit', 12000)
            if not isinstance(offset, int) or offset < 0 or not isinstance(limit, int) or not 1 <= limit <= 20000:
                raise ValueError('Invalid paging')
            body = page.pop('text')
            return text({**page,'text':body[offset:offset+limit], 'total_characters':len(body),
                'next_offset':offset+limit if offset+limit < len(body) else None})
        if name == 'browser_scroll' and 'index' in args:
            from browser_use.browser.events import ScrollEvent
            node = await self.browser_session.get_dom_element_by_index(args['index'])
            if node is None:
                raise ValueError('Refresh DOM state before scrolling')
            direction = args.get('direction','down')
            if direction not in {'up','down'}:
                raise ValueError('Invalid scroll direction')
            await self.browser_session.event_bus.dispatch(ScrollEvent(direction=direction,amount=500,node=node))
            result = 'Scrolled requested container '+direction
        else:
            result = await super()._execute_tool(name, args)
        after = await self._page()
        if after['human_required']:
            PENDING.write_text(json.dumps({'reason':'manual_login_or_security_confirmation'}), encoding='utf-8')
            return text({'human_required':True, 'reason':'Human login or verification required; page content and screenshots withheld.'})
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except ValueError:
                pass
            return text(result)
        blocks = []
        for block in result:
            if block.type == 'text':
                try:
                    obj = json.loads(block.text)
                except ValueError:
                    obj = block.text
                if name == 'browser_get_state' and isinstance(obj, dict):
                    elements = obj.get('interactive_elements', [])
                    offset, limit = args.get('offset', 0), args.get('limit', 60)
                    if not isinstance(offset, int) or offset < 0 or not isinstance(limit, int) or not 1 <= limit <= 200:
                        raise ValueError('Invalid state paging')
                    obj.update(interactive_elements=elements[offset:offset+limit], total_elements=len(elements),
                        next_offset=offset+limit if offset+limit < len(elements) else None)
                blocks.extend(text(obj))
            elif block.type == 'image':
                # Native Chrome screenshots use device pixels (150% Windows
                # scaling here); clicks use CSS pixels. Preserve the original
                # image and publish the actual conversion, without changing
                # Chrome viewport, desktop scaling or image contents.
                raw = base64.b64decode(block.data)
                if block.mime_type == 'image/png' and raw[:8] == b'\x89PNG\r\n\x1a\n':
                    width,height = struct.unpack('>II',raw[16:24])
                    viewport = after['viewport']
                    ratio = after['device_pixel_ratio']
                    blocks.extend(text({'image_pixels':{'width':width,'height':height},
                        'css_viewport':viewport, 'coordinate_space':'CSS viewport pixels',
                        'image_coordinate_scale':{'x':1/ratio,'y':1/ratio},
                        'coordinate_instruction':'Multiply image pixel coordinates by image_coordinate_scale before browser_click; prefer fresh DOM indices.'}))
                blocks.append(block)
        return blocks

    async def _start_cleanup_task(self):
        # No inactivity expiry, no close_all, no profile deletion. Chrome is external.
        pass


if __name__ == '__main__':
    asyncio.run(PersonaBrowser().run())
