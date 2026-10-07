import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setupWorld,worldRoot} from './setup-world.mjs';
import {root} from './configure.mjs';
const settings=await setupWorld(),[action,slot]=process.argv.slice(2);
const selected=slot?settings.lives.filter(l=>l.slot===slot):settings.lives;
if(slot&&selected.length!==1)throw Error('EXPLICIT_EXISTING_LIFE_SLOT_REQUIRED');
const path=resolve(worldRoot,'supervisor/deployments.json');
const deployments=JSON.parse(await readFile(path,'utf8'));
async function status(l){try{const response=await fetch('http://127.0.0.1:'+deployments.workers[l.lifeId].port+'/status',{headers:{authorization:'Bearer '+settings.tokens.workers[l.lifeId]},signal:AbortSignal.timeout(2000)});if(!response.ok)throw Error('AUTHENTICATED_WORKER_STATUS_REQUIRED');const r=await response.json();if(r.life_id!==l.lifeId)throw Error('WORKER_OWNER_MISMATCH');return r;}catch(e){if(['WORKER_OWNER_MISMATCH','AUTHENTICATED_WORKER_STATUS_REQUIRED'].includes(e.message))throw e;if(e.cause?.code==='ECONNREFUSED')return null;throw Error('WORKER_STATE_UNKNOWN_RECONCILE_BEFORE_START');}}
if(action==='status'){console.log(JSON.stringify({lives:await Promise.all(selected.map(async l=>({slot:l.slot,life_id:l.lifeId,execution_disabled:deployments.workers[l.lifeId].execution_disabled,...await status(l)??{state:'offline'}})))}));}
else if(action==='start'){
  for(const l of selected){
    if(await status(l)){console.log(JSON.stringify({slot:l.slot,state:'already-online'}));continue;}
    if(!(await readFile(l.core,'utf8')).trim())throw Error('EXPLICIT_AUTHORED_CORE_REQUIRED');
    for(const owner of settings.lives)if(!process.env[owner.keyEnv]||process.env[owner.keyEnv].includes('REPLACE_'))throw Error('ALL_CONFIGURED_PROVIDER_KEYS_REQUIRED_FOR_OUTPUT_SCREENING');
    deployments.workers[l.lifeId].execution_disabled=false;
    await writeFile(path,JSON.stringify(deployments,null,2)+'\n');
    const logs=resolve(worldRoot,'workers',l.lifeId,'logs');await mkdir(logs,{recursive:true});
    const out=await open(resolve(logs,'worker.stdout.log'),'a'),err=await open(resolve(logs,'worker.stderr.log'),'a');
    const child=spawn(process.execPath,[resolve(root,'runtime/native_dsh/multi-life/supervisor/life-worker.mjs'),l.lifeId,String(deployments.workers[l.lifeId].port)],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out.fd,err.fd],env:{...process.env,DL_WORLD_ROOT:worldRoot,DL_DATA:resolve(root,'.local'),DSH_TELEMETRY_DISABLED:'1'}});
    await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});child.unref();await out.close();await err.close();
    const deadline=Date.now()+180000;let ready;
    while(Date.now()<deadline){ready=await status(l);if(ready?.ready)break;await new Promise(r=>setTimeout(r,500));}
    if(!ready?.ready)throw Error('WORKER_READY_TIMEOUT');console.log(JSON.stringify({slot:l.slot,state:'online',pid:ready.pid}));
  }
}else if(action==='stop'){
  for(const l of selected){const live=await status(l);deployments.workers[l.lifeId].execution_disabled=true;await writeFile(path,JSON.stringify(deployments,null,2)+'\n');
    if(!live){console.log(JSON.stringify({slot:l.slot,state:'already-offline'}));continue;}
    const response=await fetch('http://127.0.0.1:'+deployments.workers[l.lifeId].port+'/stop',{method:'POST',headers:{authorization:'Bearer '+settings.tokens.workers[l.lifeId],'content-type':'application/json'},body:'{}'});
    if(!response.ok){const error=await response.json();throw Error(error.error||'WORKER_STOP_FAILED');}
    console.log(JSON.stringify({slot:l.slot,state:'stopping'}));
  }
}else throw Error('Use life-control.mjs status|start|stop [slot]');
