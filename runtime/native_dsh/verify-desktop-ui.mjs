// Control-side verification of the installed Electron UI; no Agent/model calls.
import './windows-dpi.mjs';
import assert from 'node:assert/strict';
import { CuaDriver } from '@trycua/cua-driver';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostRequest } from '../desktop_persona/index.mjs';

const report=resolve(import.meta.dirname,'../../reports/windows_computer');
const driver=CuaDriver.create();
const call=async(name,args={})=>{
  const raw=JSON.parse((await driver.callTool(name,JSON.stringify(args))).rawJson);
  assert(!raw.isError,JSON.stringify(raw.content?.filter(b=>b.type==='text')));
  return raw;
};
let app;
try {
  const windows=(await call('list_windows')).structuredContent.windows;
  app=windows.find(w=>w.title==='DeepSeek Harness' && w.app_name==='DeepSeek Harness.exe');
  assert(app,'Installed Electron window must exist');
  const args={pid:app.pid,window_id:app.window_id};
  await call('bring_to_front',args);
  const snapshot=()=>call('get_window_state',{...args,max_elements:180,max_dimension:1568});
  let state=await snapshot();
  const find=label=>state.structuredContent.elements.find(e=>e.label===label);
  let pause=find('暂停电脑操作');
  assert(pause,'Actual desktop renderer must expose the new pause control');
  const click=element=>call('click',{...args,element_index:element.element_index,snapshot_id:state.structuredContent.snapshot_id});
  await click(pause);
  assert.equal((await hostRequest('GET','/status')).value.computer.enabled,false);
  state=await snapshot();
  const resume=find('恢复电脑操作');assert(resume,'Paused UI must expose resume');
  await click(resume);
  assert.equal((await hostRequest('GET','/status')).value.computer.enabled,true);
  state=await snapshot();
  const image=state.content.find(b=>b.type==='image');assert(image);
  await writeFile(resolve(report,'desktop-controls.png'),Buffer.from(image.data,'base64'));
  const result={passed:true,observedAt:new Date().toISOString(),actualElectronWindow:true,
    app,args,pauseThroughActualButton:true,resumeThroughActualButton:true,paidModelCalls:0,
    controlsRestoredEnabled:true,screenshotDimensions:{width:state.structuredContent.screenshot_width,height:state.structuredContent.screenshot_height}};
  await writeFile(resolve(report,'desktop-ui-validation.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  if(!(await hostRequest('GET','/status')).value.computer.enabled)await hostRequest('POST','/computer',{enabled:true});
  await driver.shutdown();driver.uniffiDestroy();
}
