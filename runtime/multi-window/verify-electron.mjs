import {createRequire} from 'node:module';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import * as asar from 'file:///.local/unconfigured';
import {Pickle} from 'file:///.local/unconfigured';
import {getFileIntegrityFromBuffer} from 'file:///.local/unconfigured';
const require = createRequire(import.meta.url);
const {_electron} = createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const report=resolve(dirname(fileURLToPath(import.meta.url)), '../../reports/multi-window');
const isolation=resolve(report, 'isolation');
await mkdir(isolation,{recursive:true});
await writeFile(resolve(isolation,'home/profiles/desktop/cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n');
const staged=resolve(report,'app.asar');
const raw=asar.getRawHeader(staged);
const original=await readFile(staged);
const body=original.subarray(8+raw.headerSize);
let bundle=asar.extractFile(staged,'lib/main.js').toString();
bundle=bundle.replace('app.setAppLogsPath();', `app.setPath('userData', ${JSON.stringify(resolve(isolation,'userData'))});\nprocess.env.DSH_HOME=${JSON.stringify(resolve(isolation,'home'))};\napp.setAppLogsPath();`);
bundle=bundle.replace('app.setAsDefaultProtocolClient("dsh")', 'void 0');
bundle=bundle.replace(/const policyConfig = resolveDesktopPolicyConfig\([^;]+;/, 'const policyConfig = undefined;');
const main=Buffer.from(bundle);
Object.assign(raw.header.files.lib.files['main.js'],{size:main.length,offset:String(body.length),integrity:getFileIntegrityFromBuffer(main)});
const headerPickle=new Pickle();headerPickle.writeString(JSON.stringify(raw.header));
const header=headerPickle.toBuffer();const sizePickle=new Pickle();sizePickle.writeUInt32(header.length);
await writeFile(resolve(report,'isolated-app/resources/app.asar'),Buffer.concat([sizePickle.toBuffer(),header,body,main]));
const errors=[];
const application=await _electron.launch({executablePath:resolve(report,'isolated-app/DeepSeek Harness.exe'),args:['--force-renderer-accessibility'],timeout:90000});
application.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
try {
  let page=await application.firstWindow();
  await page.waitForTimeout(8000);
  console.log('Initial windows:', (await application.windows()).map(p=>p.url()));
  const welcome=(await application.windows()).find(p=>p.url().includes('welcome'));
  if(welcome){
    console.log('Welcome buttons:',await welcome.getByRole('button').allTextContents());
    await welcome.evaluate(()=>window.dshWelcome.skip());
  }
  page=(await application.windows()).find(p=>p.url()==='dsh-app://app/')??page;
  await page.waitForTimeout(3000);
  const opened=await application.evaluate(({Menu})=>{
    const find=items=>{for(const item of items){if(item.label==='New Window'||item.label==='新建窗口')return item;if(item.submenu){const nested=find(item.submenu.items);if(nested)return nested;}}};
    const item=find(Menu.getApplicationMenu().items);
    if(!item)throw new Error('New Window menu missing');
    if(!item.enabled)throw new Error('New Window menu disabled');
    item.click();return true;
  });
  assert(opened);
  await page.waitForTimeout(3000);
  let windows=(await application.windows()).filter(p=>p.url()==='dsh-app://app/');
  assert.equal(windows.length,2);
  for(const p of windows){
    const result=await p.evaluate(async()=>({boot:!!(await window.dshDesktopBoot.ready()),api:!!window.dshDesktop}));
    console.log('Window loaded:', result, (await p.title()));
    assert(!/unavailable/i.test(await p.title()));
    assert(result.boot && result.api);
  }
  assert(await application.evaluate(({BrowserWindow})=>{
    const windows=BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()==='dsh-app://app/');
    return windows[0].webContents.session === windows[1].webContents.session;
  }));
  // CDP keyboard delivery bypasses Electron's native input event; use WebContents input.
  await windows[0].bringToFront();
  await application.evaluate(({BrowserWindow})=>{
    const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='dsh-app://app/');
    window.show();window.focus();
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'N',modifiers:['control','shift']});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'N',modifiers:['control','shift']});
  });
  await page.waitForTimeout(2500);
  windows=(await application.windows()).filter(p=>p.url()==='dsh-app://app/');
  assert.equal(windows.length,3);
  await windows[2].screenshot({path:resolve(report,'isolated-third-window.png')});
  const extraWindow=await application.browserWindow(windows[2]);
  await extraWindow.evaluate(window=>window.close());
  await windows[0].waitForTimeout(500);
  assert.equal((await application.windows()).filter(p=>p.url()==='dsh-app://app/').length,2);
  const result={observedAt:new Date().toISOString(),menuOpensSecondWindow:true,acceleratorOpensThirdWindow:true,closingExtraPreservesOtherWindows:true,sharedBrowserSession:true,isolatedHome:true,errors};
  await writeFile(resolve(report,'electron-validation.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  await application.evaluate(({app})=>app.exit(0)).catch(()=>{});
  await application.close().catch(()=>{});
}
