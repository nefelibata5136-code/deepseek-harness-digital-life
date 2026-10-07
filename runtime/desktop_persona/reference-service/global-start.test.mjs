import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStarter,stopModernWorker} from './global-start.mjs';
const lives=[{lifeId:'A',displayName:'A'},{lifeId:'B',displayName:'B'}];
async function finish(starter){while(starter.job().state==='starting')await new Promise(r=>setTimeout(r,5));return starter.job();}
test('duplicate clicks share one operation, online worker stays running, disabled offline worker is enabled before launch',async()=>{
 const calls=[];let release;
 const ready=new Promise(r=>release=r);
 const s=createStarter({list:async()=>lives,status:async l=>l.lifeId==='A',enable:async l=>calls.push('enable '+l.lifeId),start:async l=>calls.push('start '+l.lifeId),wait:async()=>ready});
 const a=await s.restore(),b=await s.restore();assert.equal(a.id,b.id);release();
 const result=await finish(s);assert.equal(result.state,'completed');assert.deepEqual(calls,['enable A','enable B','start B']);assert.deepEqual(result.workers.map(w=>w.state),['already-online','online']);
});
test('one worker failure preserves the other result and is never reported as all started',async()=>{
 let released=false;
 const s=createStarter({list:async()=>lives,status:async()=>null,enable:async()=>{},start:async l=>{if(l.lifeId==='A')throw Error('WORKER_LAUNCH_FAILED');},wait:async()=>{},lock:async()=>async()=>{released=true;}});
 await s.restore();const result=await finish(s);assert.equal(result.state,'partial-failure');assert.deepEqual(result.workers.map(w=>w.state),['failed','online']);assert.equal(released,true);
});
test('world failure releases coordination and allows a later explicit retry',async()=>{
 let tries=0,releases=0;
 const s=createStarter({list:async()=>{if(++tries===1)throw Error('WORLD_READY_TIMEOUT');return [];},lock:async()=>async()=>{releases++;}});
 await s.restore();assert.equal((await finish(s)).state,'failed');await s.restore();assert.equal((await finish(s)).state,'completed');assert.equal(releases,2);
});
test('per-life start leaves the other stopped life untouched',async()=>{
 const called=[];
 const s=createStarter({list:async()=>lives,status:async()=>null,enable:async l=>called.push(l.lifeId),start:async()=>{},wait:async()=>{}});
 await s.restore('B');const job=await finish(s);assert.deepEqual(called,['B']);assert.equal(job.target_life_id,'B');
});
test('highest human stop interrupts the exact busy worker, never an unrelated PID',async()=>{
 const killed=[];const options={isAlive:()=>true,terminate:async p=>killed.push(p),request:async(id,path)=>{if(path==='/status')return {pid:123,life_id:id};throw Object.assign(Error('WORKER_BUSY'),{code:'WORKER_BUSY'});}};
 assert.equal((await stopModernWorker(lives[1],123,options)).interrupted_active_worker,true);assert.deepEqual(killed,[123]);
 await assert.rejects(stopModernWorker(lives[1],456,options),/WORKER_OWNER_MISMATCH/);assert.deepEqual(killed,[123]);
});
test('idle stop uses the native stop route and unauthorized responses never trigger termination',async()=>{
 let killed=0;
 const options={isAlive:()=>true,terminate:async()=>killed++,request:async(id,path)=>path==='/status'?{pid:123,life_id:id}:{stopping:true}};
 assert.equal((await stopModernWorker(lives[1],123,options)).interrupted_active_worker,false);
 await assert.rejects(stopModernWorker(lives[1],123,{...options,request:async()=>{throw Error('HOST_AUTHENTICATION_REQUIRED');}}));assert.equal(killed,0);
});
test('human stop can cancel readiness waiting for only the selected life',async()=>{
 const s=createStarter({list:async()=>lives,status:async()=>null,enable:async()=>{},start:async()=>{},wait:async(l,cancelled)=>{while(!cancelled())await new Promise(r=>setTimeout(r,5));throw Error('START_CANCELLED_BY_HUMAN');}});
 await s.restore('B');assert.equal(s.cancel('A'),false);assert.equal(s.cancel('B'),true);
 const result=await finish(s);assert.equal(result.workers[0].error_code,'START_CANCELLED_BY_HUMAN');
});
