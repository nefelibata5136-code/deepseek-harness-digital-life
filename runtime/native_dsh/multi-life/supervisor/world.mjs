import {LifeContexts} from '../context.mjs';
import {Conversations} from '../platform/conversations.mjs';
import {TaskStore} from '../platform/tasks.mjs';
import {PublicActivityStore} from '../platform/public-activity.mjs';
import {WorkerGateway} from '../platform/worker-gateway.mjs';
import {resolve} from 'node:path';
import {fail,freeze} from '../contracts.mjs';
import {SharedFileResources} from './resources.mjs';

// This process owns public durable state, never a native Agent or model loop.
// A worker exiting cannot dispose this world or open another life's Session.
export function createNeutralWorld({registry,platformRoot,workerBindings,now=()=>Date.now(),heartbeatTimeoutMs=20000,isAlive=pid=>{
  try{process.kill(pid,0);return true;}catch(error){return error.code==='ESRCH'?false:true;}
}}) {
  registry.addControlRoot(platformRoot);
  const contexts=new LifeContexts(registry),disposers=[];
  const tasks=new TaskStore({contexts,root:resolve(platformRoot,'tasks'),now});
  const rooms=new Conversations({contexts,root:resolve(platformRoot,'conversations'),tasks,now});
  const activity=new PublicActivityStore({contexts,root:resolve(platformRoot,'public-activity'),now});
  const workers=new Map();
  const sharedResources=new SharedFileResources({registry,root:resolve(platformRoot,'shared-resources'),isAlive});
  const resourceTimer=setInterval(()=>sharedResources.reap(),3000);resourceTimer.unref();
  const supervisor={
    workerPid:lifeId=>workers.get(lifeId)?.pid,
    heartbeat(lifeId,input) {
      registry.life(lifeId);
      if(!input||Object.keys(input).some(k=>!['pid','busy','session_ids','version','model_calls','model_wakes','reasoning_override'].includes(k))||
        !Number.isSafeInteger(input.pid)||input.pid<=0||typeof input.busy!=='boolean'||
        !Array.isArray(input.session_ids)||input.session_ids.some(id=>typeof id!=='string'))fail('WORKER_HEALTH_METADATA_INVALID');
      for(const id of input.session_ids)registry.assertTarget(lifeId,id);
      workers.set(lifeId,{life_id:lifeId,...input,observed_at:new Date(now()).toISOString(),observed_ms:now()});
      return {accepted:true,life_id:lifeId,world_pid:process.pid};
    },
    snapshot() {
      return freeze({ownership:'neutral-host',world_pid:process.pid,model_calls:0,
        workers:registry.list().map(m=>{
          const row=workers.get(m.lifeId),healthy=Boolean(row&&now()-row.observed_ms<=heartbeatTimeoutMs&&isAlive(row.pid));
          return {life_id:m.lifeId,display_name:m.displayName,pid:row?.pid??null,healthy,
            state:healthy?(row.busy?'busy':'idle'):'offline',last_heartbeat:row?.observed_at??null,
            model_calls:row?.model_calls??null,model_wakes:row?.model_wakes??null,reasoning_override:row?.reasoning_override??null};
        })});
    }
  };
  const runtime={workerLifeIds:new Set(),isLifeBusy:lifeId=>workers.get(lifeId)?.busy??false};
  const ctx={effect:fn=>{disposers.push(fn());}};
  const host={ctx,contexts,registry,rooms,taskStore:tasks,activity,runtime,supervisor,sharedResources};
  host.workerGateway=new WorkerGateway({registry,rooms,tasks,activity,workerBindings});
  host.dispose=async()=>{clearInterval(resourceTimer);sharedResources.dispose();try{for(const fn of disposers.reverse())await fn?.();}finally{rooms.close();registry.close();}};
  return host;
}
