import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,fail,freeze} from '../contracts.mjs';

const normalized=path=>path.replaceAll('\\','/');
const processAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='ESRCH'?false:true;}};

// Only the neutral Host owns this journal. Worker credentials and file bodies
// never enter it. Active grants survive disposal/restart while their PID lives.
export class SharedFileResources {
  #registry; #root; #alive; #leases=new Map(); #queues=new Map(); #lock; #closed=false; #generation=0; #waitForConflicts;
  constructor({registry,root,isAlive=processAlive,waitForConflicts=false}) {
    if(!registry?.assertTarget||typeof isAlive!=='function')fail('RESOURCE_HOST_BINDING_REQUIRED');
    this.#registry=registry;this.#root=canonical(root);this.#alive=isAlive;this.#waitForConflicts=waitForConflicts;registry.addControlRoot(this.#root);mkdirSync(this.#root,{recursive:true});
    try {
      this.#lock=new DatabaseSync(resolve(this.#root,'writer-lock.sqlite'));this.#lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    }catch(error){if(this.#lock?.isOpen)this.#lock.close();this.#lock=null;
      if(error.code==='ERR_SQLITE_ERROR'&&/locked|busy/.test(error.message))fail('RESOURCE_WRITER_ALREADY_ACTIVE');throw error;}
    try {
      const file=resolve(this.#root,'leases.json');
      if(existsSync(file)) {
        const state=JSON.parse(readFileSync(file,'utf8'));
        if(state.schema_version!==1||!Number.isSafeInteger(state.generation)||state.generation<0||!Array.isArray(state.leases))fail('RESOURCE_JOURNAL_INVALID');
        this.#generation=state.generation;
        const keys=new Set();
        for(const row of state.leases) {
          if(!row||Object.keys(row).some(field=>!['lease_id','life_id','session_id','key','pid','acquired_at'].includes(field))||typeof row.lease_id!=='string'||!row.lease_id||this.#leases.has(row.lease_id)||typeof row.key!=='string'||!isAbsolute(row.key)||
            normalized(resolve(row.key))!==row.key||keys.has(row.key)||!Number.isSafeInteger(row.pid)||row.pid<=0||typeof row.acquired_at!=='string')fail('RESOURCE_JOURNAL_INVALID');
          registry.assertTarget(row.life_id,row.session_id);keys.add(row.key);this.#leases.set(row.lease_id,freeze({...row}));
        }
      }
      this.reap();
    }catch(error){this.dispose();throw error;}
  }
  #open(){if(this.#closed)fail('RESOURCE_BROKER_CLOSED');}
  #key(key) {
    if(typeof key!=='string'||!isAbsolute(key))fail('RESOURCE_CANONICAL_PATH_REQUIRED');
    let actual;try{actual=normalized(canonical(key));}catch{fail('RESOURCE_CANONICAL_PATH_REQUIRED');}
    if(normalized(key)!==actual)fail('RESOURCE_CANONICAL_PATH_REQUIRED');return actual;
  }
  #persist(next) {
    this.#open();const file=resolve(this.#root,'leases.'+randomUUID()+'.tmp'),fd=openSync(file,'wx');
    try{writeFileSync(fd,JSON.stringify({schema_version:1,generation:this.#generation+1,leases:[...next.values()]},null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(file,resolve(this.#root,'leases.json'));this.#leases=next;this.#generation++;
  }
  #held(key){return [...this.#leases.values()].some(row=>row.key===key);}
  #removeWaiter(waiter) {
    waiter.signal?.removeEventListener('abort',waiter.abort);
    const queue=this.#queues.get(waiter.key);if(!queue)return;
    const at=queue.indexOf(waiter);if(at!==-1)queue.splice(at,1);if(!queue.length)this.#queues.delete(waiter.key);
  }
  #drain(key) {
    if(this.#closed||this.#held(key))return;
    for(;;) {
      const waiter=this.#queues.get(key)?.[0];if(!waiter)return;this.#removeWaiter(waiter);
      try {
        waiter.signal?.throwIfAborted();this.#registry.assertTarget(waiter.lifeId,waiter.sessionId);
        if(this.#alive(waiter.pid)===false)fail('WORKER_HEALTH_REQUIRED');
        const row=freeze({lease_id:randomUUID(),life_id:waiter.lifeId,session_id:waiter.sessionId,key,pid:waiter.pid,acquired_at:new Date().toISOString()});
        const next=new Map(this.#leases);next.set(row.lease_id,row);this.#persist(next);
        waiter.accept({lease_id:row.lease_id});return;
      }catch(error){waiter.reject(error);}
    }
  }
  async acquire({lifeId,sessionId,key,pid,signal}) {
    this.#open();this.#registry.assertTarget(lifeId,sessionId);key=this.#key(key);
    if(!Number.isSafeInteger(pid)||pid<=0||this.#alive(pid)===false)fail('WORKER_HEALTH_REQUIRED');signal?.throwIfAborted();
    this.reap();
    const held=[...this.#leases.values()].filter(row=>row.key===key);
    if(!this.#waitForConflicts&&held.length)return freeze({conflict:{error:'FILE_BUSY',path:key,operation_started:false,
      holders:held.map(row=>({life_id:row.life_id,session_id:row.session_id,pid:row.pid,acquired_at:row.acquired_at})),
      next_action:'Do other work; read the current file again before a later edit. No automatic retry.'}});
    return new Promise((accept,reject)=>{
      const waiter={lifeId,sessionId,key,pid,signal,accept,reject};
      waiter.abort=()=>{this.#removeWaiter(waiter);reject(signal.reason??Error('RESOURCE_WAIT_CANCELLED'));this.#drain(key);};
      const queue=this.#queues.get(key)??[];queue.push(waiter);this.#queues.set(key,queue);
      signal?.addEventListener('abort',waiter.abort,{once:true});
      if(signal?.aborted)waiter.abort();else this.#drain(key);
    });
  }
  release({lifeId,sessionId,lease_id}) {
    this.#open();this.#registry.assertTarget(lifeId,sessionId);
    if(typeof lease_id!=='string'||!lease_id)fail('RESOURCE_LEASE_ID_REQUIRED');
    const row=this.#leases.get(lease_id);if(!row)return {already_released:true};
    if(row.life_id!==lifeId||row.session_id!==sessionId)fail('RESOURCE_LEASE_OWNER_MISMATCH');
    const next=new Map(this.#leases);next.delete(lease_id);this.#persist(next);this.#drain(row.key);return {released:true};
  }
  reap() {
    this.#open();const dead=[...this.#leases.values()].filter(row=>this.#alive(row.pid)===false);
    if(dead.length){const next=new Map(this.#leases);for(const row of dead)next.delete(row.lease_id);this.#persist(next);
      for(const key of new Set(dead.map(row=>row.key)))this.#drain(key);}
    return {reclaimed:dead.length};
  }
  snapshot() {
    this.#open();return freeze({coordination:'neutral-host-canonical-file',conflict_policy:this.#waitForConflicts?'wait':'return-immediately',generation:this.#generation,
      leases:[...this.#leases.values()].map(row=>({...row})),pending:[...this.#queues].map(([key,rows])=>({key,count:rows.length})),
      active_count:this.#leases.size,pending_count:[...this.#queues.values()].reduce((n,rows)=>n+rows.length,0)});
  }
  dispose() {
    if(this.#closed)return;this.#closed=true;
    for(const queue of [...this.#queues.values()])for(const waiter of [...queue]){this.#removeWaiter(waiter);try{fail('RESOURCE_BROKER_CLOSED');}catch(error){waiter.reject(error);}}
    if(this.#lock){this.#lock.exec('ROLLBACK');this.#lock.close();this.#lock=null;}
  }
}
