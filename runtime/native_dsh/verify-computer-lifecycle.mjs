// Isolated native Session + real read-only tool; no model or desktop input.
import {bootNative,here} from './boot-native.mjs';
import * as Computer from './computer-host.mjs';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile}from'node:fs/promises';
import{resolve}from'node:path';
const root=resolve(here,'../../reports/task_A/indicator-'+randomUUID()), workspace=resolve(root,'workspace');
await mkdir(workspace,{recursive:true});
await writeFile(resolve(workspace,'persona-core.md'),'# Offline indicator test');
await writeFile(resolve(workspace,'AGENTS.md'),'# No model calls or input');
process.env.DEEPSEEK_API_KEY='offline-placeholder-not-a-secret';
const id=randomUUID(),ctx=await bootNative({sessionId:id,testRoot:root});
try{
  await ctx.plugin(Computer);
  await ctx.sessionController.create({sessionId:id,cwd:workspace});
  const{agent}=await ctx.sessionController.resolveAgent(id);
  const call=()=>ctx.tools.execute({name:'cua_driver_native__get_screen_size',arguments:{},
    callId:randomUUID(),agent,signal:new AbortController().signal});
  const visible=()=>ctx.personaComputer.status().indicator.visible;
  assert(!visible());
  assert(!(await call()).isError);assert(visible());
  ctx.personaComputer.setEnabled(false);await new Promise(r=>setTimeout(r,100));assert(!visible());
  assert((await call()).isError);ctx.personaComputer.setEnabled(true);assert(!visible());
  assert(!(await call()).isError);assert(visible());
  agent.session.append('turn/start',{turn:1});
  agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}});
  await new Promise(r=>setTimeout(r,100));assert(!visible(),'Native turn/end must hide the desktop indicator');
  const hashes=Object.fromEntries(await Promise.all(['computer-host.mjs','desktop-overlay.mjs','desktop-overlay.py'].map(async name=>
    [name,createHash('sha256').update(await readFile(resolve(here,name))).digest('hex')])));
  const result={passed:true,observedAt:new Date().toISOString(),paidModelCalls:0,desktopInputSent:false,
    mountedNativeSession:true,shownOnDesktopTool:true,hiddenOnPause:true,resumeIdleHidden:true,
    pausedToolRefused:true,hiddenOnNativeTurnEnd:true,sourceSha256:hashes};
  await writeFile(resolve(here,'../../reports/windows_computer/indicator-lifecycle.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}finally{await ctx.fiber.dispose();}
