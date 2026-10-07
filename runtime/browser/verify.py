"""Read-only by default. --live exercises real browser-use actions on a local fixture.

No model call, credential inspection, profile deletion or backup overwrite.
"""
import argparse
import asyncio
import json
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / 'config.json').read_text(encoding='utf-8'))
ROOT = Path(CONFIG['private_root'])
REPORT = HERE.parents[1] / 'reports/browser'

HTML = '''<!doctype html><meta charset="utf-8"><title>Persona browser fixture</title>
<style>body{font:20px sans-serif;padding:35px}canvas{display:block}#space{height:1800px}</style>
<h1>Persistent browser fixture</h1><input placeholder="Fixture search"><button onclick="document.querySelector('#result').innerText='accepted:'+document.querySelector('input').value">Apply</button>
<p id=result>ready</p><p id=persistence></p><canvas width=500 height=160></canvas>
<div id=nested tabindex=0 style="height:160px;overflow:auto"><p>NESTED SCROLL</p><div style="height:1000px">Local comment fixture</div></div>
<div id=space></div><p>END OF SCROLL</p>
<script>
const existing=document.cookie.includes('persona_fixture=present')&&localStorage.getItem('persona_fixture')==='present';
document.querySelector('#persistence').innerText=existing?'PERSISTENCE_PRESENT':'PERSISTENCE_FIRST_VISIT';
document.cookie='persona_fixture=present; Max-Age=86400; Path=/; SameSite=Lax';localStorage.setItem('persona_fixture','present');
const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#132b45';c.fillRect(0,0,500,160);c.fillStyle='#ffcb35';c.beginPath();c.arc(85,80,45,0,Math.PI*2);c.fill();c.fillStyle='white';c.font='32px sans-serif';c.fillText('DL CHROME',165,90);
</script>'''


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.end_headers(); self.wfile.write(HTML.encode())
    def log_message(self, *_):
        pass


