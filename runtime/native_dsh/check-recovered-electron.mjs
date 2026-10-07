import './windows-dpi.mjs';
import {CuaDriver} from '@trycua/cua-driver';
import {writeFile} from 'node:fs/promises';
const d=CuaDriver.create();
try {
 const call=async(n,a={})=>JSON.parse((await d.callTool(n,JSON.stringify(a))).rawJson);
 const w=(await call('list_windows')).structuredContent.windows.find(w=>w.title==='DeepSeek Harness'&&w.app_name==='DeepSeek Harness.exe');
 if(!w)throw Error('DSH window unavailable');
 const s=await call('get_window_state',{pid:w.pid,window_id:w.window_id,max_elements:250,max_dimension:1568});
 const labels=s.structuredContent.elements.map(e=>e.label??'');
 const connected=labels.some(t=>t.includes('已连接人格')||t.includes('人格正在执行')||t.includes('其他对话正在执行，可继续聊天'));
 const r={observedAt:new Date().toISOString(),actualElectronWindow:true,connected,newTaskControl:labels.some(t=>t.includes('新建任务')),sendControl:labels.some(t=>t==='发送'||t==='发送并排队'),passed:connected&&labels.some(t=>t.includes('新建任务'))};
 await writeFile(new URL('../../reports/desktop_persona/recovery/electron-validation.json',import.meta.url),JSON.stringify(r,null,2));
 console.log(JSON.stringify(r));
}finally{await d.shutdown();d.uniffiDestroy();}
