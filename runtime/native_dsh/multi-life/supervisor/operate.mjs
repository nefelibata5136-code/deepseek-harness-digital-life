import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import net from 'node:net';
import {controlPipe} from '../../../time_host/supervisor.mjs';
import {credentialOperation} from '../../capabilities/isolation.mjs';
import {worldRoot,migrationRoot,python,worldSnapshot,workerLayout,assertLifeExecutionEnabled} from './deployment.mjs';
import {workerReference} from './neutral.mjs';
import {worldRequest,workerRequest} from './client.mjs';
import {fail} from '../contracts.mjs';

async function secret(ref){const result=await credentialOperation(python,'resolve',ref);if(!result?.value)fail('HOST_CONTROL_CREDENTIAL_UNAVAILABLE');return result.value;}
async function get(base,path,token){const r=await fetch(base+path,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});if(!r.ok)fail('HOST_STATUS_UNAVAILABLE');return r.json();}
async function launch(script,args,label,cwd=migrationRoot) {
  const folder=resolve(worldRoot,'supervisor/logs');await mkdir(folder,{recursive:true});
  const out=await open(resolve(folder,label+'.stdout.log'),'a'),err=await open(resolve(folder,label+'.stderr.log'),'a');
  const child=spawn(process.execPath,[script,...args],{cwd,windowsHide:true,detached:true,stdio:['ignore',out.fd,err.fd]});
  await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});
  child.unref();await out.close();await err.close();return child.pid;
}
async function pipeCommand(config,command) {
  return new Promise((accept,reject)=>{let text='';const socket=net.connect(controlPipe(config));socket.setTimeout(20000);
    socket.once('connect',()=>socket.write(command+'\n'));socket.on('data',data=>text+=data);socket.once('end',()=>{try{accept(JSON.parse(text));}catch{reject(new Error('SUPERVISOR_REPLY_INVALID'));}});
    socket.once('error',()=>reject(new Error('SUPERVISOR_CONTROL_UNAVAILABLE')));socket.once('timeout',()=>{socket.destroy();reject(new Error('SUPERVISOR_CONTROL_TIMEOUT'));});
  });
}
async function waitForExit(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0)fail('EXACT_PROCESS_ID_REQUIRED');
  const deadline=Date.now()+25000;
  for(;;){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw error;}
    if(Date.now()>deadline)fail('WORKER_STOP_TIMEOUT');await new Promise(done=>setTimeout(done,200));}
}
const mode=process.argv[2],marker=JSON.parse(await readFile(resolve(worldRoot,'birth.json'),'utf8'));
if(mode==='--migrate') {
  const control=JSON.parse(await readFile(resolve(migrationRoot,'runtime/native_dsh/host-state/.host-control.json'),'utf8'));
  const [modern,legacy]=await Promise.all([get('http://127.0.0.1:'+marker.port,'/v1/status?life_id='+marker.life_id,await secret(marker.human_token_ref)),get('http://127.0.0.1:'+control.port,'/status',control.token)]);
  if(modern.busy||legacy.busy||legacy.activeSessionIds?.length)fail('MIGRATION_REQUIRES_IDLE_WORKERS');
  const config=JSON.parse(await readFile(resolve(migrationRoot,'runtime/time_host/production-config.json'),'utf8'));
  const oldSupervisor=await pipeCommand(config,'status');if(oldSupervisor.hostPid!==legacy.pid||legacy.pid!==control.pid)fail('LEGACY_PROCESS_IDENTITY_MISMATCH');
  await mkdir(resolve(worldRoot,'supervisor'),{recursive:true});
  await writeFile(resolve(worldRoot,'supervisor/migration-before.json'),JSON.stringify({observed_at:new Date().toISOString(),legacy_pid:legacy.pid,modern_pid:marker.pid,
    authority_ids:worldSnapshot().lives,previous_topology:'public-world-in-modern-worker',actions:'idle exact worker migration; no Session/Core reset'},null,2)+'\n');
  await pipeCommand(config,'stop');
  process.kill(marker.pid);
  const worldPid=await launch(resolve(import.meta.dirname,'neutral.mjs'),[],'neutral');
  console.log(JSON.stringify({stage:'neutral-starting',world_pid:worldPid,stopped_worker_pids:[legacy.pid,marker.pid]}));
}else if(mode==='--start-workers') {
  const state=worldSnapshot(),result=[];
  for(const m of Object.values(state.lives)) {
    if(m.kind!=='legacy'&&workerLayout(m.lifeId).execution_disabled===true){result.push({life_id:m.lifeId,stage:'disabled-by-user'});continue;}
    if(m.kind==='legacy')result.push({life_id:m.lifeId,launcher_pid:await launch(resolve(migrationRoot,'runtime/time_host/supervisor.mjs'),[resolve(migrationRoot,'runtime/time_host/production-config.json')],'legacy-supervisor',m.deployment.workspace)});
    else result.push({life_id:m.lifeId,pid:await launch(resolve(import.meta.dirname,'life-worker.mjs'),[m.lifeId,String(workerLayout(m.lifeId).port)],'worker-'+m.lifeId)});
  }
  console.log(JSON.stringify({stage:'workers-starting',workers:result}));
}else if(mode==='--stop-workers') {
  const state=worldSnapshot();
  for(const m of Object.values(state.lives)) {
    if(m.kind==='legacy') {
      const config=JSON.parse(await readFile(resolve(migrationRoot,'runtime/time_host/production-config.json'),'utf8'));
      const controller=await pipeCommand(config,'status');
      if(controller.status==='ready') {const status=await workerRequest(m.lifeId,'/status');if(status.busy)fail('WORKER_BUSY');}
      await pipeCommand(config,'stop');
    }else {
      const status=await workerRequest(m.lifeId,'/status');if(status.sessions?.some(s=>s.busy))fail('WORKER_BUSY');
      await workerRequest(m.lifeId,'/stop',{method:'POST',input:{}});
    }
  }
  console.log(JSON.stringify({stage:'workers-stopping'}));
}else if(mode==='--restart-world') {
  const status=await worldRequest('/v1/supervisor');if(status.workers.some(w=>w.healthy&&w.state==='busy'))fail('WORLD_RESTART_REQUIRES_IDLE_WORKERS');
  process.kill(status.world_pid);const pid=await launch(resolve(import.meta.dirname,'neutral.mjs'),[],'neutral');
  console.log(JSON.stringify({stage:'neutral-restarting',world_pid:pid}));
}else if(mode==='--status') {
  const c=JSON.parse(await readFile(resolve(worldRoot,'supervisor/control.json'),'utf8'));
  const status=await get('http://127.0.0.1:'+c.port,'/v1/supervisor',await secret(marker.human_token_ref));console.log(JSON.stringify(status,null,2));
}else if(mode==='--restart-life') {
  const lifeId=process.argv[3],m=worldSnapshot().lives[lifeId];if(!m)fail('EXPLICIT_EXISTING_LIFE_REQUIRED');
  if(m.kind!=='legacy')assertLifeExecutionEnabled(lifeId);
  const status=await workerRequest(lifeId,'/status');if(status.busy||status.sessions?.some(s=>s.busy))fail('WORKER_BUSY');
  if(m.kind==='legacy') {
    const config=JSON.parse(await readFile(resolve(migrationRoot,'runtime/time_host/production-config.json'),'utf8'));
    const live=await pipeCommand(config,'status');if(live.hostPid!==status.pid||status.sessionId!==m.authoritySessionId)fail('LEGACY_PROCESS_IDENTITY_MISMATCH');
    await pipeCommand(config,'stop');
    await waitForExit(live.supervisorPid);await waitForExit(status.pid);
    const launcher=await launch(resolve(migrationRoot,'runtime/time_host/supervisor.mjs'),[resolve(migrationRoot,'runtime/time_host/production-config.json')],'legacy-supervisor',m.deployment.workspace);
    console.log(JSON.stringify({stage:'worker-restarting',life_id:lifeId,launcher_pid:launcher,authority_session_id:m.authoritySessionId}));
  }else {
    await workerRequest(lifeId,'/stop',{method:'POST',input:{}});
    await waitForExit(status.pid);
    const pid=await launch(resolve(import.meta.dirname,'life-worker.mjs'),[lifeId,String(workerLayout(lifeId).port)],'worker-'+lifeId);console.log(JSON.stringify({stage:'worker-restarting',life_id:lifeId,pid}));
  }
}else if(mode==='--start-life') {
  const lifeId=process.argv[3],m=worldSnapshot().lives[lifeId];if(!m)fail('EXPLICIT_EXISTING_LIFE_REQUIRED');
  if(m.kind!=='legacy')assertLifeExecutionEnabled(lifeId);
  try{await workerRequest(lifeId,'/status');fail('WORKER_ALREADY_RUNNING');}catch(error){if(error.code==='WORKER_ALREADY_RUNNING')throw error;}
  if(m.kind==='legacy') {
    const config=JSON.parse(await readFile(resolve(migrationRoot,'runtime/time_host/production-config.json'),'utf8'));
    try{await pipeCommand(config,'status');fail('LEGACY_SUPERVISOR_ALREADY_RUNNING');}catch(error){if(error.code==='LEGACY_SUPERVISOR_ALREADY_RUNNING')throw error;}
    const pid=await launch(resolve(migrationRoot,'runtime/time_host/supervisor.mjs'),[resolve(migrationRoot,'runtime/time_host/production-config.json')],'legacy-supervisor',m.deployment.workspace);
    console.log(JSON.stringify({life_id:lifeId,launcher_pid:pid}));process.exit(0);
  }
  const pid=await launch(resolve(import.meta.dirname,'life-worker.mjs'),[lifeId,String(workerLayout(lifeId).port)],'worker-'+lifeId);console.log(JSON.stringify({life_id:lifeId,pid}));
}else fail('SUPERVISOR_OPERATION_REQUIRED');
