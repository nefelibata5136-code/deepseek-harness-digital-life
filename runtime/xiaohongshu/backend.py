"""Persistent, read-only XHS browser adapter. Secrets never cross the public boundary.

Browser-owned encrypted Chrome profile is the login persistence mechanism.
Only fixed navigation/filter/scroll/reply-expansion operations are implemented.
There is no raw navigation, cookie export, script execution or social-write interface.
"""
import asyncio
import base64
from collections import OrderedDict
import hashlib
import io
import json
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlencode, urlsplit,parse_qs

import httpx
from PIL import Image, ImageOps
from playwright.async_api import async_playwright, TimeoutError as BrowserTimeout
from private_state import PrivateState
from diandian import DianDian
from cdp_scope import ScopedCDP

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / 'config.json').read_text(encoding='utf-8'))
SITE_JS = (HERE / 'site.js').read_text(encoding='utf-8')
BASE = 'https://www.xiaohongshu.com'
FILTERS = {
    'sort_by': ('排序依据', {'relevance':'综合','latest':'最新','most_liked':'最多点赞','most_commented':'最多评论','most_collected':'最多收藏'}),
    'note_type': ('笔记类型', {'all':'不限','image':'图文','video':'视频'}),
    'publish_time': ('发布时间', {'all':'不限','day':'一天内','week':'一周内','half_year':'半年内'}),
    'search_scope': ('搜索范围', {'all':'不限','viewed':'已看过','unviewed':'未看过','following':'已关注'}),
    'location': ('位置距离', {'all':'不限','same_city':'同城','nearby':'附近'}),
}
SECRET_KEY = re.compile(r'cookie|authorization|xsec.?token|access.?token|refresh.?token|password|session.?id|track.?id', re.I)
ID = re.compile(r'^[a-fA-F0-9]{24}$')
READ_POSTS = {'/api/sns/web/v1/homefeed', '/api/sns/web/v1/search/notes', '/api/sns/web/v2/search/notes',
              '/api/sns/web/v1/search/usersearch', '/api/sns/web/v1/search/onebox', '/api/sns/web/v1/feed',
              '/api/sns/web/v1/config', '/api/im/web/users/following/all'}

class PublicError(Exception):
    def __init__(self, code, action='retry', retryable=True):
        self.code, self.action, self.retryable = code, action, retryable
        super().__init__(code)

def allowed_request(url, method):
    """Deny unknown state-changing API calls in our tabs, before transmission."""
    u = urlsplit(url)
    if u.hostname and (u.hostname.endswith('.xiaohongshu.com') or u.hostname == 'xiaohongshu.com'):
        if u.path.startswith('/api/'):
            if any(x in u.path.lower() for x in ['/like', '/unlike', '/collect', '/uncollect', '/follow', '/unfollow', '/publish', '/delete', '/comment/post', '/comment/reply', '/logout']):
                return False
            if method not in ('GET','HEAD','OPTIONS'):
                return u.path in READ_POSTS or u.path.startswith(('/api/sns/web/v1/login/', '/api/sns/web/v2/login/', '/api/sns/web/v1/qrcode/', '/api/sns/web/v2/qrcode/', '/api/sec/', '/api/redcaptcha/'))
    return method in ('GET','HEAD','OPTIONS')

def source(url):
    if not isinstance(url, str): return None
    if url.startswith('//'): url = 'https:' + url
    u = urlsplit(url)
    if u.scheme not in ('http','https'): return None
    return f'{u.scheme}://{u.hostname}{u.path}'

def media_url(obj):
    if not isinstance(obj, dict): return None
    for key in ('urlDefault','url','urlPre','masterUrl'):
        if obj.get(key): return obj[key]
    for item in obj.get('infoList', []):
        if item.get('url'): return item['url']
    return None

