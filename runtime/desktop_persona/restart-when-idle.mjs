// One maintenance restart after the requested acceptance, only while all turns are idle.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hostRequest} from './usage-adapter.mjs';
import {control} from '../time_host/control.mjs';
import {readConfig} from '../time_host/supervisor.mjs';
const sleep = ms=>new Promise(done=>setTimeout(done,ms));
const folder=resolve('reports/digital-life/reconnect-20261005');
const output=resolve(folder,'formal-restart-validation.json');
try {await readFile(output);throw new Error('This maintenance restart already has evidence; do not restart again.');}
catch(error){if(error.code!=='ENOENT')throw error;}
const config=await readConfig(resolve('runtime/time_host/production-config.json'));
let before;
for(;;){
  {
    const request=JSON.parse(await readFile(resolve(folder,'persona-acceptance-request.json'),'utf8'));
    const history=(await readFile(resolve('runtime/native_dsh/home/sessions/--C-Users-maintainer-Desktop-~4E91~5B9D~7684~7A7A~95F4--',config.sessionId,'session.v4.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const input=history.findLast(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.source?.rpcId===request.requestId));
    const calls=history.filter(e=>e.seq>(input?.seq??Infinity)&&e.type==='tool/call');
    const check=calls.findLast(e=>e.data.name==='terminal'&&String(e.data.arguments).includes('maintain.mjs')&&String(e.data.arguments).includes('check'));
    const result=check&&history.find(e=>e.type==='tool/result'&&e.data.message?.toolCallId===check.data.callId);
    const text=result?.data.message?.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n')??'';
    let passed=false;
    try{const terminal=JSON.parse(text);passed=terminal.returncode===0&&terminal.stdout.split('\n').some(line=>{try{return JSON.parse(line).passed===true;}catch{return false;}});}catch{}
    const end=result&&history.find(e=>e.seq>result.seq&&e.type==='turn/end'&&e.data.reason?.kind==='completed');
    if(!result||result.data.message.isError||!passed||!end){await sleep(5000);continue;}
    const followup=JSON.parse(await readFile(resolve(folder,'persona-acceptance-followup-request.json'),'utf8'));
    await writeFile(resolve(folder,'persona-acceptance-validation.json'),JSON.stringify({passed:true,requestId:followup.requestId,originalRequestId:request.requestId,
      sessionId:config.sessionId,checkCallId:check.data.callId,checkResultSeq:result.seq,observedAt:new Date().toISOString(),
      source:'Persona native terminal call and result',systemAuthoredMentalState:false},null,2));
    // Another authorized agent may be changing the formal composition. Never
    // stop the healthy Host until its reviewed startup gate passes again.
    try {
      await promisify(execFile)(config.env?.PYTHON ?? 'python',
        ['runtime/start_persona.py','--preview'],{cwd:resolve('.'),windowsHide:true});
      const r=await hostRequest('GET','/status');if(r.status===200&&r.value.ready&&!r.value.busy&&!r.value.activeSessionIds.length){before=r.value;break;}
    }
    catch{/* The current synchronous backup may block HTTP. Never interrupt it. */}
  }
  await sleep(5000);
}
console.log(JSON.stringify({idleConfirmed:true,sessionId:before.sessionId,pid:before.pid}));
const stopped=await control(config,'stop');if(!stopped.accepted)throw new Error('Formal stop was not accepted');
for(let i=0;i<30;i++){const status=await control(config);if(status.live===false)break;if(i===29)throw new Error('Formal Host did not stop');await sleep(1000);}
await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','Start-ScheduledTask -TaskName Persona-Official-Harness'],{windowsHide:true});
let after;
for(let i=0;i<28;i++){
  try {const r=await hostRequest('GET','/status');if(r.status===200&&r.value.ready){after=r.value;break;}}catch{}
  await sleep(5000);
}
if(!after)throw new Error('Formal Task Scheduler entry did not become ready');
if(after.sessionId!==before.sessionId||after.pid===before.pid)throw new Error('Restart identity or PID did not match');
const mentalProvenanceUnchanged = JSON.stringify(after.digitalLife?.mental) === JSON.stringify(before.digitalLife?.mental);
if(!mentalProvenanceUnchanged)throw new Error('Mental provenance changed during restart; inspect before claiming continuity');
const result={passed:true,observedAt:new Date().toISOString(),taskName:'Persona-Official-Harness',
  idleBeforeStop:true,sameIdentity:true,oldPid:before.pid,newPid:after.pid,sessionId:after.sessionId,
  residentEnabled:after.digitalLife?.settings.residentEnabled,mentalProvenanceUnchanged,
  lastWakeAt:after.digitalLife?.clock.lastWakeAt,nextWakeAt:after.digitalLife?.clock.nextWakeAt,
  modelPromptSubmittedByRestart:false,wholeMachineRebootTested:false};
await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
