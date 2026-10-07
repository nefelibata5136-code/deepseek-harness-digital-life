import {mkdir,open,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// Atomic file creation is shared by all owner workers. Live leases are never
// stolen on elapsed time: the owning router cancels and tears down its run.
export async function acquireSlot(root,limit,signal) {
  await mkdir(root,{recursive:true});
  while(true) {
    signal.throwIfAborted();
    for(let i=0;i<limit;i++) {
      const path=join(root,`slot-${i}.json`),id=randomUUID();
      let fd;
      try {
        fd=await open(path,'wx',0o600);
        await fd.writeFile(JSON.stringify({id,pid:process.pid,acquired_at:new Date().toISOString()}));
        await fd.close();fd=null;
        return {release:async()=>{
          let current;try{current=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}
          if(current.id!==id)throw new Error('SUBAGENT_SLOT_ID_CHANGED');
          await unlink(path);
        }};
      }catch(e) {
        await fd?.close();
        if(e.code!=='EEXIST')throw e;
        let row;try{row=JSON.parse(await readFile(path,'utf8'));}catch{continue;}
        if(!Number.isSafeInteger(row.pid)||row.pid<1)continue;
        try{process.kill(row.pid,0);}catch(error){
          if(error.code==='ESRCH') {
            // Serialize reclaimers; no second reclaimer may delete a newly
            // acquired live lease after checking the same dead row.
            let guard;const guardPath=path+'.reclaim';
            try{
              guard=await open(guardPath,'wx',0o600);
              if(JSON.parse(await readFile(path,'utf8')).id===row.id)await unlink(path);
            }catch(err){if(!['ENOENT','EEXIST'].includes(err.code))throw err;}
            finally{if(guard){await guard.close();await unlink(guardPath);}}
          }
        }
      }
    }
    await delay(200,undefined,{signal});
  }
}
