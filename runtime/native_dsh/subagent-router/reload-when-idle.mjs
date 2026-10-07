// Bounded task-local reload. Preserve active parent turns and background workers.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {workerRequest} from '../multi-life/supervisor/client.mjs';
import {loadSettings} from './router.mjs';
const id=process.argv[2];if(id!=='life-ca23d767-1b53-5adf-b85b-19bb81c72286')throw new Error('EXACT_LEGACY_OWNER_REQUIRED');
const settings=await loadSettings(),root=resolve(settings.protectedRoot,'subagent-audit'),deadline=Date.now()+600000;
console.log(JSON.stringify({waiting_for_idle:true,life_id:id}));
while(Date.now()<deadline){
 const status=await workerRequest(id,'/status');let childBusy=false;
 for(const directory of (await readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory())){
  for(const f of (await readdir(resolve(root,directory.name))).filter(f=>f.endsWith('.json'))){
   const row=JSON.parse(await readFile(resolve(root,directory.name,f),'utf8'));
   if(row.worker_pid===status.pid&&['queued','starting','running'].includes(row.status))childBusy=true;
  }
 }
 if(!status.busy&&!status.sessions?.some(s=>s.busy)&&!childBusy){
  try{
   const result=await promisify(execFile)(process.execPath,[resolve(import.meta.dirname,'../multi-life/supervisor/operate.mjs'),'--restart-life',id],{windowsHide:true,timeout:40000});
   console.log(result.stdout.trim());process.exit(0);
  }catch(e){if(!e.stderr?.includes('WORKER_BUSY'))throw new Error('EXACT_RELOAD_FAILED');}
 }
 await delay(3000);
}
throw new Error('WORKER_DID_NOT_BECOME_IDLE_NO_FORCED_RESTART');
