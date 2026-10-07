import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {fail} from '../contracts.mjs';

// Browser implementation is shared; persistent profiles and handles belong to lives.
// launcher and setup are Host capabilities. No ambient default profile or Cookie.
export class OwnerBrowser {
  #handles=new Map();#closed=false;#inflight=new Set();
  constructor({contexts,bindings,resources,launchPersistentContext,setup=async()=>{}}) {
    if(typeof launchPersistentContext!=='function')fail('EXPLICIT_BROWSER_LAUNCHER_REQUIRED');
    Object.assign(this,{contexts,bindings,resources,launchPersistentContext,setup});
  }
  async withProfile(context,{name='default',signal=new AbortController().signal}={},operation) {
    const c=this.contexts.require(context);if(this.#closed)fail('BROWSER_SERVICE_CLOSED');
    if(c.role==='delegate')fail('DELEGATE_BROWSER_WRITE_DENIED');
    const binding=this.bindings.browser(c,name);
    const work=this.resources.withBrowser(c,binding,signal,async()=>{
      signal.throwIfAborted();if(this.#closed)fail('BROWSER_SERVICE_CLOSED');
      let item=this.#handles.get(binding.bindingRef);
      if(!item) {
        await mkdir(binding.profileRoot,{recursive:true});
        const downloads=resolve(c.manifest.deployment.attachments,'browser-downloads');await mkdir(downloads,{recursive:true});
        const browser=await this.launchPersistentContext(binding.profileRoot,{headless:true,downloadsPath:downloads,acceptDownloads:true});
        item={lifeId:c.lifeId,browser};this.#handles.set(binding.bindingRef,item);
        try{await this.setup(c,binding,browser);}catch(error){this.#handles.delete(binding.bindingRef);await browser.close();throw error;}
      }
      if(item.lifeId!==c.lifeId)fail('BROWSER_HANDLE_OWNER_MISMATCH');
      this.contexts.require(c);signal.throwIfAborted();return operation(item.browser,binding);
    });
    this.#inflight.add(work);try{return await work;}finally{this.#inflight.delete(work);}
  }
  async open(context,{url,name='default',signal=new AbortController().signal}) {
    if(typeof url!=='string'||!/^https?:\/\//.test(url))fail('BROWSER_HTTP_URL_REQUIRED');
    return this.withProfile(context,{name,signal},async(browser,binding)=>{
      const page=await browser.newPage(),cancel=()=>void page.close().catch(()=>{});
      signal.addEventListener('abort',cancel,{once:true});
      try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});this.contexts.require(context);signal.throwIfAborted();
        return {lifeId:binding.lifeId,bindingRef:binding.bindingRef,url:page.url(),title:await page.title()};}
      finally{signal.removeEventListener('abort',cancel);await page.close();}
    });
  }
  async close(){this.#closed=true;await Promise.allSettled([...this.#inflight]);await Promise.all([...this.#handles.values()].map(item=>item.browser.close()));this.#handles.clear();}
}
