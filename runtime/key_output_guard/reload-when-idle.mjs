// One authorized maintenance reload. Never cancels an active Agent turn.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hostRequest} from '../desktop_persona/transport.mjs';
import {readConfig} from '../time_host/supervisor.mjs';
import {control} from '../time_host/control.mjs';
const base=resolve(import.meta.dirname,'../..');
const evidence=JSON.parse(await readFile(resolve(base,'reports/key-output-guard/validation.json'),'utf8'));
if(!evidence.passed||evidence.paidModelCalls!==0)throw Error('Passing isolated acceptance required');
const lock=JSON.parse(await readFile(resolve(base,'runtime/agent_presence/.cache/locks/persona-host.json'),'utf8'));
if(lock.id!==process.argv[2])throw Error('This task must own the Host maintenance lock');
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const config=await readConfig(resolve(base,'runtime/time_host/production-config.json'));
let before;
for(let i=0;i<120;i++){
 const r=await hostRequest('GET','/status');
 if(r.status!==200)throw Error('Host status unavailable; no stop attempted');
 if(!r.value.busy&&!r.value.activeSessionIds?.length){before=r.value;break;}
 if(i===0)console.log(JSON.stringify({waitingForIdle:true,pid:r.value.pid}));
 await sleep(5000);
}
if(!before)throw Error('Host stayed busy; no active turn was interrupted');
const second=await hostRequest('GET','/status');
if(second.value.busy||second.value.activeSessionIds?.length)throw Error('A new turn started; defer maintenance');
await writeFile(resolve(base,'reports/key-output-guard/reload-intent.json'),JSON.stringify({observedAt:new Date().toISOString(),oldPid:before.pid,sessionId:before.sessionId,activeTurnInterrupted:false},null,2)+'\n');
const stopped=await control(config,'stop');if(!stopped.accepted)throw Error('Host stop was not accepted');
for(let i=0;i<30;i++){
 let status;try{status=await control(config);}catch(error){if(!(error instanceof SyntaxError))throw error;}
 if(status?.live===false)break;await sleep(500);if(i===29)throw Error('Supervisor did not stop');
}
// The task can briefly remain Running after the supervisor exits (IgnoreNew).
for(let i=0;i<30;i++){
 const r=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',"(Get-ScheduledTask -TaskName Persona-Official-Harness).State"],{windowsHide:true});
 if(r.stdout.trim()!=='Running')break;await sleep(500);if(i===29)throw Error('Scheduled task did not finish');
}
await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','Start-ScheduledTask -TaskName Persona-Official-Harness'],{windowsHide:true});
let after;
for(let i=0;i<40;i++){
 try{const r=await hostRequest('GET','/status');if(r.status===200&&r.value.ready){after=r.value;break;}}catch{}
 await sleep(3000);
}
if(!after||!after.keyOutputGuard?.enabled||after.filePermissions?.mode!=='danger-full-access')throw Error('New Host did not confirm both full access and output guard');
if(after.sessionId!==before.sessionId||after.pid===before.pid)throw Error('Reload did not preserve the formal Session identity');
const result={passed:true,observedAt:new Date().toISOString(),oldPid:before.pid,newPid:after.pid,sessionId:after.sessionId,
 fullAccess:after.filePermissions,keyOutputGuard:after.keyOutputGuard,activeTurnInterrupted:false,modelPromptSubmitted:false};
await writeFile(resolve(base,'reports/key-output-guard/production.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
