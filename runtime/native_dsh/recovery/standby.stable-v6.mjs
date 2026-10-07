// Independent watchdog: no main profile, UI, memory, browser or computer startup.
import {readFile,writeFile,mkdir,open,rename,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mainRequest,base} from './service-control.stable-v6.mjs';
import {stateRoot,incidents,clean,errorChain} from './diagnostics.stable-v6.mjs';
export const defaults={pollMs:15000,offlineFailures:3,maxEpisodesPerHour:2,cooldownMs:120000,workerTimeoutMs:360000,stallMs:600000};
export async function readPrimaryTail(primary) {
  const dir=resolve(base,'runtime/native_dsh/home/sessions');
  const {readdir}=await import('node:fs/promises');
  for(const name of await readdir(dir)) {
    let file;try{file=await open(resolve(dir,name,primary,'session.v4.jsonl'),'r');}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')continue;throw e;}
    try {
      const stat=await file.stat(),start=Math.max(0,stat.size-512*1024),buffer=Buffer.alloc(stat.size-start);
      await file.read(buffer,0,buffer.length,start);
      const lines=buffer.toString('utf8').split('\n');if(start)lines.shift();lines.pop();
      const events=[];for(const line of lines)try{events.push(JSON.parse(line));}catch{}
      return {lastEvent:events.at(-1),end:events.findLast(e=>e.type==='turn/end'),bytes:stat.size};
    }finally{await file.close();}
  }
  throw Error('Primary event log unavailable');
}
export function shouldRecover({episode,state,now=Date.now(),config=defaults}) {
  if(!episode||state.handled?.includes(episode.key)||state.paused)return false;
  if(now-(state.lastAttemptAt??0)<config.cooldownMs)return false;
  return (state.attempts??[]).filter(t=>now-t<3600000).length<config.maxEpisodesPerHour;
}
export async function watchdog({once=false,root=stateRoot,config=defaults}={}) {
  await mkdir(root,{recursive:true});
  const marker=JSON.parse(await readFile(resolve(base,'reports/first_native_start.json'),'utf8'));
  const primary=marker.native_session_id,path=resolve(root,'watch-state.json');
  let state;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={version:1,handled:[],attempts:[]};}
  const save=async()=>{const temp=path+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify({...state,pid:process.pid,observedAt:new Date().toISOString()},null,2));await rename(temp,path);};
  const mutex=createServer(socket=>{socket.end(JSON.stringify({pid:process.pid,running:true,workerPid:state.workerPid??null}));});
  await new Promise((yes,no)=>{mutex.once('error',no);mutex.listen('\\\\.\\pipe\\persona-independent-recovery',yes);});
  let stopped=false,worker;
  process.once('SIGTERM',()=>{stopped=true;worker?.kill();});
  process.once('SIGINT',()=>{stopped=true;worker?.kill();});
  async function tick(){
    const configPath=resolve(import.meta.dirname,'config.json');
    let policy;try{policy=JSON.parse(await readFile(configPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;policy={enabled:true};}
    state.enabled=policy.enabled!==false;
    config={...defaults,...config,...policy};
    if(!state.enabled){state.phase='paused';await save();return;}
    // Preserve deliberate disable/maintenance boundaries. No auto-enable of user stops.
    try{const disabled=await readFile(resolve(base,'runtime/time_host/production-state/disabled'),'utf8');
      if(!disabled.startsWith('crash-loop ')){state.phase='main-intentionally-disabled';await save();return;}
    }catch(e){if(e.code!=='ENOENT')throw e;}
    try{await access(resolve(root,'maintenance'));state.phase='maintenance';await save();return;}catch(e){if(e.code!=='ENOENT')throw e;}
    let live,episode;
    try{live=await mainRequest('/status');state.offlineCount=0;state.lastHealthyAt=new Date().toISOString();}
    catch(e){state.offlineCount=(state.offlineCount??0)+1;state.lastHealthError=errorChain(e);
      if(state.offlineCount>=config.offlineFailures)episode={key:'offline:'+Math.floor(Date.now()/config.cooldownMs),kind:'main-host-unavailable',error:errorChain(e)};}
    if(live){
      const tail=await readPrimaryTail(primary),end=tail.end;
      if(end?.data.reason.kind==='error') {
        const details=await incidents({sessionId:primary,root,limit:5});
        episode={key:primary+':'+end.seq,kind:'primary-turn-failed',primarySessionId:primary,turn:end.data.turn,
          endSeq:end.seq,occurredAt:new Date(end.time).toISOString(),reason:end.data.reason,details};
      }
      if(live.busy&&Date.now()-(tail.lastEvent?.time??Date.now())>config.stallMs)episode={key:'stalled:'+primary+':'+tail.lastEvent.seq,
        kind:'possible-stall',lastEventAt:tail.lastEvent.time,primarySessionId:primary,busy:true};
      if(live.budget?.stop_reason){state.phase='budget-stopped';await save();return;}
    }
    if(!shouldRecover({episode,state,config})){state.phase=episode?'cooldown-or-handled':'watching';await save();return;}
    state.lastAttemptAt=Date.now();state.attempts=[...(state.attempts??[]).filter(t=>Date.now()-t<3600000),state.lastAttemptAt];
    state.phase='starting-recovery';state.episode=episode;await save();
    const episodePath=resolve(root,'episode-'+Date.now()+'.json');await writeFile(episodePath,JSON.stringify(episode,null,2));
    // A fresh process isolates main/standby from a broken model loop or plugin.
    const output=resolve(root,'worker-'+Date.now()+'.log'),fd=await open(output,'wx',0o600);
    try {
      worker=spawn(process.execPath,[resolve(import.meta.dirname,'kernel.stable-v6.mjs'),'--episode',episodePath],{
        cwd:base,windowsHide:true,stdio:['ignore',fd.fd,fd.fd],env:{...process.env,DL_DIAGNOSTIC_ROOT:root}});
      state.workerPid=worker.pid;state.phase='recovering';await save();
      const exit=await new Promise((yes,no)=>{
        const timer=setTimeout(()=>{worker.kill();yes({code:null,timeout:true});},config.workerTimeoutMs);
        worker.once('error',e=>{clearTimeout(timer);no(e);});worker.once('exit',(code,signal)=>{clearTimeout(timer);yes({code,signal});});
      });
      state.lastWorkerExit=exit;state.lastWorkerLog=output;
      if(exit.code===0)state.handled=[...(state.handled??[]),episode.key].slice(-200);
      state.phase=exit.code===0?'recovery-finished':'recovery-needs-attention';
    }finally{worker=null;state.workerPid=null;await fd.close();await save();}
  }
  try{do{try{await tick();}catch(e){state.phase='watch-error';state.error=errorChain(e);await save();}
    if(once)break;await new Promise(r=>setTimeout(r,config.pollMs));}while(!stopped);}
  finally{mutex.close();}
  return state;
}
if(process.argv[1]===new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1').replaceAll('/','\\')||process.argv[2]==='--run'||process.argv[2]==='--once') {
  watchdog({once:process.argv[2]==='--once'}).then(s=>{if(process.argv[2]==='--once')console.log(JSON.stringify(s));})
    .catch(e=>{console.error(JSON.stringify({standbyFailed:errorChain(e)}));process.exitCode=1;});
}
