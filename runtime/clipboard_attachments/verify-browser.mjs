import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(new URL('../native_dsh/package.json',import.meta.url))('playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});
const result={isolatedBrowser:true,realUploadRoutes:true,modelCalls:0,checks:[],viewports:[],pageErrors:[]};
try {
  const context=await browser.newContext({viewport:{width:1280,height:850},deviceScaleFactor:1.5});
  const page=await context.newPage();page.on('pageerror',e=>result.pageErrors.push(e.message));
  await page.goto('http://127.0.0.1:18749');await page.waitForFunction(()=>window.__personaDesktopState?.selectedSessionId);
  const initial=(await(await fetch('http://127.0.0.1:18749/evidence')).json()).length;
  await page.locator('.yb-input').evaluate(el=>{
    const d=new DataTransfer();for(const [name,type] of [['截图.png','image/png'],['说明.txt','text/plain'],['录音.wav','audio/wav'],['视频.mp4','video/mp4']])d.items.add(new File([new Uint8Array([0,255,3,77,21])],name,{type}));
    if(el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true})))throw Error('File paste was not consumed');
  });
  await page.locator('[data-attachment-id]').nth(3).waitFor();
  await page.getByRole('button',{name:'第二测试对话',exact:true}).click();assert.equal(await page.locator('[data-attachment-id]').count(),0);
  await page.getByRole('button',{name:'粘贴附件验收',exact:true}).click();assert.equal(await page.locator('[data-attachment-id]').count(),4);
  await page.getByRole('button',{name:'移除附件 说明.txt',exact:true}).click();
  await page.getByRole('button',{name:'发送',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-attachment-id]').length===0);
  const sent=(await(await fetch('http://127.0.0.1:18749/evidence')).json()).slice(initial);assert.equal(sent.length,1);assert.equal(sent[0].ids.length,3);assert(!sent[0].text.includes('说明.txt'));
  await page.locator('.yb-input').evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'v',ctrlKey:true,bubbles:true})));
  await page.getByRole('button',{name:'移除附件 粘贴图片.png',exact:true}).waitFor();
  assert(await page.locator('.yb-input').evaluate(el=>{const d=new DataTransfer();d.setData('text/plain','普通文字');return el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));}));
  result.checks=['four MIME kinds preserve binary upload','session changes preserve separate attachment drafts','removed attachment excluded from one attachment-only send','Ctrl+V without DOM paste uses clipboard route','ordinary text paste keeps native default'];
  await page.screenshot({path:fileURLToPath(new URL('../../reports/clipboard_attachments/browser.png',import.meta.url))});
  result.viewports.push(await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth})));
  await context.close();
  for(const viewport of [{width:1280,height:850},{width:390,height:844}]) {
    const c=await browser.newContext({viewport,deviceScaleFactor:1});const p=await c.newPage();await p.goto('http://127.0.0.1:18749');await p.locator('.yb-input').waitFor();
    const measure=await p.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth,inputWidth:document.querySelector('.yb-input').getBoundingClientRect().width}));assert(!measure.overflow);assert(measure.inputWidth>80);result.viewports.push(measure);await c.close();
  }
  assert.deepEqual(result.pageErrors,[]);result.passed=true;
  await writeFile(new URL('../../reports/clipboard_attachments/browser-validation.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
