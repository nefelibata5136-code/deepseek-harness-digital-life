import {open,mkdir,readFile,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {watch} from 'node:fs';
import {BillingCache,cachePath,INTERVAL_MS,LIFE_IDS} from './cache.mjs?diagnostics=1';
import {requestPath} from './recovery.mjs';
import {ResidentBillingWorker} from './resident-worker.mjs';
export async function startProducer(ctx) {
  const symbol=Symbol.for('persona.officialBilling.producer');if(globalThis[symbol])return globalThis[symbol];
  const lock=resolve(dirname(cachePath),'producer.lock');await mkdir(dirname(lock),{recursive:true});
  try{const fd=await open(lock,'wx');await fd.writeFile(JSON.stringify({pid:process.pid}));await fd.close();}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    let previous;try{previous=JSON.parse(await readFile(lock,'utf8')).pid;}catch{throw Error('BILLING_PRODUCER_LOCK_INVALID');}
    let live=true;try{process.kill(previous,0);}catch(e){if(e.code==='ESRCH')live=false;}
    if(live)return {active:false,reason:'existing_producer'};
    await unlink(lock);return startProducer(ctx);
  }
  const worker=new ResidentBillingWorker();
  const cache=new BillingCache({query:()=>worker.query()});
  const refresh=()=>cache.refresh().catch(()=>{});
  let requestTimer;
  const watcher=watch(dirname(cachePath),(_event,name)=>{
    if(name!=='refresh-request.json')return;clearTimeout(requestTimer);
    requestTimer=setTimeout(async()=>{try{
      const request=JSON.parse(await readFile(requestPath,'utf8'));
      if(!LIFE_IDS.includes(request.life_id)||Date.now()-Date.parse(request.requested_at)>60000)return;
      const elapsed=Date.now()-Date.parse(cache.state.last_attempt_at??'');
      if(elapsed<30000||cache.pending)return;
      await refresh();
    }catch{}},100);
  });watcher.unref();
  let timer;
  const last=Date.parse(cache.state.last_attempt_at??'');
  const delay=Number.isFinite(last)?Math.max(0,INTERVAL_MS-(Date.now()-last)):0;
  const first=setTimeout(()=>{void refresh();timer=setInterval(refresh,INTERVAL_MS);timer.unref();},delay);first.unref();
  const state={active:true,cache,worker,interval_ms:INTERVAL_MS,stop:async()=>{watcher.close();clearTimeout(requestTimer);clearTimeout(first);clearInterval(timer);await cache.pending?.catch(()=>{});await worker.close();let p;try{p=JSON.parse(await readFile(lock,'utf8')).pid;}catch{}if(p===process.pid)await unlink(lock);delete globalThis[symbol];}};
  globalThis[symbol]=state;
  ctx.effect(()=>()=>state.stop(),'official billing background refresh');
  // Reuse a fresh disk cache after reload; never query for each conversation.
  return state;
}
