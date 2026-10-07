import './windows-dpi.mjs';
import {CuaDriver} from '@trycua/cua-driver';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const d=CuaDriver.create();const out=resolve(import.meta.dirname,'../../reports/status-collapse');await mkdir(out,{recursive:true});
try{
 const call=async(n,a={})=>{const r=JSON.parse((await d.callTool(n,JSON.stringify(a))).rawJson);assert(!r.isError);return r;};
 const w=(await call('list_windows')).structuredContent.windows.find(w=>w.title==='DeepSeek Harness'&&w.app_name==='DeepSeek Harness.exe');assert(w);
 const args={pid:w.pid,window_id:w.window_id};await call('bring_to_front',args);
 const snapshot=()=>call('get_window_state',{...args,max_elements:350,max_dimension:1568});
 let s=await snapshot();let button=s.structuredContent.elements.find(e=>e.label==='▲ 收起状态栏');assert(button,'New toggle must appear in actual desktop');
 await call('click',{...args,element_index:button.element_index,snapshot_id:s.structuredContent.snapshot_id});
 s=await snapshot();button=s.structuredContent.elements.find(e=>e.label==='▼ 展开状态栏');assert(button,'Collapse must expose expand');
 await call('click',{...args,element_index:button.element_index,snapshot_id:s.structuredContent.snapshot_id});
 s=await snapshot();assert(s.structuredContent.elements.some(e=>e.label==='▲ 收起状态栏'));
 const img=s.content.find(b=>b.type==='image');assert(img);await writeFile(resolve(out,'actual-desktop.png'),Buffer.from(img.data,'base64'));
 console.log(JSON.stringify({actualDesktop:true,collapsed:true,expanded:true,paidCalls:0}));
}finally{await d.shutdown();d.uniffiDestroy();}
