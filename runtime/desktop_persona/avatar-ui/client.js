window.__ModuleLoader__.load({id:'@local/persona-avatar-settings',factory:require=>{
 const React=require('react'),h=React.createElement;
 // NAVIGATION_START
 function installNavigation(){
  const listener=e=>{const button=e.target.closest?.('.ref-nav-item[data-name="设置"]');if(!button)return;e.preventDefault();e.stopImmediatePropagation();
   const direct=document.querySelector('button[aria-label="设置"]');if(direct){direct.click();return;}
   const menu=()=>Array.from(document.querySelectorAll('[role="menuitem"],button')).find(n=>!n.closest('.ref-nav')&&/^(设置|Settings|Preferences)/.test(n.textContent.trim()));if(menu()){menu().click();return;}const launch=()=>{document.querySelector('button[aria-label="账号菜单"]')?.click();setTimeout(()=>{menu()?.click();},100);};
   if(document.querySelector('button[aria-label="账号菜单"]'))launch();else{document.querySelector('button[aria-label="展开侧栏"]')?.click();setTimeout(launch,100);}
  };document.addEventListener('click',listener,true);return()=>document.removeEventListener('click',listener,true);
 }
 // NAVIGATION_END
 async function request(body){const r=await fetch('/api/persona.avatars',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);const value=await r.json();if(!r.ok)throw Error(value.error||'头像保存失败');return value;}
 async function normalize(file){
  if(!file||!['image/png','image/jpeg','image/webp','image/gif','image/bmp'].includes(file.type))throw Error('请选择或粘贴 PNG、JPG、WebP、GIF 或 BMP 图片');
  if(file.size>20*1024*1024)throw Error('请选择小于 20 MB 的图片');
  const url=URL.createObjectURL(file);
  try{const image=new Image();image.src=url;await image.decode();if(!image.naturalWidth||!image.naturalHeight)throw Error('无法读取图片');const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const size=Math.min(image.naturalWidth,image.naturalHeight);canvas.getContext('2d').drawImage(image,(image.naturalWidth-size)/2,(image.naturalHeight-size)/2,size,size,0,0,256,256);return canvas.toDataURL('image/png');}finally{URL.revokeObjectURL(url);}
 }
 function AvatarSection(){
  const [avatars,setAvatars]=React.useState({}),[target,setTarget]=React.useState('user'),[message,setMessage]=React.useState(''),[busy,setBusy]=React.useState(false);const picker=React.useRef(null),operation=React.useRef(false),pasteCount=React.useRef(0);
  React.useEffect(()=>{let alive=true;request().then(v=>{if(alive)setAvatars(v);}).catch(e=>{if(alive)setMessage(e.message);});return()=>{alive=false;};},[]);
  async function save(role,file){if(operation.current)return;operation.current=true;setBusy(true);setMessage('正在保存…');try{const image=file?await normalize(file):null;const value=await request({role,image});setAvatars(value);window.dispatchEvent(new CustomEvent('persona-avatars-changed',{detail:value}));setMessage('已保存，聊天头像已更新');}catch(e){setMessage(e.message);}finally{operation.current=false;setBusy(false);}}
  async function nativePaste(role){if(operation.current)return;try{const r=await fetch('/api/persona.avatarClipboard',{method:'POST'});const v=await r.json();if(!r.ok)throw Error(v.error);const blob=await(await fetch(v.image)).blob();await save(role,new File([blob],'clipboard-avatar',{type:blob.type}));}catch(e){setMessage(e.message);}}
  function paste(e){pasteCount.current++;const files=Array.from(e.clipboardData?.files??[]);e.preventDefault();e.stopPropagation();if(!files.length){void nativePaste(target);return;}if(files.length!==1){setMessage('请一次粘贴一张图片');return;}void save(target,files[0]);}
  function key(e){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v'&&!e.shiftKey&&!e.altKey){const before=pasteCount.current,role=target;setTimeout(()=>{if(pasteCount.current===before)void nativePaste(role);},100);}}
  return h('section',{className:'yb-avatar-settings',onPaste:paste,onKeyDown:key},h('h2',null,'头像'),h('p',null,'分别选择你的头像和人格的头像。点击对应区域后，按 Ctrl+V 粘贴图片，也可以选择电脑中的文件。'),
   h('input',{ref:picker,type:'file',accept:'image/png,image/jpeg,image/webp,image/gif,image/bmp',hidden:true,onChange:e=>{const file=e.target.files[0];e.target.value='';if(file)void save(target,file);}}),
   h('div',{className:'yb-avatar-cards'},['user','persona'].map(role=>h('div',{key:role,className:'yb-avatar-card',tabIndex:0,'aria-label':role==='user'?'你的头像粘贴区域':'人格的头像粘贴区域','data-selected':target===role,onFocus:()=>setTarget(role),onClick:()=>setTarget(role)},
    h('h3',null,role==='user'?'你的头像':'人格的头像'),avatars[role]?h('img',{className:'yb-avatar-preview',src:avatars[role],alt:role==='user'?'你的头像预览':'人格的头像预览'}):h('div',{className:'yb-avatar-preview yb-avatar-placeholder'},role==='user'?'你':'云'),
    h('p',null,target===role?'当前粘贴目标 · Ctrl+V':'点击此区域，再按 Ctrl+V'),h('div',{className:'yb-avatar-buttons'},h('button',{type:'button',disabled:busy,onClick:()=>{setTarget(role);picker.current.click();}},'选择图片'),h('button',{type:'button',disabled:busy||!avatars[role],onClick:()=>void save(role,null)},'恢复默认'))))),
   h('p',{role:'status','aria-live':'polite'},message),h('p',{className:'yb-avatar-note'},'自动居中裁成正方形，保存后立即生效。头像保存在本机 DSH，多个窗口共用；不会发送给模型。'));
 }
 const css='.yb-avatar-settings{max-width:760px;padding:24px;color:var(--color-text-primary);font-family:system-ui,"Microsoft YaHei",sans-serif}.yb-avatar-settings p{line-height:1.7}.yb-avatar-cards{display:flex;gap:16px;flex-wrap:wrap}.yb-avatar-card{flex:1 1 220px;padding:20px;border:1px solid #8885;border-radius:12px;cursor:pointer}.yb-avatar-card[data-selected=true]{border-color:#65aa91;outline:1px solid #65aa91}.yb-avatar-card:focus-visible{outline:2px solid #65aa91}.yb-avatar-preview{width:96px;height:96px;object-fit:cover;border-radius:50%!important}.yb-avatar-placeholder{display:grid;place-items:center;background:#8882;font-size:30px}.yb-avatar-buttons{display:flex;gap:10px;flex-wrap:wrap}.yb-avatar-buttons button{font:inherit;color:inherit;background:#8881;border:1px solid #8885;border-radius:7px;padding:8px 12px;cursor:pointer}.yb-avatar-buttons button:disabled{opacity:.45;cursor:default}.yb-avatar-note{font-size:12px;opacity:.7}.yb-role::before{background-size:cover;background-position:center;border-radius:50%;vertical-align:middle;margin-right:7px}';
 function apply(ctx){
  ctx.effect(installNavigation);
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='persona-avatar-settings';document.head.append(style);let alive=true,last='';
   function paint(value){const serialized=JSON.stringify(value);if(serialized===last)return;last=serialized;style.textContent=css+'.ref-ui .yb-role::before{content:none!important}'+(value.user?'.yb-user>.yb-role::before{content:"";display:inline-block;width:28px;height:28px;background-image:url('+JSON.stringify(value.user)+')}.ref-ui .yb-message.yb-user::before,.ref-ui .ref-letter{content:""!important;background-image:url('+JSON.stringify(value.user)+')!important;background-size:cover!important;background-position:center!important;border-radius:50%!important;font-size:0!important}':'')+(value.persona?'.yb-message:has(>.yb-markdown):not(.yb-user):not(.yb-progress)>.yb-role::before{content:"";display:inline-block;width:28px;height:28px;background-image:url('+JSON.stringify(value.persona)+')}.ref-ui .yb-message:has(>.yb-markdown):not(.yb-user):not(.yb-progress)::before{background-image:url('+JSON.stringify(value.persona)+')!important;background-size:cover!important;border-radius:50%!important}':'');}
   const changed=e=>paint(e.detail);window.addEventListener('persona-avatars-changed',changed);const refresh=()=>request().then(v=>{if(alive)paint(v);}).catch(()=>{});void refresh();const timer=setInterval(refresh,5000);return()=>{alive=false;clearInterval(timer);window.removeEventListener('persona-avatars-changed',changed);style.remove();};});
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'persona-avatars',order:25,label:()=> '头像'},AvatarSection));
 }
 return {inject:['slots'],apply};
}});
