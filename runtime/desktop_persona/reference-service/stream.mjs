import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chatExecution} from './execution.mjs?revision=activity-social-3';
import {connectWorld} from '../../native_dsh/multi-life/supervisor/client.mjs';
import {worldSnapshot,workerLayout,migrationRoot,python} from '../../native_dsh/multi-life/supervisor/deployment.mjs';
import {credentialOperation} from '../../native_dsh/capabilities/isolation.mjs';
import {workerReference} from '../../native_dsh/multi-life/supervisor/neutral.mjs';

async function reader(lifeId){
 const m=worldSnapshot().lives[lifeId];let port,token;
 if(m.kind==='legacy'){const c=JSON.parse(await readFile(resolve(migrationRoot,'runtime/native_dsh/host-state/.host-control.json'),'utf8'));port=c.port;token=c.token;}
 else{port=workerLayout(lifeId).port;({value:token}=await credentialOperation(python,'resolve',workerReference(lifeId)));}
 return async()=>{const r=await fetch('http://127.0.0.1:'+(port+100)+'/snapshot',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(1500)});if(!r.ok)throw Error('DISPLAY_UNAVAILABLE');return r.json();};
}
export function scopedDisplay(value,agent){
 if(value.life_id!==agent.life_id||value.session_id!==agent.session_id)throw Error('DISPLAY_OWNER_MISMATCH');
 const a=value.active;
 const run=a&&agent.runs.find(r=>r.turn===a.turn&&r.status==='running');
 return {life_id:agent.life_id,session_id:agent.session_id,revision:value.revision,active:run?{...a,run_id:run.run_id}:null};
}
export async function chatStream(request){
 const url=new URL(request.url),world=await connectWorld();
 let execution=await chatExecution(url,world); // Human identity and Room read access.
 const readers=new Map(await Promise.all(execution.agents.map(async a=>[a.life_id,await reader(a.life_id)])));
 let cancelled=false,timer,previous='',checked=Date.now();const encoder=new TextEncoder();
 const stream=new ReadableStream({
  start(controller){
   const close=()=>{if(cancelled)return;cancelled=true;clearTimeout(timer);request.signal.removeEventListener('abort',close);try{controller.close();}catch{}};
   request.signal.addEventListener('abort',close,{once:true});
   const tick=async()=>{if(cancelled)return;
    try{
     if(Date.now()-checked>1500){execution=await chatExecution(url,world);checked=Date.now();}
     const agents=await Promise.all(execution.agents.map(async a=>{try{return scopedDisplay(await readers.get(a.life_id)(),a);}catch{return {life_id:a.life_id,session_id:a.session_id,unavailable:true};}}));
     const payload=JSON.stringify({room_id:execution.room_id,agents});
     if(!cancelled&&payload!==previous){controller.enqueue(encoder.encode('data: '+payload+'\n\n'));previous=payload;}
    }catch{close();return;} // Permission/read failure closes; never reuse stale scope.
    if(!cancelled)timer=setTimeout(tick,100);
   };void tick();
  },cancel(){cancelled=true;clearTimeout(timer);}
 });
 return new Response(stream,{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'}});
}
