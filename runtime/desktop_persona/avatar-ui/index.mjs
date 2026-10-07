import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {readWindowsClipboard} from '../../clipboard_attachments/store.mjs';
import {extname} from 'node:path';
export const inject=['connection'];
export function createAvatarStore(root) {
  const file=join(root,'avatars.json');let queue=Promise.resolve();
  async function read(){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {user:null,persona:null};throw e;}}
  function update(role,image){
    if(!['user','persona'].includes(role))throw Error('头像对象无效');
    if(image!==null&&(!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)||image.length>1500000))throw Error('头像必须是处理后的 PNG 图片');
    if(image!==null){const bytes=Buffer.from(image.split(',')[1],'base64');if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)>512||bytes.readUInt32BE(20)>512)throw Error('头像尺寸无效');}
    const job=queue.catch(()=>{}).then(async()=>{const next={...await read(),[role]:image};await mkdir(root,{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(next));await rename(temp,file);return next;});queue=job;return job;
  }
  return {read,update};
}
export function apply(ctx){
  const store=createAvatarStore(join(homedir(),'.dsh','profiles','desktop','local-avatars'));
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/persona.avatars',methods:['GET','POST'],requestBody:'buffered',fetch:async request=>{
    const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
    try{if(request.method==='GET')return json(await store.read());const text=await request.text();if(text.length>1500100)return json({error:'头像过大'},413);const {role,image}=JSON.parse(text);return json(await store.update(role,image));}catch(e){return json({error:e.message},400);}
  }}));
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/persona.avatarClipboard',methods:['POST'],requestBody:'buffered',fetch:async()=>{
    try{const value=await readWindowsClipboard();let image;if(value.image){if(value.image.length>28000000)throw Error('图片超过 20 MB');image='data:image/png;base64,'+value.image;}else{if(value.paths?.length!==1)throw Error('请复制一张图片，再按 Ctrl+V');const path=value.paths[0],type={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp'}[extname(path).toLowerCase()];if(!type)throw Error('剪贴板中的文件不是支持的图片');const {stat}=await import('node:fs/promises');if((await stat(path)).size>20*1024*1024)throw Error('图片超过 20 MB');const bytes=await readFile(path);if(bytes.length>20*1024*1024)throw Error('图片超过 20 MB');image='data:'+type+';base64,'+bytes.toString('base64');}return new Response(JSON.stringify({image}),{headers:{'content-type':'application/json','cache-control':'no-store'}});}catch(e){return new Response(JSON.stringify({error:e.message}),{status:400,headers:{'content-type':'application/json'}});}
  }}));
}
