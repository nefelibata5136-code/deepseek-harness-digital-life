// Does not import Desktop/main Host plugins. Standby remains usable when they fail.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {request} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readConfig} from '../../time_host/supervisor.mjs';
import {control} from '../../time_host/control.mjs';
export const base=resolve(import.meta.dirname,'../../..');
const execute=promisify(execFile);
export async function mainRequest(route,value,timeoutMs=15000) {
  const marker=JSON.parse(await readFile(resolve(base,'reports/first_native_start.json'),'utf8'));
  const c=JSON.parse(await readFile(resolve(base,'runtime/native_dsh/host-state/.host-control.json'),'utf8'));
  if(c.sessionId!==marker.native_session_id||c.port!==18741)throw Error('Primary control identity mismatch');
  return new Promise((yes,no)=>{
    const req=request({hostname:'127.0.0.1',port:c.port,path:route,method:value?'POST':'GET',
      signal:AbortSignal.timeout(timeoutMs),headers:{authorization:'Bearer '+c.token,'content-type':'application/json'}},res=>{
      const chunks=[];res.on('error',no);res.on('data',v=>chunks.push(v));res.on('end',()=>{
        try{const answer=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode!==200)throw Error(answer.error??('HTTP '+res.statusCode));yes(answer);}catch(e){no(e);}
      });
    });req.on('error',no);req.end(value?JSON.stringify(value):undefined);
  });
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function restartMain({allowOffline=false}={}) {
  let status;try{status=await mainRequest('/status');}catch(e){if(!allowOffline)throw e;}
  if(status?.busy||status?.activeSessionIds?.length)throw Error('Active native turn: no restart performed');
  const config=await readConfig(resolve(base,'runtime/time_host/production-config.json'));
  // An intentional disable is never silently undone. Crash-loop disables can be repaired explicitly.
  try{const disabled=await readFile(resolve(config.stateDir,'disabled'),'utf8');
    if(!disabled.startsWith('crash-loop '))throw Error('Host intentionally disabled; respect user pause');
  }catch(e){if(e.code!=='ENOENT')throw e;}
  if(status){const fresh=await mainRequest('/status');if(fresh.busy||fresh.activeSessionIds?.length)throw Error('Host became busy');}
  const stopped=await control(config,'stop');
  if(!stopped.accepted&&stopped.live!==false)throw Error('Host stop not accepted');
  for(let i=0;i<40;i++){let live;try{live=await control(config);}catch(e){if(!(e instanceof SyntaxError))throw e;}
    if(live?.live===false)break;await delay(500);if(i===39)throw Error('Supervisor has not stopped');}
  for(let i=0;i<40;i++){
    const r=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-ScheduledTask -TaskName Persona-Official-Harness).State'],{windowsHide:true});
    if(r.stdout.trim()!=='Running')break;await delay(500);if(i===39)throw Error('Main scheduled task still running');
  }
  await control(config,'enable');
  await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command','Start-ScheduledTask -TaskName Persona-Official-Harness'],{windowsHide:true});
  for(let i=0;i<240;i++){
    await delay(500);try{const after=await mainRequest('/status');
      if(after.ready&&after.sessionId===config.sessionId)return {restarted:true,beforePid:status?.pid??null,afterPid:after.pid,sessionId:after.sessionId};
    }catch{}
  }
  throw Error('Restart did not become healthy; evidence retained');
}
if(process.argv[2]==='restart')console.log(JSON.stringify(await restartMain()));
