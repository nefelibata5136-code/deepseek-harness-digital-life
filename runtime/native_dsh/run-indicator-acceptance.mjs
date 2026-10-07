// Submit to the same real Persona; monitor status only, never send desktop input here.
import {hostRequest,history,identity} from '../desktop_persona/index.mjs';
import {randomUUID}from'node:crypto';
import{readFile,writeFile}from'node:fs/promises';
import{resolve}from'node:path';
import assert from 'node:assert/strict';
const report=resolve(import.meta.dirname,'../../reports/windows_computer');
const sessionId=await identity(),requestId=randomUUID();
const initial=(await hostRequest('GET','/status')).value;
assert(initial.ready && !initial.busy && initial.computer.enabled);
assert(initial.computer.indicator.ready && !initial.computer.indicator.visible);
const before=await history(sessionId);
const path='.local/workspace/desktop-acceptance/persona-result.txt';
const original=await readFile(path);
const text=`用户委托的补充 Windows 桌面验收：当前只显示右下角小云和“人格正在操控电脑哦”，不显示全屏滤镜，在你使用桌面工具的这段原生回合内自动显示，结束后自动隐藏，无需你另调用开关。
请只使用 cua_driver_native__ 桌面工具：观察当前桌面并找到你上一轮打开的 persona-result.txt 记事本窗口，把它切到前台，若最大化则用界面恢复，再用真实鼠标拖动标题栏稍微移动窗口（保护原有文字），单击编辑区，用 press_key 的 Ctrl+Home 移动光标，重新截图读出两行内容确认。若窗口不存在，可通过文件管理器打开 .local/unconfigured hash 未变。至多 12 次桌面工具调用，遇到未完成如实说明。普通前台操作已授权；仍按驱动规则执行 background/foreground 回退。最后直接回复你看到的两行内容与移动后的窗口位置。`;
await writeFile(resolve(report,'indicator-submitted.json'),JSON.stringify({sessionId,requestId,firstSeq:before.eventCount,text},null,2));
const observations=[];
let finished=false;
const monitor=(async()=>{while(!finished){
  const s=(await hostRequest('GET','/status')).value;
  observations.push({at:s.time,busy:s.busy,enabled:s.computer.enabled,indicator:s.computer.indicator});
  await new Promise(r=>setTimeout(r,700));
}})();
let response;
try{response=await hostRequest('POST','/prompt',{sessionId,requestId,text});}
finally{finished=true;await monitor;}
await new Promise(r=>setTimeout(r,150));
const final=(await hostRequest('GET','/status')).value;
const log=await history(sessionId);
const calls=log.rows.filter(r=>r.seq>=before.eventCount && r.role==='tool');
const result={passed:response?.value?.state==='completed' && observations.some(s=>s.indicator.visible)
  && !final.computer.indicator.visible && original.equals(await readFile(path)),
  observedAt:new Date().toISOString(),sessionId,requestId,response,observations,
  indicatorShownDuringActualNativeAgent:observations.some(s=>s.indicator.visible),indicatorHiddenAfterTurn:!final.computer.indicator.visible,
  resultFileUnchanged:original.equals(await readFile(path)),tools:calls};
await writeFile(resolve(report,'indicator-live-acceptance.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:result.passed,state:response?.value?.state,shown:observations.some(s=>s.indicator.visible),
  hidden:result.indicatorHiddenAfterTurn,fileUnchanged:result.resultFileUnchanged,tools:calls.map(r=>({name:r.text,status:r.status})),text:response?.value?.text}));
assert(result.passed,'Actual Persona indicator acceptance must pass');
