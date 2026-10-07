import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-Command',"(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and (Get-Process -Id $_.ProcessId).MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty ProcessId)"],{windowsHide:true});
const pid=Number(stdout.trim());if(!pid)throw Error('Desktop main process unavailable');
process._debugProcess(pid);
let targets;
for(let i=0;i<30;i++){try{targets=await(await fetch('http://127.0.0.1:9229/json/list')).json();break;}catch{await new Promise(done=>setTimeout(done,100));}}
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise(done=>socket.addEventListener('open',done,{once:true}));
const expression=`(async()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');const windows=e.BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()==='dsh-app://app/');const result=[];for(const w of windows)result.push(await w.webContents.executeJavaScript('(async()=>{const form=new FormData();form.set("sessionId","invalid");const r=await fetch("api/persona.upload",{method:"POST",body:form});return {composer:!!document.querySelector(".yb-input"),attachmentButton:!!document.querySelector("[aria-label=添加附件]"),uploadRouteStatus:r.status,uploadRouteKnown:r.status!==404};})()'));setTimeout(()=>process.getBuiltinModule('inspector').close(),300);return {readOnlyDesktopInspection:true,invalidProbeWritesFiles:false,modelCalls:0,windows:result};})()`;
const value=await new Promise((done,reject)=>{socket.addEventListener('message',event=>{const r=JSON.parse(event.data);if(r.id!==1)return;if(r.result?.exceptionDetails)return reject(Error('Desktop inspection failed'));done(r.result.result.value);});socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});
socket.close();await writeFile(new URL('../../reports/clipboard_attachments/installed-state.json',import.meta.url),JSON.stringify(value,null,2));console.log(JSON.stringify(value));