class Browser:
    site_js=SITE_JS
    error=PublicError
    def __init__(self):
        self.playwright = self.browser = self.context = None
        self.tabs = {}
        self.note_refs = OrderedDict()
        self.note_ids = {}
        self.user_refs = OrderedDict()
        self.media_refs = OrderedDict()
        self.collections = OrderedDict()
        self.secret_values = set()
        self.lock = asyncio.Lock()
        self.last_navigation = 0
        self.stage = 'idle'
        self.search_key = None
        self.search_keyword = None
        self.search_filters = {}
        self.active_note = None
        self.current_user = None
        self.started = time.time()
        self.stats = {'calls':0,'browser_connections':0,'navigations':0,'blocked_writes':0,'timeouts':0}
        self.blocked_paths = {}
        self.latencies = []
        self.http = httpx.AsyncClient(timeout=12, follow_redirects=False, trust_env=False)
        self.store=PrivateState(CONFIG['private_root'])
        saved=self.store.load()
        self.note_refs=OrderedDict(saved.get('notes',[]))
        self.user_refs=OrderedDict(saved.get('users',[]))
        self.collections=OrderedDict(saved.get('collections',[]))
        for data in [*self.note_refs.values(),*self.user_refs.values()]:
            if data.get('token'):self.secret_values.add(data['token'])
        self.state_error=self.store.error
        self.ai=DianDian(self,saved)
        self.scoped_cdp=None
        from export_jobs import Exports
        self.exports=Exports(self,CONFIG['private_root'])

    def persist(self):
        notes=[(ref,{k:v for k,v in data.items() if k!='detail'}) for ref,data in self.note_refs.items()]
        self.store.save({'notes':notes,'users':list(self.user_refs.items()),'collections':list(self.collections.items()),**self.ai.export()})

    def sanitize(self, value):
        if isinstance(value, dict):
            return {k:self.sanitize(v) for k,v in value.items() if not SECRET_KEY.search(k)}
        if isinstance(value, list): return [self.sanitize(v) for v in value]
        if isinstance(value, str):
            for token in self.secret_values:
                if len(token) >= 8: value = value.replace(token, '[redacted]')
            return re.sub(r'(?i)(xsec_token|access_token|authorization|cookie)\s*[=:]\s*[^\s,;"<>]+', r'\1=[redacted]', value)
        return value

    async def call(self, operation, fn):
        started = time.perf_counter()
        try:
            await asyncio.wait_for(self.lock.acquire(), CONFIG['queue_timeout_seconds'])
        except TimeoutError:
            return {'ok':False,'error':{'code':'BUSY','next_action':'retry','retryable':True},'elapsed_ms':round((time.perf_counter()-started)*1000)}
        try:
            async with asyncio.timeout(CONFIG['operation_timeout_seconds']):
                self.stage=operation+'.connect'
                await self.connect()
                self.stage=operation+'.read'
                data = await fn()
            result = {'ok':True,'data':self.sanitize(data)}
        except PublicError as e:
            result = {'ok':False,'error':{'code':e.code,'next_action':e.action,'retryable':e.retryable}}
        except (TimeoutError, BrowserTimeout):
            self.stats['timeouts'] += 1
            result = {'ok':False,'error':{'code':'TIMEOUT','stage':self.stage,'next_action':'inspect_health_then_retry','retryable':True}}
        except Exception as e:
            # Never stringify browser exceptions: their messages contain signed URLs.
            result = {'ok':False,'error':{'code':'BROWSER_READ_FAILED','stage':self.stage,'error_type':type(e).__name__,'next_action':'inspect_health','retryable':True}}
        finally:
            try:self.persist();self.state_error=self.store.error
            except Exception:self.state_error='REFERENCE_STORE_SAVE_FAILED'
            self.lock.release()
        result['elapsed_ms'] = round((time.perf_counter()-started)*1000)
        self.stats['calls'] += 1
        self.latencies.append({'operation':operation,'elapsed_ms':result['elapsed_ms'],'ok':result['ok']})
        self.latencies = self.latencies[-200:]
        return result

    async def connect(self):
        if self.browser and self.browser.is_connected(): return
        if self.playwright: await self.playwright.stop()
        if self.scoped_cdp:await self.scoped_cdp.close()
        self.playwright = await async_playwright().start()
        try:
            probe=await self.http.get(CONFIG['cdp_url']+'/json/version',timeout=2)
            alive=probe.status_code==200
        except Exception:alive=False
        if not alive:
            proc = await asyncio.create_subprocess_exec(CONFIG['browser_python'], '-X','utf8', CONFIG['browser_control'],'open',
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await asyncio.wait_for(proc.wait(), 12)
        # CDP must enumerate already open pages on cold connection. Do not
        # mistakenly launch the browser again when that enumeration takes >5s.
        self.scoped_cdp=ScopedCDP(self.http,CONFIG['cdp_url'])
        endpoint=await self.scoped_cdp.start()
        self.browser = await self.playwright.chromium.connect_over_cdp(endpoint, timeout=10000)
        self.context = self.browser.contexts[0]
        self.stats['browser_connections'] += 1
        self.tabs = {}
        self.search_key = self.active_note = self.current_user = None
        self.search_keyword=None
        self.search_filters={}
        self.ai.current=None

    async def page(self, kind):
        page = self.tabs.get(kind)
        if page and not page.is_closed(): return page
        for candidate in self.context.pages:
            if not candidate.url.startswith(BASE): continue
            try:
                if await asyncio.wait_for(candidate.evaluate('() => window.name'),.5) == 'persona-xhs-'+kind:
                    page=candidate; break
            except Exception: pass
        else:
            page = await self.context.new_page()
        await page.add_init_script("window.name = " + json.dumps('persona-xhs-'+kind))
        page.set_default_timeout(5000)
        page.set_default_navigation_timeout(15000)
        async def guard(route):
            if allowed_request(route.request.url, route.request.method): await route.continue_()
            else:
                self.stats['blocked_writes'] += 1
                path=urlsplit(route.request.url).path
                self.blocked_paths[path]=self.blocked_paths.get(path,0)+1
                await route.abort('blockedbyclient')
        await page.route('**/api/**', guard)
        # Playwright routing otherwise disables the HTTP cache, making every note reload
        # download the same application chunks. Restore Chrome's cache explicitly.
        cdp=await self.context.new_cdp_session(page)
        await cdp.send('Network.setCacheDisabled',{'cacheDisabled':False})
        await cdp.detach()
        self.tabs[kind] = page
        return page

    async def evaluate(self, page, expr, arg=None):
        return await page.evaluate(f'(arg) => {{ {SITE_JS}\n return ({expr})(arg); }}', arg)

    async def wait(self, page, expr, arg=None, timeout=14000):
        await page.wait_for_function(f'(arg) => {{ {SITE_JS}\n return ({expr})(arg); }}', arg=arg, timeout=timeout, polling=100)

    async def navigate(self, page, url):
        remaining = CONFIG['min_navigation_interval_seconds']-(time.monotonic()-self.last_navigation)
        if remaining > 0: await asyncio.sleep(remaining)
        await page.goto(url, wait_until='commit')
        self.last_navigation = time.monotonic()
        self.stats['navigations'] += 1

    async def ensure_readable(self, page):
        sig = await self.evaluate(page, '() => loginSignals()')
        if sig['challenge']: raise PublicError('HUMAN_VERIFICATION_REQUIRED','complete_verification_in_browser',False)
        if not sig['logged_in']: raise PublicError('LOGIN_REQUIRED','open_local_login_page',False)

    async def close_note(self, p):
        closed=await p.evaluate('''() => {
            const e=document.querySelector('.close-circle');
            if(e&&e.getBoundingClientRect().width>0){e.click();return true;}
            return false;
        }''')
        if closed:
            await p.locator('.close-circle').wait_for(state='hidden',timeout=3000)
            if self.tabs.get('active_detail') is p:self.active_note=None

    async def status(self, refresh=False):
        p = await self.page('feed')
        await self.close_note(p)
        if refresh or not p.url.startswith(BASE): await self.navigate(p, BASE+'/explore')
        await self.wait(p, '() => loginSignals().ready')
        sig = await self.evaluate(p, '() => loginSignals()')
        sig.update({'login_persistence':'encrypted_chrome_profile','login_url':f'http://127.0.0.1:{CONFIG["port"]}/login',
                    'next_action':'use_read_tools' if sig['logged_in'] and not sig['challenge'] else 'complete_login_in_browser'})
        return sig

    async def login(self):
        status = await self.status(refresh=True)
        p = await self.page('feed')
        if status['logged_in']: return status
        if not status['login_visible']:
            btn = p.locator('.login-btn, .login-button').first
            if await btn.count(): await btn.click()
        # Human scans the actual browser. No QR bytes, credentials or challenge solving in model output.
        await p.bring_to_front()
        return {**status,'next_action':'scan_qr_in_open_browser_then_check_status','browser_shown':True}

    def remember_user(self, user):
        uid = user.get('userId') or user.get('user_id')
        if not uid or not ID.fullmatch(uid): return {'nickname':user.get('nickname') or user.get('nickName','')}
        token = user.get('xsecToken') or user.get('xsec_token') or ''
        if token: self.secret_values.add(token)
        ref = 'u_'+uid
        self.user_refs[ref] = {'id':uid,'token':token or self.user_refs.get(ref,{}).get('token','')}
        while len(self.user_refs) > 1000: self.user_refs.popitem(last=False)
        return {'user_ref':ref,'user_id':uid,'nickname':user.get('nickname') or user.get('nickName',''),
                'profile_url':BASE+'/user/profile/'+uid,'avatar_url':source(user.get('avatar'))}

    def remember_media(self, obj, note_ref, index, kind='image'):
        url = media_url(obj)
        if not url: return None
        ref = 'm_'+hashlib.sha256((note_ref+str(index)+kind).encode()).hexdigest()[:20]
        self.media_refs[ref] = {'url':url,'kind':kind,'note_ref':note_ref,'index':index}
        self.media_refs.move_to_end(ref)
        while len(self.media_refs)>2000: self.media_refs.popitem(last=False)
        return {'media_ref':ref,'index':index,'kind':kind,'width':obj.get('width'),'height':obj.get('height')}

    def remember_feed(self, feed):
        nid = feed.get('id') or feed.get('noteId')
        card = feed.get('noteCard') or feed.get('note_card') or feed
        if not nid or not ID.fullmatch(nid): return None
        token = feed.get('xsecToken') or feed.get('xsec_token') or card.get('xsecToken') or card.get('xsec_token') or ''
        if token: self.secret_values.add(token)
        ref = 'n_'+nid
        self.note_ids[nid] = ref
        old = self.note_refs.get(ref, {})
        self.note_refs[ref] = {**old,'id':nid,'token':token or old.get('token',''),'source':'pc_search' if self.search_key else 'pc_feed'}
        self.note_refs.move_to_end(ref)
        # References in retained collections survive full-detail cache eviction.
        pinned={x['note_ref'] for c in self.collections.values() for x in c['items']}
        for candidate in list(self.note_refs):
            if len(self.note_refs)<=4000:break
            if candidate not in pinned:self.note_refs.pop(candidate)
        return {'note_ref':ref,'note_id':nid,'title':card.get('displayTitle') or card.get('display_title') or card.get('title',''),
                'type':card.get('type'),'author':self.remember_user(card.get('user',{})),
                'interactions':self.sanitize(card.get('interactInfo') or card.get('interact_info',{})),
                'cover':self.remember_media(card.get('cover',{}),ref,0), 'source_url':BASE+'/explore/'+nid}

    def feeds(self, raw):
        out, seen = [], set()
        for item in raw:
            if not isinstance(item,dict): continue
            f = self.remember_feed(item)
            if f and f['note_ref'] not in seen:
                seen.add(f['note_ref']); out.append(f)
        return out

    def collection(self, kind, key, items):
        cid = 'c_'+secrets.token_hex(8)
        self.collections[cid] = {'kind':kind,'key':key,'items':items}
        while len(self.collections)>30: self.collections.popitem(last=False)
        return cid

    async def feed(self, collection_ref=None, offset=0, limit=10, refresh=False):
        p = await self.page('feed')
        if refresh or not p.url.startswith(BASE+'/explore'): await self.navigate(p, BASE+'/explore')
        await self.wait(p, '() => feedState("feed").length > 0 || loginSignals().login_visible || loginSignals().challenge')
        await self.ensure_readable(p)
        return await self.list_page(p,'feed',None,collection_ref,offset,limit)

    async def list_page(self,p,kind,key,collection_ref,offset,limit):
        if not 0<=offset<=1000 or not 1<=limit<=20: raise PublicError('INVALID_ARGUMENT','correct_input',False)
        items = self.feeds(await self.evaluate(p,'kind => feedState(kind)',kind))
        if collection_ref:
            c = self.collections.get(collection_ref)
            if not c or c['kind']!=kind or c['key']!=key: raise PublicError('COLLECTION_EXPIRED','restart_feed_or_search',False)
            known = {x['note_ref'] for x in c['items']}
            c['items'].extend(x for x in items if x['note_ref'] not in known)
        else:
            collection_ref = self.collection(kind,key,items)
            c = self.collections[collection_ref]
        if offset+limit>len(c['items']):
            before = {x['note_ref'] for x in items}
            for _ in range(3):
                await p.evaluate('() => window.scrollBy(0, Math.max(window.innerHeight,900))')
                try:
                    await self.wait(p,'a => feedState(a.kind).some(x => !a.ids.includes(x.id))',{'kind':kind,'ids':[x['note_id'] for x in items]},timeout=3000)
                except BrowserTimeout: break
                items = self.feeds(await self.evaluate(p,'kind => feedState(kind)',kind))
                known = {x['note_ref'] for x in c['items']}
                c['items'].extend(x for x in items if x['note_ref'] not in known)
                if offset+limit<=len(c['items']): break
        result = c['items'][offset:offset+limit]
        return {'collection_ref':collection_ref,'items':result,'offset':offset,'next_offset':offset+len(result),
                'loaded_count':len(c['items']),'may_have_more':bool(result),'exhaustive':False}

    async def search(self, keyword, filters=None, collection_ref=None, offset=0, limit=10):
        if not isinstance(keyword,str) or not 1<=len(keyword.strip())<=200: raise PublicError('INVALID_ARGUMENT','correct_input',False)
        filters = filters or {}
        if not isinstance(filters,dict) or any(k not in FILTERS or v not in FILTERS[k][1] for k,v in filters.items()):
            raise PublicError('INVALID_FILTER','correct_input',False)
        key = json.dumps([keyword,filters],sort_keys=True,ensure_ascii=False)
        p = await self.page('search')
        await self.close_note(p)
        if self.search_key!=key:
            if self.search_keyword!=keyword:
                self.stage='search.navigate'
                await self.navigate(p,BASE+'/search_result?'+urlencode({'keyword':keyword,'source':'web_explore_feed'}))
                self.stage='search.results'
                await self.wait(p,'() => unwrap(initial().search?.state)==="success" || unwrap(initial().search?.state)==="error" || loginSignals().login_visible || loginSignals().challenge')
                await self.ensure_readable(p)
                if await self.evaluate(p,'() => unwrap(initial().search?.state)') == 'error':
                    raise PublicError('SEARCH_FAILED','inspect_health_then_retry')
                self.search_filters={}
            changed={k:filters.get(k,'relevance' if k=='sort_by' else 'all') for k in FILTERS
                if filters.get(k,'relevance' if k=='sort_by' else 'all')!=self.search_filters.get(k,'relevance' if k=='sort_by' else 'all')}
            if changed:
                self.stage='search.filter_panel'
                await p.locator('div.filter').first.hover()
                await p.locator('div.filter-panel').wait_for(state='visible')
                for field, value in changed.items():
                    group, options = FILTERS[field]
                    option = options[value]
                    self.stage='search.filter.'+field
                    # Await the actual filtered search response, not an old success
                    # flag from the preceding result list.
                    async with p.expect_response(lambda r:urlsplit(r.url).path in ('/api/sns/web/v1/search/notes','/api/sns/web/v2/search/notes') and r.request.method=='POST',timeout=10000) as response:
                        clicked=await p.evaluate('''a => {
                        const rows=[...document.querySelectorAll('div.filter-panel div.filters, div.filter-panel div.filter-group')];
                        const row=rows.find(e=>[...e.children].some(x=>x.textContent.trim()===a.group));
                        const target=row&&[...row.querySelectorAll('.tags')].find(e=>e.textContent.trim()===a.option);
                        if(!target)return 'missing';
                        if(target.classList.contains('active'))return 'already_active';
                        target.click();return 'clicked';
                        }''',{'group':group,'option':option})
                        if clicked!='clicked':raise PublicError('FILTER_LAYOUT_CHANGED','inspect_service',False)
                    r=await response.value
                    body=await r.json()
                    if r.status!=200 or not body.get('success'):raise PublicError('SEARCH_FILTER_FAILED','retry_search')
                    await self.wait(p,'() => unwrap(initial().search?.state)==="success"')
                    self.search_filters[field]=value
                await p.mouse.move(50,50)
            self.search_key = key
            self.search_keyword=keyword
        return {**await self.list_page(p,'search',key,collection_ref,offset,limit),'keyword':keyword,'filters':filters}

    async def load_note(self, note_ref):
        data = self.note_refs.get(note_ref)
        if not data: raise PublicError('NOTE_REFERENCE_EXPIRED','get_feed_or_search_again',False)
        p = await self.page('detail')
        if self.active_note==note_ref:
            complete=await self.evaluate(p,'id => !!detailState(id)?.note?.time',data['id'])
            if not complete:self.active_note=None
        if self.active_note != note_ref:
            params = {'xsec_source':data['source']}
            if data['token']: params['xsec_token'] = data['token']
            self.stage='note.navigate'
            await self.navigate(p,BASE+'/explore/'+data['id']+'?'+urlencode(params))
            self.stage='note.wait_complete'
            await self.wait(p,'id => !!detailState(id)?.note?.time || location.pathname==="/404" || loginSignals().login_visible || loginSignals().challenge',data['id'])
            if await p.evaluate('() => location.pathname')=='/404':raise PublicError('NOTE_UNAVAILABLE','choose_another_note',False)
            await self.ensure_readable(p)
            self.active_note=note_ref
        return p,data

    async def capture_open_note(self,note_id=None):
        if note_id is not None and not ID.fullmatch(note_id):raise PublicError('INVALID_ARGUMENT','correct_input',False)
        if note_id and 'n_'+note_id in self.note_refs:return await self.detail('n_'+note_id)
        for p in reversed(self.context.pages):
            if not p.url.startswith(BASE):continue
            raw=await self.evaluate(p,'id => {const map=unwrap(initial().note?.noteDetailMap)||{};return id?map[id]:Object.values(map).find(x=>x?.note?.time);}',note_id)
            if not raw or not raw.get('note',{}).get('time'):continue
            n=raw['note'];nid=n.get('noteId') or note_id
            if not nid or not ID.fullmatch(nid):continue
            token=parse_qs(urlsplit(p.url).query).get('xsec_token',[''])[0] or n.get('xsecToken','')
            card=self.remember_feed({'id':nid,'xsecToken':token,'noteCard':n})
            self.note_refs[card['note_ref']]['detail']=raw
            return await self.detail(card['note_ref'])
        raise PublicError('NOTE_NOT_OPEN','open_note_in_browser_then_capture',False)

    async def resolve_short_link(self,short_link):
        if not isinstance(short_link,str) or not re.fullmatch(r'https://xhslink\.(?:cn|com)/[A-Za-z0-9/_-]{2,150}',short_link):
            raise PublicError('INVALID_SHARE_LINK','use_xhslink_short_link_without_query',False)
        url=short_link
        for _ in range(5):
            u=urlsplit(url)
            if u.scheme!='https' or u.hostname not in ('xhslink.cn','xhslink.com','www.xiaohongshu.com'):
                raise PublicError('UNSUPPORTED_SHARE_REDIRECT','open_note_in_browser_then_capture',False)
            match=re.search(r'/(?:explore|discovery/item)/([a-fA-F0-9]{24})',u.path)
            if match:
                nid=match.group(1);token=parse_qs(u.query).get('xsec_token',[''])[0]
                if token:self.secret_values.add(token)
                self.note_refs['n_'+nid]={'id':nid,'token':token,'source':parse_qs(u.query).get('xsec_source',['pc_share'])[0]}
                return await self.detail('n_'+nid)
            response=await self.http.get(url,headers={'User-Agent':'Mozilla/5.0'},timeout=8)
            if not response.is_redirect:raise PublicError('SHARE_LINK_NOT_RESOLVED','open_note_in_browser_then_capture',False)
            url=str(response.url.join(response.headers.get('location','')))
        raise PublicError('SHARE_REDIRECT_LIMIT','open_note_in_browser_then_capture',False)

    def comments_public(self, comments):
        if not isinstance(comments,dict): return []
        out = []
        for c in comments.get('list',[]):
            out.append({'comment_id':c.get('id'),'text':c.get('content',''),'created_at_ms':c.get('createTime'),
                'like_count':c.get('likeCount'),'author':self.remember_user(c.get('userInfo',{})),
                'reply_count':c.get('subCommentCount'), 'has_more_replies':c.get('subCommentHasMore'),
                'replies':self.comments_public({'list':c.get('subComments',[])})})
        return out

    async def detail(self,note_ref):
        data=self.note_refs.get(note_ref)
        if not data:raise PublicError('NOTE_REFERENCE_EXPIRED','get_feed_or_search_again',False)
        raw=data.get('detail')
        if raw is None:
            p,data = await self.load_note(note_ref)
            raw = await self.evaluate(p,'id => detailState(id)',data['id'])
            data['detail']=raw
            cached=[x for x in self.note_refs.values() if x.get('detail')]
            for x in cached[:-CONFIG['max_cached_notes']]:x.pop('detail',None)
        n = raw['note']
        # Store sensitive fields privately even if site shape changes.
        if n.get('xsecToken'): self.secret_values.add(n['xsecToken'])
        images = [self.remember_media(x,note_ref,i+1) for i,x in enumerate(n.get('imageList',[]))]
        videos = []
        v = n.get('video') or {}
        for codec, streams in (v.get('media',{}).get('stream',{}) or {}).items():
            for i,s in enumerate(streams):
                m = self.remember_media(s,note_ref,i+1+len(videos),'video')
                if m: videos.append({**m,'codec':codec,'duration_ms':s.get('duration'),'quality':s.get('qualityType')})
        return {'note_ref':note_ref,'note_id':data['id'],'title':n.get('title',''),'text':n.get('desc',''),
                'type':n.get('type'),'created_at_ms':n.get('time'),'author':self.remember_user(n.get('user',{})),
                'interactions':self.sanitize(n.get('interactInfo',{})),'images':[x for x in images if x],
                'videos':videos,'source_url':BASE+'/explore/'+data['id'],
                'comments':{'items':self.comments_public(raw.get('comments',{}))[:10], 'exhaustive':False},
                'image_instruction':'Call xhs_read_images with note_ref; metadata alone is not visual evidence.'}

    async def comments(self,note_ref,offset=0,limit=20,expand_replies=False):
        if not 0<=offset<=1000 or not 1<=limit<=50: raise PublicError('INVALID_ARGUMENT','correct_input',False)
        p,data = await self.load_note(note_ref)
        deadline = time.monotonic()+12
        async def read(): return (await self.evaluate(p,'id => detailState(id)',data['id'])).get('comments',{})
        raw = await read()
        self.stage='comments.scroll'
        while len(raw.get('list',[]))<offset+limit and raw.get('hasMore',True) and time.monotonic()<deadline:
            before = len(raw.get('list',[]))
            await p.evaluate('''() => {
                const last=[...document.querySelectorAll('.parent-comment')].at(-1);
                if(last)last.scrollIntoView({block:'end'});
                const sc=document.querySelector('.note-scroller')||document.querySelector('.comments-container');
                if(sc)sc.scrollTop+=900; else window.scrollBy(0,900);
            }''')
            try: await self.wait(p,'a => (detailState(a.id)?.comments?.list?.length||0)>a.before || detailState(a.id)?.comments?.hasMore===false',{'id':data['id'],'before':before},timeout=2500)
            except BrowserTimeout: break
            raw = await read()
        expanded = 0
        if expand_replies:
            # Read-only expansion targets must be descendants of loaded comment threads.
            self.stage='comments.expand_replies'
            before=sum(len(x.get('subComments',[])) for x in raw.get('list',[]))
            expanded=await p.evaluate('''() => {
                const buttons=[...document.querySelectorAll('.parent-comment .show-more,.parent-comment .show-more-replies,.parent-comment .sub-comment-more')]
                    .filter(e=>/展开.*(回复|条)|更多回复/.test(e.innerText)).slice(0,3);
                for(const e of buttons)e.click();return buttons.length;
            }''')
            if expanded:
                try:
                    await self.wait(p,'a => (detailState(a.id)?.comments?.list||[]).reduce((n,c)=>n+(c.subComments?.length||0),0)>a.before',{'id':data['id'],'before':before},timeout=1500)
                except BrowserTimeout: pass
            raw = await read()
        items = self.comments_public(raw)
        return {'note_ref':note_ref,'items':items[offset:offset+limit],'offset':offset,
                'next_offset':offset+len(items[offset:offset+limit]),'loaded_count':len(items),
                'has_more':bool(raw.get('hasMore',False)) or offset+limit<len(items),
                'expanded_threads':expanded,'exhaustive':not raw.get('hasMore',True) and offset==0 and len(items)<=limit}

    async def profile(self,user_ref,offset=0,limit=10,collection_ref=None):
        data = self.user_refs.get(user_ref)
        if not data: raise PublicError('USER_REFERENCE_EXPIRED','get_author_from_note_again',False)
        p = await self.page('profile')
        if self.current_user!=user_ref:
            q = {'xsec_source':'pc_note'}
            if data['token']: q['xsec_token']=data['token']
            await self.navigate(p,BASE+'/user/profile/'+data['id']+'?'+urlencode(q))
            await self.wait(p,'() => !!profileState()?.basicInfo || loginSignals().login_visible || loginSignals().challenge')
            await self.ensure_readable(p)
            self.current_user=user_ref
        raw=await self.evaluate(p,'() => profileState()')
        return {'user_ref':user_ref,'source_url':BASE+'/user/profile/'+data['id'],
                'basic_info':self.sanitize(raw.get('basicInfo',{})), 'interactions':self.sanitize(raw.get('interactions',[])),
                'posts':await self.list_page(p,'profile',user_ref,collection_ref,offset,limit)}

    async def next_note(self,collection_ref,index=0):
        c=self.collections.get(collection_ref)
        if not c: raise PublicError('COLLECTION_EXPIRED','get_feed_or_search_again',False)
        if not 0<=index<len(c['items']): raise PublicError('LOAD_MORE_FEEDS','use_next_offset',False)
        return {'collection_ref':collection_ref,'index':index,'next_index':index+1,
                'note':await self.detail(c['items'][index]['note_ref'])}

    async def image_bytes(self,ref):
        m=self.media_refs.get(ref)
        if not m or m['kind']!='image': raise PublicError('MEDIA_REFERENCE_EXPIRED','get_note_detail_again',False)
        if m.get('bytes'): return m['bytes']
        raw=await self.image_original(ref)
        image=ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert('RGB')
        image.thumbnail((CONFIG['image_max_dimension'],CONFIG['image_max_dimension']))
        buf=io.BytesIO(); image.save(buf,format='JPEG',quality=90)
        if buf.tell()>CONFIG['image_max_bytes']:
            buf=io.BytesIO(); image.save(buf,format='JPEG',quality=70)
        if buf.tell()>CONFIG['image_max_bytes']: raise PublicError('IMAGE_TOO_LARGE','inspect_service',False)
        m['bytes']=buf.getvalue()
        cached=[x for x in self.media_refs.values() if x.get('bytes')]
        for x in cached[:-24]: x.pop('bytes',None)
        return m['bytes']

    async def image_original(self,ref):
        m=self.media_refs.get(ref)
        if not m or m['kind']!='image':raise PublicError('MEDIA_REFERENCE_EXPIRED','get_note_detail_again',False)
        url=m['url']
        if url.startswith('//'): url='https:'+url
        for _ in range(3):
            u=urlsplit(url)
            if u.scheme not in ('https','http') or not (u.hostname or '').endswith(('.xhscdn.com','.xiaohongshu.com')):
                raise PublicError('UNSUPPORTED_MEDIA_HOST','inspect_service',False)
            async with self.http.stream('GET',url,headers={'Referer':BASE+'/','User-Agent':'Mozilla/5.0'}) as r:
                if r.is_redirect:
                    url=str(r.url.join(r.headers.get('location',''))); continue
                if r.status_code!=200: raise PublicError('IMAGE_FETCH_FAILED','get_note_detail_again')
                chunks=[]; size=0
                async for chunk in r.aiter_bytes():
                    size+=len(chunk)
                    if size>20*1024*1024: raise PublicError('IMAGE_TOO_LARGE','inspect_service',False)
                    chunks.append(chunk)
                raw=b''.join(chunks)
            # Preserve exact bytes and native resolution for archives/OCR.
            return raw
        raise PublicError('IMAGE_FETCH_FAILED')

    async def images(self,note_ref,offset=0,limit=2):
        if not 0<=offset<=100 or not 1<=limit<=3: raise PublicError('INVALID_ARGUMENT','correct_input',False)
        detail=await self.detail(note_ref)
        selected=detail['images'][offset:offset+limit]
        if not selected: raise PublicError('NO_MORE_IMAGES','read_note_text',False)
        payload=await asyncio.gather(*(self.image_bytes(x['media_ref']) for x in selected))
        return {'note_ref':note_ref,'images':selected,'next_offset':offset+len(selected),
                'total_images':len(detail['images']),'has_more':offset+len(selected)<len(detail['images']),
                '_image_blocks':[{'type':'image','mimeType':'image/jpeg','data':base64.b64encode(x).decode()} for x in payload]}

    def health(self):
        return {'ok':True,'public_social_read_only':True,'private_ai_chat_enabled':True,'listener':f'127.0.0.1:{CONFIG["port"]}',
                'browser_connected':bool(self.browser and self.browser.is_connected()),'owned_tabs':len(self.tabs),
                'busy':self.lock.locked(),'uptime_seconds':round(time.time()-self.started),'stats':self.stats,
                'reference_persistence':'windows_user_dpapi','reference_store_error':self.state_error,
                'cached_references':len(self.note_refs),'retained_collections':len(self.collections),
                'skipped_unresponsive_tabs':self.scoped_cdp.frozen if self.scoped_cdp else 0,
                'recent_operations':self.latencies[-12:], 'blocked_paths':self.blocked_paths}

    async def close(self):
        await self.exports.close()
        for p in self.tabs.values():
            try: await p.close()
            except Exception: pass
        await self.http.aclose()
        if self.browser:
            try: await self.browser.close() # disconnect CDP; does not close Chrome
            except Exception: pass
        if self.playwright: await self.playwright.stop()
        if self.scoped_cdp:await self.scoped_cdp.close()
