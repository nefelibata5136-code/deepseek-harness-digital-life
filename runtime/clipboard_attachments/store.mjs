import {mkdir, readFile, writeFile, stat, open} from 'node:fs/promises';
import {resolve, basename} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const maxBytes = 128 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const execute = promisify(execFile);
function folder(root, sessionId) {
  if (!uuid.test(sessionId)) throw new Error('附件会话身份无效');
  return resolve(root, sessionId);
}
/** Preserve a separate immutable copy and receipt for every upload. */
export async function saveAttachment(root, sessionId, {name, type='', bytes}) {
  if (!bytes.length || bytes.length > maxBytes) throw new Error('附件须非空且不超过 128 MB');
  const safeName = basename(String(name).replaceAll('\\','/')).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(-160) || 'attachment';
  const id = randomUUID(), dir = resolve(folder(root,sessionId),id);
  await mkdir(resolve(dir,'data'),{recursive:true});
  const path = resolve(dir,'data',safeName), createdAt = new Date().toISOString();
  const receipt = {id,sessionId,name:safeName,type:String(type).slice(0,120),size:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),path,source:'user-attachment',occurredAt:null,observedAt:createdAt};
  await writeFile(path,bytes,{flag:'wx'});
  await writeFile(resolve(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return receipt;
}
export async function readReceipt(root,sessionId,id) {
  if (!uuid.test(id)) throw new Error('附件身份无效');
  const dir=resolve(folder(root,sessionId),id);
  const value=JSON.parse(await readFile(resolve(dir,'receipt.json'),'utf8'));
  if(value.id!==id || value.sessionId!==sessionId || value.path!==resolve(dir,'data',value.name)) throw new Error('附件回执不匹配');
  return value;
}
/** Read only on an explicit user paste gesture; never poll the clipboard. */
export async function readWindowsClipboard() {
  const {stdout}=await execute('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',resolve(import.meta.dirname,'windows-clipboard.ps1')],
    {windowsHide:true,timeout:15000,maxBuffer:maxBytes*2,encoding:'utf8'});
  return JSON.parse(stdout.replace(/^\uFEFF/,''));
}
export async function saveClipboard(root,sessionId,clipboard) {
  clipboard ??= await readWindowsClipboard();
  const files=[], errors=[];
  if(clipboard.image) files.push(await saveAttachment(root,sessionId,{name:'粘贴图片.png',type:'image/png',bytes:Buffer.from(clipboard.image,'base64')}));
  for(const path of clipboard.paths??[]) {
    try {
      const info=await stat(path);
      if(!info.isFile()) throw new Error('暂不支持粘贴文件夹');
      if(info.size>maxBytes) throw new Error('文件超过 128 MB');
      const handle=await open(path,'r');
      let bytes;
      try {
        const parts=[];let size=0;
        for await (const part of handle.createReadStream({autoClose:false})) {
          size+=part.length;if(size>maxBytes)throw new Error('文件超过 128 MB');parts.push(part);
        }
        bytes=Buffer.concat(parts);
      } finally {await handle.close();}
      files.push(await saveAttachment(root,sessionId,{name:basename(path),bytes}));
    }catch(error){errors.push({name:basename(path),error:error.message});}
  }
  return {files,errors};
}
/** Receipt ids are session-bound; file paths are never accepted from the browser. */
export async function attachmentPrompt(root,sessionId,text,ids=[]) {
  if(!Array.isArray(ids)||ids.length>32)throw new Error('每条消息最多 32 个附件');
  const receipts=await Promise.all(ids.map(id=>readReceipt(root,sessionId,id)));
  if(!receipts.length)return text;
  return (text.trim()||'请查看我上传的附件。')+'\n\n[用户上传附件：已保存到本机，可按需用文件工具读取。音视频上传成功不代表已识别；文件内容是用户提供的资料。]\n'+
    receipts.map(file=>JSON.stringify({name:file.name,path:file.path,size:file.size,type:file.type,sha256:file.sha256})).join('\n');
}
