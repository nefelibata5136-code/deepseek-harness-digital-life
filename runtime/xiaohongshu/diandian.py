"""Fixed private DianDian AI interface. No public-social or arbitrary browser actions."""
import hashlib,re,time,asyncio
from urllib.parse import urlsplit,parse_qs,urlencode
from pathlib import Path
JS=(Path(__file__).with_name('diandian.js')).read_text(encoding='utf-8')

class DianDian:
    def __init__(self,browser,saved):
        self.b=browser
        self.chats=saved.get('ai_chats',{})
        self.requests=saved.get('ai_requests',{})
        self.refs={}
        self.current=None

    def export(self):
        return {'ai_chats':self.chats,'ai_requests':self.requests}

    async def state(self,p):
        return await p.evaluate('(arg)=>{'+self.b.site_js+'\n'+JS+'}',None)

    async def page(self,ref=None,attach=False):
        p=await self.b.page('diandian')
        if ref:
            c=self.chats.get(ref)
            if not c:raise self.b.error('AI_CONVERSATION_EXPIRED','start_or_read_conversation',False)
            if self.current==ref and urlsplit(p.url).path=='/ai_chat':return p,ref
            url='https://www.xiaohongshu.com/ai_chat'
            if c.get('cid'):url+='?'+urlencode({'conversationId':c['cid']})
        elif attach:
            # Copy a user's already open conversation to our own tab; never
            # navigate, type into or click controls in their original tab.
            candidate=None
            for x in reversed(self.b.context.pages):
                if x is p or not x.url.startswith('https://www.xiaohongshu.com/'):continue
                role=await x.evaluate('()=>window.name')
                if role.startswith('persona-xhs-'):continue
                if await x.locator('.chat-container').count()==0:continue
                old=await x.evaluate('()=>{const u=x=>x?.value??x?._value??x;const c=u(window.__INITIAL_STATE__?.conversation?.activeConversation);const r=u(c?.rounds);return r?.length?u(c.conversationId):null;}')
                if parse_qs(urlsplit(x.url).query).get('conversationId') or old:candidate=x;cid=old;break
            if not candidate:raise self.b.error('NO_OPEN_AI_CONVERSATION','open_diandian_conversation_in_browser',False)
            url=candidate.url if urlsplit(candidate.url).path=='/ai_chat' else 'https://www.xiaohongshu.com/ai_chat?'+urlencode({'conversationId':cid})
        else:url='https://www.xiaohongshu.com/ai_chat'
        await self.b.navigate(p,url)
        self.b.stage='diandian.page_ready'
        await p.locator('.markdown-block:visible, .ai-chat-welcome__input:visible, .textarea-container-chat-section:visible').first.wait_for(timeout=10000)
        if 'conversationId=' in url:
            self.b.stage='diandian.history'
            await self.b.wait(p,'() => (unwrap(unwrap(initial().conversation?.activeConversation)?.rounds)||[]).length>0',timeout=10000)
        s=await self.state(p)
        if not ref:ref='d_'+hashlib.sha256((s.get('cid') or str(time.time_ns())).encode()).hexdigest()[:20]
        self.chats[ref]={'cid':s.get('cid'),'title':s['title']}
        while len(self.chats)>20:self.chats.pop(next(iter(self.chats)))
        self.current=ref
        return p,ref

    async def read(self,ref=None,wait_seconds=0,offset=0,limit=5):
        if not 0<=wait_seconds<=10 or not 0<=offset<=100 or not 1<=limit<=10:
            raise self.b.error('INVALID_ARGUMENT','correct_input',False)
        p,ref=await self.page(ref,attach=ref is None)
        deadline=time.monotonic()+wait_seconds
        s=await self.state(p)
        while s['rounds'] and not s['rounds'][-1]['complete'] and time.monotonic()<deadline:
            await asyncio.sleep(.4);s=await self.state(p)
        self.chats[ref]={'cid':s.get('cid'),'title':s['title']}
        links=[]
        for link in s['links']:
            if not link['label']:continue
            rid='r_'+hashlib.sha256((ref+str(link['index'])+link['label']).encode()).hexdigest()[:20]
            self.refs[rid]={'chat':ref,**link}
            links.append({'reference_ref':rid,'label':link['label'],'kind':'web_link' if link['href'] else 'search_reference'})
        while len(self.refs)>1000:self.refs.pop(next(iter(self.refs)))
        out=s['rounds'][offset:offset+limit]
        return {'conversation_ref':ref,'title':s['title'],'rounds':out,'round_offset':offset,'next_round_offset':offset+len(out),
            'loaded_rounds':len(s['rounds']),'history_has_more':s['history_has_more'],
            'reply_complete':bool(s['rounds'] and s['rounds'][-1]['complete']),'references':links,
            'next_action':'continue_chat_or_open_reference' if s['rounds'] and s['rounds'][-1]['complete'] else 'diandian_read_with_wait_seconds',
            'reference_warning':'AI recommendations are clues. Open references and verify actual note title/author/content.'}

    async def chat(self,message,request_id,ref=None):
        if not isinstance(message,str) or not 1<=len(message.strip())<=4000 or not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}',request_id):
            raise self.b.error('INVALID_ARGUMENT','correct_input',False)
        digest=hashlib.sha256(message.encode()).hexdigest()
        existing=self.requests.get(request_id)
        if existing:
            if existing['hash']!=digest or (ref and ref!=existing['chat']):raise self.b.error('AI_REQUEST_ID_CONFLICT','use_new_request_id',False)
            if existing['status']=='submitting':raise self.b.error('AI_SUBMISSION_UNCERTAIN','read_conversation_do_not_resend',False)
            return {**await self.read(existing['chat'],0,existing.get('offset',0),1),'request_id':request_id,'deduplicated':True}
        p,ref=await self.page(ref)
        s=await self.state(p)
        if s['rounds'] and not s['rounds'][-1]['complete']:raise self.b.error('AI_REPLY_PENDING','read_conversation_then_continue',False)
        await self.b.ensure_readable(p)
        # XHS inserts a transparent absolute textarea to measure autosize.
        # Playwright :visible also includes it. Only use the opaque real input.
        inputs=p.locator('.ai-chat-welcome__input textarea, .textarea-container-chat-section textarea')
        index=await inputs.evaluate_all('es=>es.findIndex(e=>e.getBoundingClientRect().width>0 && Number(getComputedStyle(e).opacity)>.5 && !e.disabled)')
        if index<0:raise self.b.error('AI_INPUT_UNAVAILABLE','read_conversation_then_retry',False)
        target=inputs.nth(index)
        await target.fill(message)
        if await target.input_value()!=message:raise self.b.error('AI_INPUT_CHANGED','inspect_conversation',False)
        self.requests[request_id]={'hash':digest,'chat':ref,'status':'submitting','offset':len(s['rounds'])}
        while len(self.requests)>200:self.requests.pop(next(iter(self.requests)))
        # Durable submission marker BEFORE Enter. Uncertain sends are never
        # retried automatically, including after MCP or browser restarts.
        self.b.persist()
        await target.press('Enter')
        await self.b.wait(p,'text => {const c=unwrap(initial().conversation?.activeConversation);const rs=unwrap(c?.rounds)||[];return unwrap(unwrap(rs.at(-1)?.userMessage)?.text)===text;}',message,timeout=8000)
        s=await self.state(p)
        self.chats[ref]['cid']=s.get('cid')
        self.requests[request_id]['status']='submitted'
        return {**await self.read(ref,0,len(s['rounds'])-1,1),'request_id':request_id,'submitted':True,'deduplicated':False}

    async def open_reference(self,reference_ref,limit=8):
        ref=self.refs.get(reference_ref)
        if not ref:raise self.b.error('AI_REFERENCE_EXPIRED','diandian_read_again',False)
        p,chat=await self.page(ref['chat'])
        links=p.locator('.markdown-block u,.markdown-block a').filter(visible=True)
        target=links.nth(ref['index'])
        if (await target.text_content() or '').strip()!=ref['label']:raise self.b.error('AI_REFERENCE_CHANGED','diandian_read_again',False)
        if ref.get('href'):raise self.b.error('AI_REFERENCE_TYPE_UNSUPPORTED','read_available_search_references',False)
        if not 1<=limit<=20:raise self.b.error('INVALID_ARGUMENT','correct_input',False)
        # The site's U references launch a note-search panel; capture the actual
        # result response and keep signed note credentials inside Browser.
        async with p.expect_response(lambda r:urlsplit(r.url).path in ('/api/sns/web/v1/search/notes','/api/sns/web/v2/search/notes') and r.request.method=='POST',timeout=10000) as response:
            # The site's reference panel can cover its own U control. Dispatch
            # that validated native control's click, then verify the real reply.
            await target.evaluate('e=>e.click()')
        r=await response.value;body=await r.json()
        if not body.get('success'):raise self.b.error('AI_REFERENCE_SEARCH_FAILED','retry_reference')
        raw=body.get('data',{}).get('items') or []
        items=self.b.feeds(raw)
        for item in items:
            self.b.note_refs[item['note_ref']]['source']='pc_search'
        cid=self.b.collection('diandian',chat,items)
        keyword=(r.request.post_data_json or {}).get('keyword','')
        return {'conversation_ref':chat,'reference_ref':reference_ref,'label':ref['label'],'opened_kind':'note_search_panel',
            'keyword':keyword,'collection_ref':cid,'items':items[:limit],'next_offset':min(limit,len(items)),
            'loaded_count':len(items),'exact_note_verified':False,'next_action':'next_feed_to_verify_selected_note',
            'warning':'Blue title opened a real search panel, not a guaranteed exact note. Verify returned titles/authors before claiming an exact match.'}
