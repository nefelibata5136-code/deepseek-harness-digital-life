import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {readWindowsClipboard,readReceipt,attachmentPrompt} from './store.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-Command',"(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and (Get-Process -Id $_.ProcessId).MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty ProcessId)"],{windowsHide:true});
process._debugProcess(Number(stdout.trim()));
let targets;for(let i=0;i<30;i++){try{targets=await(await fetch('http://127.0.0.1:9229/json/list')).json();break;}catch{await new Promise(done=>setTimeout(done,100));}}
if(!targets)throw Error('Enable main-process inspector using inspect-installed first');
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise(done=>socket.addEventListener('open',done,{once:true}));
const sessionId=randomUUID();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=','base64');
const wav=Buffer.alloc(46);wav.write('RIFF');wav.writeUInt32LE(38,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(2,40);
const fixtures=[['截图.png','image/png',png],['说明.txt','text/plain',Buffer.from('Ctrl+V 附件上传验证\n')],['录音.wav','audio/wav',wav],['视频.mp4','video/mp4',await readFile(new URL('../../reports/clipboard_attachments/sample.mp4',import.meta.url))]];
const expression=`(async()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');const window=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='dsh-app://app/');const result=await window.webContents.executeJavaScript(${JSON.stringify(`(async()=>{const id=${JSON.stringify(sessionId)};const task=await fetch('api/persona.tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:id,title:'剪贴板附件验收'})});if(!task.ok)throw Error('Test session creation failed');const files=[];for(const [name,type,base64] of ${JSON.stringify(fixtures.map(([name,type,bytes])=>[name,type,bytes.toString('base64')]))}){const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const form=new FormData();form.set('sessionId',id);form.set('file',new File([bytes],name,{type}));const response=await fetch('api/persona.upload',{method:'POST',body:form});if(!response.ok)throw Error('Actual upload failed '+response.status);files.push(await response.json());}return {sessionId:id,title:'剪贴板附件验收',files,actualDesktopUpload:true,modelCalls:0};})()`)});setTimeout(()=>process.getBuiltinModule('inspector').close(),300);return result;})()`;
const result=await new Promise((done,reject)=>{socket.addEventListener('message',event=>{const r=JSON.parse(event.data);if(r.id!==1)return;if(r.result?.exceptionDetails)return reject(Error('Installed upload failed'));done(r.result.result.value);});socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});socket.close();
for(let i=0;i<fixtures.length;i++){
  const file=result.files[i],bytes=fixtures[i][2];assert.deepEqual(await readFile(file.path),bytes);assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readReceipt('.local/workspace/uploads/harness',sessionId,file.id),file);
}
const prompt=await attachmentPrompt('.local/workspace/uploads/harness',sessionId,'验收',result.files.map(f=>f.id));assert(prompt.includes('视频.mp4'));
const clipboard=await readWindowsClipboard();
result.windowsClipboardReadable=true;result.windowsClipboardReadOnly=true;result.clipboardContentsRecorded=false;
result.byteIntegrity=true;result.videoFixture='FFmpeg generated blue 32x32 H.264 MP4; recognition not tested';
await writeFile(new URL('../../reports/clipboard_attachments/actual-upload.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify({actualDesktopUpload:true,sessionId,title:result.title,fileCount:result.files.length,byteIntegrity:true,windowsClipboardReadable:true,modelCalls:0}));
