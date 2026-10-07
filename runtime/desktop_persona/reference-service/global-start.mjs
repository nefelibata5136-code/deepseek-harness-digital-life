// Human control only. Restores existing workers, never injects a prompt or changes Resident policy.
import {readFile,writeFile,rename,unlink,open,mkdir,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {controlPipe} from '../../time_host/supervisor.mjs';
import {worldRoot,migrationRoot,worldSnapshot} from '../../native_dsh/multi-life/supervisor/deployment.mjs';
import {worldRequest,workerRequest} from '../../native_dsh/multi-life/supervisor/client.mjs';
const run=promisify(execFile),sleep=ms=>new Promise(done=>setTimeout(done,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const root=resolve(worldRoot,'supervisor'),deploymentPath=resolve(root,'deployments.json');
let stopJob=null;
const safeCode=e=>/^[A-Z_]+$/.test(e.code??e.message??'')?e.code??e.message:'START_NOT_CONFIRMED';
export async function stopModernWorker(life,pid,{request=workerRequest,isAlive=alive,terminate=async pid=>{
 if(process.platform==='win32')await run('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});else process.kill(pid,'SIGTERM');
}}={}){
 if(!pid||!isAlive(pid))return {interrupted_active_worker:false};
 const live=await request(life.lifeId,'/status');
 if(live.pid!==pid||live.life_id!==life.lifeId)throw Error('WORKER_OWNER_MISMATCH');
 try{await request(life.lifeId,'/stop',{method:'POST',input:{}});return {interrupted_active_worker:false};}
 catch(e){if(e.code!=='WORKER_BUSY')throw e;await terminate(pid);return {interrupted_active_worker:true};}
}

export function createStarter({list,status,enable,start,wait,lock=async()=>async()=>{},audit=async()=>{}}){
 let job=null;
 return {
  job:()=>job&&structuredClone(job),
  cancel:lifeId=>{if(job?.state==='starting'&&job.target_life_id===lifeId){job.cancel_requested=true;return true;}return false;},
  async restore(lifeId=null){
   if(job?.state==='starting'){if(job.target_life_id!==lifeId)throw Error('GLOBAL_START_IN_PROGRESS');return structuredClone(job);}
   const release=await lock();
   job={id:randomUUID(),target_life_id:lifeId,action:'start',state:'starting',started_at:new Date().toISOString(),workers:[]};
   const current=job;
   // Respond immediately; readiness is observed through GET, not a long HTTP request.
   void (async()=>{
    try{
     for(const life of (await list()).filter(l=>!lifeId||l.lifeId===lifeId)){
      const row={life_id:life.lifeId,display_name:life.displayName,state:'starting'};current.workers.push(row);
      try{
       if(current.cancel_requested)throw Error('START_CANCELLED_BY_HUMAN');
       await enable(life);
       const live=await status(life);
       if(live){row.state='already-online';continue;}
       if(current.cancel_requested)throw Error('START_CANCELLED_BY_HUMAN');
       await start(life);await wait(life,()=>current.cancel_requested===true);row.state='online';
      }catch(e){row.state='failed';row.error_code=safeCode(e);}
     }
     current.state=current.workers.some(w=>w.state==='failed')?'partial-failure':'completed';
    }catch(e){current.state='failed';current.error_code=safeCode(e);}
    finally{current.finished_at=new Date().toISOString();try{await audit(current);}catch{current.audit_error=true;}await release();}
   })();
   return structuredClone(job);
  }
 };
}
async function lock(){
 await mkdir(root,{recursive:true});const path=resolve(root,'global-start.lock');let handle;
 try{handle=await open(path,'wx');}catch(e){
  if(e.code!=='EEXIST')throw e;
  const old=JSON.parse(await readFile(path,'utf8'));
  if(alive(old.pid))throw Error('GLOBAL_START_IN_PROGRESS');
  await unlink(path);handle=await open(path,'wx');
 }
 await handle.writeFile(JSON.stringify({pid:process.pid,created_at:new Date().toISOString()}));await handle.close();
 return async()=>{await unlink(path);};
}
async function enable(life){
 const before=await readFile(deploymentPath,'utf8'),value=JSON.parse(before),row=value.workers?.[life.lifeId];
 if(!row)throw Error('EXPLICIT_WORKER_DEPLOYMENT_REQUIRED');
 if(row.execution_disabled===true){
  await writeFile(resolve(root,'deployments.before-global-start-'+randomUUID()+'.json'),before,{flag:'wx'});
  row.execution_disabled=false;row.execution_resumed_at=new Date().toISOString();row.execution_resumed_source='human-global-start-button';
  delete row.execution_disabled_reason;
  if(await readFile(deploymentPath,'utf8')!==before)throw Error('DEPLOYMENT_CHANGED_DURING_START');
  const tmp=deploymentPath+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(tmp,deploymentPath);
 }
 if(life.kind==='legacy'){
  const config=JSON.parse(await readFile(resolve(migrationRoot,'runtime/time_host/production-config.json'),'utf8'));
  const disabled=resolve(config.stateDir,'disabled');
  try{await rename(disabled,disabled+'.before-global-start-'+randomUUID());}catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
async function status(life){
 try{
  const s=await workerRequest(life.lifeId,'/status');
  if(life.kind==='legacy'&&s.sessionId!==life.authoritySessionId)throw Error('WORKER_OWNER_MISMATCH');
  if(life.kind!=='legacy'&&s.life_id!==life.lifeId)throw Error('WORKER_OWNER_MISMATCH');
  return s.ready===false?null:s;
 }catch(e){if(e.message==='WORKER_OWNER_MISMATCH')throw e;return null;}
}
async function ensureWorld(){
 try{return await worldRequest('/v1/supervisor');}catch{}
 const c=JSON.parse(await readFile(resolve(root,'control.json'),'utf8'));
 if(alive(c.pid))throw Error('WORLD_RUNNING_BUT_UNREACHABLE');
 const out=await open(resolve(root,'logs/global-start-world.stdout.log'),'a'),err=await open(resolve(root,'logs/global-start-world.stderr.log'),'a');
 try{
  const child=spawn(process.execPath,[resolve(migrationRoot,'runtime/native_dsh/multi-life/supervisor/neutral.mjs')],{cwd:migrationRoot,windowsHide:true,detached:true,stdio:['ignore',out.fd,err.fd]});
  await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});child.unref();
 }finally{await out.close();await err.close();}
 for(let n=0;n<30;n++){await sleep(1000);try{return await worldRequest('/v1/supervisor');}catch{}}
 throw Error('WORLD_READY_TIMEOUT');
}
const starter=createStarter({
 list:async()=>{await ensureWorld();return Object.values(worldSnapshot().lives);},status,enable,lock,
 start:async life=>{
  if(life.kind!=='legacy'){
   try{const c=JSON.parse(await readFile(resolve(worldRoot,'workers',life.lifeId,'control.json'),'utf8'));if(alive(c.pid))throw Error('WORKER_RUNNING_BUT_UNREACHABLE');}
   catch(e){if(e.code!=='ENOENT')throw e;}
  }
  try{await run(process.execPath,[resolve(migrationRoot,'runtime/native_dsh/multi-life/supervisor/operate.mjs'),'--start-life',life.lifeId],{windowsHide:true,timeout:45000});}
  catch(e){if(/LEGACY_SUPERVISOR_ALREADY_RUNNING|WORKER_ALREADY_RUNNING/.test(e.stderr??''))return;throw Error('WORKER_LAUNCH_FAILED');}
 },
 wait:async(life,cancelled)=>{const deadline=Date.now()+300000;while(Date.now()<deadline){if(cancelled())throw Error('START_CANCELLED_BY_HUMAN');if(await status(life))return;await sleep(1500);}throw Error('WORKER_READY_TIMEOUT');},
 audit:job=>appendFile(resolve(root,'global-start.jsonl'),JSON.stringify(job)+'\n')
});
export async function globalStatus(){
 const deployments=JSON.parse(await readFile(deploymentPath,'utf8'));let world;
 try{world=await worldRequest('/v1/supervisor');}catch{}
 return {world_online:!!world,workers:Object.values(worldSnapshot().lives).map(life=>{
  const worker=world?.workers.find(w=>w.life_id===life.lifeId),disabled=deployments.workers?.[life.lifeId]?.execution_disabled===true;
  return {life_id:life.lifeId,display_name:life.displayName,healthy:worker?.healthy===true,execution_disabled:disabled,state:disabled?'disabled':worker?.state??'offline'};
 }),operation:[starter.job(),stopJob].filter(Boolean).sort((a,b)=>b.started_at.localeCompare(a.started_at))[0]??null};
}
function pipe(config,command){return new Promise((yes,no)=>{
 let data='';const socket=net.connect(controlPipe(config));socket.setTimeout(20000);
 socket.once('connect',()=>socket.write(command+'\n'));socket.on('data',b=>data+=b);
 socket.once('end',()=>{try{yes(JSON.parse(data));}catch{no(Error('SUPERVISOR_REPLY_INVALID'));}});
 socket.once('error',no);socket.once('timeout',()=>{socket.destroy();no(Error('SUPERVISOR_CONTROL_TIMEOUT'));});
});}
export async function controlLife(input){
 if(!input||Object.keys(input).some(k=>!['life_id','action'].includes(k))||!['start','stop'].includes(input.action))throw Error('INVALID_LIFE_CONTROL');
 const life=worldSnapshot().lives[input.life_id];if(!life)throw Error('EXPLICIT_EXISTING_LIFE_REQUIRED');
 if(input.action==='start')return {operation:await starter.restore(life.lifeId)};
 if(stopJob?.state==='stopping'){if(stopJob.target_life_id!==life.lifeId)throw Error('GLOBAL_START_IN_PROGRESS');return {operation:structuredClone(stopJob)};}
 if(starter.cancel(life.lifeId)){
  const deadline=Date.now()+45000;
  while(starter.job()?.state==='starting'){if(Date.now()>deadline)throw Error('START_CANCELLATION_PENDING');await sleep(100);}
 }
 const release=await lock();
 stopJob={id:randomUUID(),target_life_id:life.lifeId,action:'stop',state:'stopping',started_at:new Date().toISOString(),workers:[{life_id:life.lifeId,display_name:life.displayName,state:'stopping'}]};
 const job=stopJob;
 void (async()=>{
  try{
   // Persist the human stop gate first: later startup paths cannot revive it.
   const before=await readFile(deploymentPath,'utf8'),value=JSON.parse(before),row=value.workers[life.lifeId];
   await writeFile(resolve(root,'deployments.before-global-stop-'+randomUUID()+'.json'),before,{flag:'wx'});
   row.execution_disabled=true;row.execution_disabled_reason='human per-life stop button';row.execution_disabled_at=new Date().toISOString();
   if(await readFile(deploymentPath,'utf8')!==before)throw Error('DEPLOYMENT_CHANGED_DURING_STOP');
   const tmp=deploymentPath+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(tmp,deploymentPath);
   let pid;
   if(life.kind==='legacy'){
    const config=JSON.parse(await readFile(resolve(migrationRoot,'runtime/time_host/production-config.json'),'utf8'));
    await writeFile(resolve(config.stateDir,'disabled'),new Date().toISOString()+'\n');
    try{const live=await pipe(config,'status');if(live.sessionId!==life.authoritySessionId)throw Error('WORKER_OWNER_MISMATCH');pid=live.hostPid;await pipe(config,'disable');}
    catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
   }else{
    let c;try{c=JSON.parse(await readFile(resolve(worldRoot,'workers',life.lifeId,'control.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    pid=c?.pid;
    // Human stop wins over busy, after an authenticated PID/owner match.
    // Keep journals/accounting and never replay an interrupted request.
    Object.assign(job.workers[0],await stopModernWorker(life,pid));
   }
   const deadline=Date.now()+45000;
   while(pid&&alive(pid)){if(Date.now()>deadline)throw Error('WORKER_STOP_TIMEOUT');await sleep(500);}
   job.state='completed';job.workers[0].state='stopped';
  }catch(e){job.state='failed';job.workers[0].state='failed';job.workers[0].error_code=safeCode(e);}
  finally{job.finished_at=new Date().toISOString();try{await appendFile(resolve(root,'global-start.jsonl'),JSON.stringify(job)+'\n');}catch{job.audit_error=true;}try{await release();}catch{job.lock_release_error=true;}}
 })();
 return {operation:structuredClone(job)};
}
