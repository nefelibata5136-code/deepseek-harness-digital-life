import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const report=resolve(dirname(fileURLToPath(import.meta.url)), '../../reports/multi-window');
const targets=await (await fetch('http://127.0.0.1:19452/json/list')).json();
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((done,reject)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',reject,{once:true});});
let nextId=0;
const evaluate=expression=>new Promise((done,reject)=>{
  const id=++nextId;
  const listen=event=>{const r=JSON.parse(event.data);if(r.id!==id)return;socket.removeEventListener('message',listen);if(r.error||r.result.exceptionDetails)reject(new Error(JSON.stringify(r.error??r.result.exceptionDetails)));else done(r.result.result.value);};
  socket.addEventListener('message',listen);
  socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
});
const electron="process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
const browser=await chromium.connectOverCDP('http://127.0.0.1:19451');
try {
  const shared=await evaluate(`(()=>{const e=${electron};return {windows:e.BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()==='dsh-app://app/').length,hasMenu:e.Menu.getApplicationMenu().items.some(i=>i.label==='新建窗口'||i.label==='New Window')};})()`);
  assert.equal(shared.windows,1);assert(shared.hasMenu);
  const first=browser.contexts()[0].pages().find(p=>p.url()==='dsh-app://app/');
  await first.getByRole('button',{name:'人格',exact:true}).click();
  await first.getByRole('textbox',{name:'给人格的消息'}).waitFor({timeout:30000});
  assert((await first.locator('body').innerText()).includes('已连接人格'));
  assert(await first.getByText('felibata ne',{exact:true}).count());
  // Open the second formal window through the native shortcut path.
  await evaluate(`(()=>{const e=${electron};const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='dsh-app://app/');w.show();w.focus();w.webContents.sendInputEvent({type:'keyDown',keyCode:'N',modifiers:['control','shift']});w.webContents.sendInputEvent({type:'keyUp',keyCode:'N',modifiers:['control','shift']});return true;})()`);
  await first.waitForTimeout(3000);
  const pages=browser.contexts()[0].pages().filter(p=>p.url()==='dsh-app://app/');
  assert.equal(pages.length,2);
  const details=[];
  for(const page of pages){
    assert(await page.getByText('felibata ne',{exact:true}).count());
    await page.getByRole('button',{name:'人格',exact:true}).click();
    await page.getByRole('textbox',{name:'给人格的消息'}).waitFor({timeout:30000});
    await page.waitForTimeout(1000);
    const state=await page.evaluate(async()=>{
      const [boot,tasks,status]=await Promise.all([window.dshDesktopBoot.ready(),fetch('api/persona.tasks'),fetch('api/persona.status')]);
      const catalog=await tasks.json();
      return {streamBaseUrl:boot.streamBaseUrl,tasksStatus:tasks.status,statusStatus:status.status,taskIds:catalog.tasks.map(t=>t.sessionId).sort()};
    });
    assert.equal(state.tasksStatus,200);assert.equal(state.statusStatus,200);
    assert((await page.locator('body').innerText()).includes('已连接人格'));
    details.push(state);
  }
  assert.deepEqual(details[0],details[1]);
  const sameSession=await evaluate(`(()=>{const e=${electron};const w=e.BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()==='dsh-app://app/');return w[0].webContents.session===w[1].webContents.session;})()`);
  assert(sameSession);
  await pages[1].screenshot({path:resolve(report,'installed-second-window.png')});
  const result={observedAt:new Date().toISOString(),actualInstalledApplication:true,windowCount:2,sameSignedInAccount:true,sameBrowserSession:true,sameBackend:true,sameTaskCatalog:true,personaConnectedInBoth:true,paidPromptsSubmitted:0};
  await writeFile(resolve(report,'installed-validation.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {socket.close();await browser.close();}
