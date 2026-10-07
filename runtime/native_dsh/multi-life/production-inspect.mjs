import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {credentialOperation} from '../capabilities/isolation.mjs';
import {existsSync} from 'node:fs';

// Read-only public proof. Resolve channel credentials only in this Host-side
// process; never return token, private messages, Memory, Vault or thinking.
export async function inspectProduction() {
  const root=resolve(import.meta.dirname,'../../..');
  const marker=JSON.parse(await readFile(resolve(process.env.DL_WORLD_ROOT || resolve(root,'.local/world'), 'birth.json'),'utf8'));
  if(existsSync(resolve(process.env.DL_WORLD_ROOT || resolve(root,'.local/world'), 'supervisor/control.json'))) {
    const {worldRequest,workerRequest}=await import('./supervisor/client.mjs');
    const {worldSnapshot}=await import('./supervisor/deployment.mjs');
    const world=await worldRequest('/v1/supervisor'),workers=[];
    for(const m of Object.values(worldSnapshot().lives))try {
      const status=await workerRequest(m.lifeId,'/status');
      workers.push(m.kind==='legacy'?{life_id:m.lifeId,pid:status.pid,ready:status.ready,busy:status.busy,session_id:status.sessionId,
        boundary:status.ownerBoundary,metrics:status.multiLifeMetrics,communication:status.lifeCommunication}:{life_id:m.lifeId,...status});
    }catch(error){workers.push({life_id:m.lifeId,ready:false,error_code:error.code??error.name});}
    return {observed_at:new Date().toISOString(),topology:'neutral-world-with-independent-native-workers',world,workers,
      rooms:{human_new:marker.human_room_id,human_persona:marker.human_a_room_id,peer:marker.peer_room_id},os_strong_isolation:false};
  }
  const {value:token}=await credentialOperation('python','resolve',marker.human_token_ref);
  const get=async(path,port,secret)=>{
    const response=await fetch('http://127.0.0.1:'+port+path,{headers:{authorization:'Bearer '+secret},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('PUBLIC_INSPECT_CHANNEL_FAILED');return response.json();
  };
  const status=await get('/v1/status?life_id='+encodeURIComponent(marker.life_id),marker.port,token);
  const control=JSON.parse(await readFile(resolve(root,'runtime/native_dsh/host-state/.host-control.json'),'utf8'));
  const old=await get('/status',control.port,control.token);
  return {observed_at:new Date().toISOString(),life_id:marker.life_id,authority_session_id:marker.authority_session_id,
    new_worker:{pid:marker.pid,port:marker.port,stage:marker.stage,...status},
    persona_worker:{pid:old.pid,session_id:old.sessionId,busy:old.busy,active_session_ids:old.activeSessionIds,
      file_operation_session_ids:old.fileOperationSessionIds,communication:old.lifeCommunication??null},
    rooms:{human_new:marker.human_room_id,human_persona:marker.human_a_room_id??null,peer:marker.peer_room_id},os_strong_isolation:false};
}
if(process.argv[1]?.endsWith('production-inspect.mjs')) {
  try{console.log(JSON.stringify(await inspectProduction(),null,2));}catch{console.error('READ_ONLY_PRODUCTION_INSPECTION_UNAVAILABLE');process.exitCode=1;}
}