async def live():
    from server import PersonaBrowser, DIRECT, PENDING, scrub
    from browser_control import status
    if PENDING.exists():
        raise RuntimeError('Human currently owns browser; live verification refuses to proceed')
    http = ThreadingHTTPServer(('127.0.0.1', 18746), Fixture)
    thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
    s = PersonaBrowser()
    async def call(name, args=None):
        blocks = await s._dispatch(name, args or {})
        values = [json.loads(b.text) for b in blocks if b.type == 'text']
        if any(isinstance(v,dict) and v.get('human_required') for v in values):
            raise RuntimeError('Unexpected human gate; no automatic resume')
        return values[0] if values else None
    try:
        identity = status()['identity']
        await call('browser_navigate', {'url':'http://127.0.0.1:18746/', 'new_tab':True})
        initial_page = await call('browser_read_page')
        persisted_on_entry = 'PERSISTENCE_PRESENT' in initial_page['text']
        state = await call('browser_get_state', {'limit':200})
        entry = next(e for e in state['interactive_elements'] if e['tag']=='input')
        await call('browser_type', {'index':entry['index'], 'text':'fixture-search'})
        state = await call('browser_get_state', {'limit':200})
        button = next(e for e in state['interactive_elements'] if e['tag']=='button' and 'Apply' in e['text'])
        await call('browser_click', {'index':button['index']})
        page = await call('browser_read_page')
        assert 'accepted:fixture-search' in page['text']
        state = await call('browser_get_state', {'limit':200})
        nested = next(e for e in state['interactive_elements'] if e['tag']=='div' and 'NESTED SCROLL' in e['text'])
        await call('browser_scroll', {'direction':'down','index':nested['index']})
        cdp = await s.browser_session.get_or_create_cdp_session()
        nested_state = await cdp.cdp_client.send.Runtime.evaluate(params={'expression':"document.getElementById('nested').scrollTop",'returnByValue':True},session_id=cdp.session_id)
        assert nested_state['result']['value'] > 0
        await call('browser_scroll', {'direction':'down'})
        page = await call('browser_read_page')
        assert page['scroll']['y'] > 0
        blocks = await s._dispatch('browser_screenshot', {})
        import base64
        image = next(b for b in blocks if b.type == 'image')
        metadata = [json.loads(b.text) for b in blocks if b.type=='text']
        assert any(isinstance(v,dict) and v.get('coordinate_space')=='CSS viewport pixels' and v['image_coordinate_scale']['x']>0 for v in metadata)
        (ROOT/'fixture-screenshot.png').write_bytes(base64.b64decode(image.data))
        tabs = await call('browser_list_tabs')
        owned = next(t for t in tabs if t['url'].startswith('http://127.0.0.1:18746'))
        # A second fresh MCP adapter attaches to the same external Chrome.
        second = PersonaBrowser()
        await second._init_browser_session()
        await second._dispatch('browser_switch_tab', {'tab_id':owned['tab_id']})
        values = await second._dispatch('browser_navigate', {'url':'http://127.0.0.1:18746/'})
        page = json.loads((await second._dispatch('browser_read_page', {}))[0].text)
        assert 'PERSISTENCE_PRESENT' in page['text']
        assert status()['identity'] == identity
        # Pure sanitizer and rejected-tool checks, no real authentication data.
        assert '?' not in scrub({'url':'https://example.com/a?access_token=synthetic'})['url']
        assert scrub({'password':'synthetic'}) == {}
        try:
            await s._dispatch('retry_with_browser_use_agent', {})
        except ValueError:
            rejected = True
        else:
            rejected = False
        assert rejected
        # Password gate is tested only on a locally created synthetic form.
        cdp = await second.browser_session.get_or_create_cdp_session()
        await cdp.cdp_client.send.Runtime.evaluate(params={'expression':"document.body.innerHTML='<input type=password placeholder=synthetic-password>'"},session_id=cdp.session_id)
        blocked = json.loads((await second._dispatch('browser_screenshot', {}))[0].text)
        assert blocked['human_required'] and PENDING.exists()
        assert not any(b.type=='image' for b in await second._dispatch('browser_screenshot', {}))
        # Reset only our controlled local fixture; never clear a real-site gate.
        await cdp.cdp_client.send.Runtime.evaluate(params={'expression':"document.body.innerHTML='<p>Local security fixture complete</p>'"},session_id=cdp.session_id)
        PENDING.unlink()
        result = {'identity':identity,'profile':CONFIG['profile'],'navigate':True,'type':True,'click':True,
            'scroll':True,'nested_scroll':True,'read':True,'screenshot_image':True,'screenshot_coordinate_mapping':True,'tab_switch':True,
            'cookie_and_localstorage_after_new_mcp_session':True,'second_agent_entry_rejected':True,
            'cookie_and_localstorage_on_entry':persisted_on_entry,
            'password_page_withheld':True,'raw_secret_values_read':False,'model_called':False}
        REPORT.mkdir(parents=True,exist_ok=True)
        (REPORT/'local-actions.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        return result
    finally:
        # Disconnect CDP; leave externally owned Chrome and all useful tabs alive.
        if s.browser_session:
            await s.browser_session.stop()
        if 'second' in locals() and second.browser_session:
            await second.browser_session.stop()
        http.shutdown(); http.server_close()


if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--live',action='store_true'); args=parser.parse_args()
    if args.live:
        result=asyncio.run(live())
    else:
        result={'config_present':True,'chrome_present':Path(CONFIG['chrome']).is_file(),
            'profile_present':Path(CONFIG['profile']).is_dir(),
            'identity':json.loads((ROOT/'browser-identity.json').read_text(encoding='utf-8'))['id'],
            'browser_use_pinned':CONFIG['browser_use'],'profile_mutated':False,'model_called':False}
    print(json.dumps(result,ensure_ascii=False,indent=2))
