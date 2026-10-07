window.__ModuleLoader__.load({id:'@local/persona-thinking-translation',factory:()=>{
function startPersonaThinkingTranslation(){
 if(window.__personaThinkingTranslation)return;
 window.__personaThinkingTranslation={enabled:true,backend:'local Chrome Translator'};
 const style=document.createElement('style');style.textContent='.yb-thinking.yb-chinese>.yb-thinking-text{display:none}.yb-translation{font:inherit}.yb-translation-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:4px 0 10px;font-size:12px}.yb-translation-controls button{font:inherit;color:inherit;background:#ffffff08;border:1px solid #ffffff25;border-radius:6px;padding:5px 10px;cursor:pointer}.yb-translation-controls button[aria-pressed=true]{color:#94dab6;border-color:#94dab688}.yb-translation-text{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;padding:12px 16px;border-left:1px solid #ffffff22;line-height:1.75;contain:content}.yb-thinking:not([open])>.yb-translation{display:none}';document.head.append(style);
 const states=new WeakMap(),cache=new Map();
 function segments(text){const result=[];for(const p of text.split(/\n{2,}/)){if(!p)continue;let rest=p;while(rest.length>800){let end=rest.lastIndexOf('. ',800);if(end<300)end=rest.lastIndexOf(' ',800);if(end<300)end=800;else end+=1;result.push(rest.slice(0,end));rest=rest.slice(end);}if(rest)result.push(rest);}return result;}
 function decorate(d){
  const raw=d.querySelector(':scope>.yb-thinking-text');if(!raw||!d.open)return;
  let s=states.get(d);
  if(!s){
   const root=document.createElement('div');root.className='yb-translation';
   const controls=document.createElement('div');controls.className='yb-translation-controls';
   const chinese=document.createElement('button');chinese.type='button';chinese.textContent='中文译文';
   const original=document.createElement('button');original.type='button';original.textContent='原文';
   const status=document.createElement('span');status.textContent='本机翻译 · 准备中';
   const body=document.createElement('pre');body.className='yb-translation-text';
   controls.append(chinese,original,status);root.append(controls,body);d.append(root);
   s={root,chinese,original,status,body,mode:'zh',source:null,changed:0,busy:false,doneSource:null};states.set(d,s);
   function mode(value){s.mode=value;d.classList.toggle('yb-chinese',value==='zh');body.hidden=value!=='zh';chinese.setAttribute('aria-pressed',String(value==='zh'));original.setAttribute('aria-pressed',String(value==='original'));if(value==='zh')update(d,s);}
   chinese.onclick=()=>mode('zh');original.onclick=()=>mode('original');mode('zh');
  }
  if(!s.root.isConnected)d.append(s.root);
  const source=raw.textContent;if(source!==s.source){s.source=source;s.changed=Date.now();}
  update(d,s);
 }
 async function update(d,s){
  if(s.busy||s.mode!=='zh'||!d.open||!d.isConnected||s.source===s.doneSource||Date.now()<(s.retryAfter??0))return;
  const source=s.source;if(!source)return;
  s.busy=true;s.status.textContent='本机翻译 · 翻译中';
  const chunks=segments(source),running=/思考中|执行工具中/.test(d.querySelector('summary')?.textContent??'');
  const waiting=running&&Date.now()-s.changed<1000;
  if(waiting)chunks.pop();
  const translated=[];
  try{
   for(const chunk of chunks){
    if(!d.open||s.mode!=='zh'||!d.isConnected)break;
    let value=cache.get(chunk);
    if(value===undefined){const r=await fetch('/api/persona.translateThinking',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:chunk})});if(!r.ok)throw Error('本机翻译暂时不可用');const j=await r.json();if(!j.local||typeof j.text!=='string')throw Error('本机翻译响应无效');value=j.text;cache.set(chunk,value);if(cache.size>400)cache.delete(cache.keys().next().value);}
    translated.push(value);
    // The received prefix remains valid while subsequent reasoning is appended.
    if(s.source===source||s.source.startsWith(source)){const follow=s.body.scrollHeight-s.body.scrollTop-s.body.clientHeight<60;s.body.textContent=translated.join('\n\n');if(follow)s.body.scrollTop=s.body.scrollHeight;}
    else break;
   }
   if(s.source===source&&!waiting&&translated.length===chunks.length){s.doneSource=source;s.status.textContent='中文译文 · 本机翻译';}
   else s.status.textContent='中文译文 · 等待新内容';
  }catch(e){s.retryAfter=Date.now()+15000;s.status.textContent=e.message+'，可切回原文';}
  finally{s.busy=false;}
 }
 function scan(){document.querySelectorAll('.yb-thinking[open]').forEach(decorate);}
 const observer=new MutationObserver(()=>{clearTimeout(window.__personaTranslationScan);window.__personaTranslationScan=setTimeout(scan,100);});
 observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['open']});
 setInterval(scan,700);scan();
}
return {apply:startPersonaThinkingTranslation};
}});
