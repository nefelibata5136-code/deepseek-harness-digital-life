import {freeze,fail} from '../contracts.mjs';

// Each life owns its non-delegate capacity. Only the elastic shared pool is
// scheduled across lives; a busy life or its children cannot borrow another
// life's reserve. Host policy, not a model tool, controls these limits.
export class FairAdmission {
  #owners=new Map();#sharedActive=0;#lastSharedLife=null;#pumping=false;#disposed=false;
  constructor({registry,contexts,sharedSlots=2,reservedPerLife=1,maxDelegatePerLife=2}) {
    if(typeof registry?.list!=='function'||typeof contexts?.require!=='function'||contexts.registry!==registry)fail('FAIR_TRUSTED_REGISTRY_REQUIRED');
    if(!Number.isSafeInteger(sharedSlots)||sharedSlots<0||!Number.isSafeInteger(reservedPerLife)||reservedPerLife<1||
      !Number.isSafeInteger(maxDelegatePerLife)||maxDelegatePerLife<0)fail('FAIR_POLICY_INVALID');
    Object.defineProperties(this,{registry:{value:registry},contexts:{value:contexts},policy:{enumerable:true,value:
      freeze({shared_slots:sharedSlots,reserved_per_life:reservedPerLife,max_delegate_per_life:maxDelegatePerLife,
        shared_order:'life_round_robin_non_delegate_first',active_cancellation:'release_on_operation_finally'})}});
    this.#syncOwners();
  }
  #syncOwners() {
    const lives=this.registry.list();
    for(const {lifeId} of lives)if(!this.#owners.has(lifeId))this.#owners.set(lifeId,{life_id:lifeId,reserved_active:0,shared_active:0,
      delegate_active:0,admitted_total:0,released_total:0,cancelled_total:0,rejected_total:0,core:[],delegates:[]});
    return lives.map(m=>m.lifeId);
  }
  #authorize(context) {
    const c=this.contexts.require(context);
    if(!this.#syncOwners().includes(c.lifeId))fail('FAIR_UNKNOWN_LIFE');
    if(!['authority','activity','delegate'].includes(c.role))fail('FAIR_CONTEXT_ROLE_INVALID');
    return c;
  }
  async acquire(context,{signal}={}) {
    if(this.#disposed)fail('FAIR_ADMISSION_DISPOSED');
    const c=this.#authorize(context);signal?.throwIfAborted();
    return new Promise((accept,reject)=>{
      const owner=this.#owners.get(c.lifeId),queue=c.role==='delegate'?owner.delegates:owner.core;
      const request={context:c,owner,queue,signal,accept,reject,state:'queued',pool:null,abort:null};
      request.abort=()=>{if(request.state==='queued'){this.#reject(request,signal.reason,true);this.#pump();}};
      signal?.addEventListener('abort',request.abort,{once:true});queue.push(request);
      if(signal?.aborted)request.abort();else this.#pump();
    });
  }
  #detach(request) {request.signal?.removeEventListener('abort',request.abort);}
  #reject(request,error,cancelled=false) {
    if(request.state!=='queued')return;
    request.state='rejected';this.#detach(request);
    const index=request.queue.indexOf(request);if(index>=0)request.queue.splice(index,1);
    request.owner[cancelled?'cancelled_total':'rejected_total']++;request.reject(error);
  }
  #prune(queue,liveIds) {
    for(const request of [...queue]) {
      if(request.signal?.aborted){this.#reject(request,request.signal.reason,true);continue;}
      try {
        this.contexts.require(request.context);
        if(!liveIds.has(request.context.lifeId))fail('FAIR_UNKNOWN_LIFE');
      }catch(error){this.#reject(request,error);}
    }
  }
  #grant(request,pool) {
    request.queue.splice(request.queue.indexOf(request),1);this.#detach(request);request.state='active';request.pool=pool;
    const owner=request.owner;owner.admitted_total++;
    if(pool==='reserved')owner.reserved_active++;else{owner.shared_active++;this.#sharedActive++;}
    if(request.context.role==='delegate')owner.delegate_active++;
    // Active cancellation belongs to the actual operation's signal. Holding
    // capacity through its finally prevents overbooking a stream still closing.
    request.accept(Object.freeze({release:()=>{
      if(request.state!=='active')return;request.state='released';owner.released_total++;
      if(pool==='reserved')owner.reserved_active--;else{owner.shared_active--;this.#sharedActive--;}
      if(request.context.role==='delegate')owner.delegate_active--;
      this.#pump();
    }}));
  }
  #sharedCandidate(lifeIds,kind) {
    const start=(lifeIds.indexOf(this.#lastSharedLife)+1)%lifeIds.length;
    for(let offset=0;offset<lifeIds.length;offset++) {
      const lifeId=lifeIds[(start+offset)%lifeIds.length],owner=this.#owners.get(lifeId);
      if(kind==='delegates'&&owner.delegate_active>=this.policy.max_delegate_per_life)continue;
      if(owner[kind].length){this.#lastSharedLife=lifeId;return owner[kind][0];}
    }
  }
  #pump() {
    if(this.#pumping||this.#disposed)return;this.#pumping=true;
    try {
      const lifeIds=this.#syncOwners(),liveIds=new Set(lifeIds);
      for(const owner of this.#owners.values()){this.#prune(owner.core,liveIds);this.#prune(owner.delegates,liveIds);}
      for(const lifeId of lifeIds) {
        const owner=this.#owners.get(lifeId);
        while(owner.core.length&&owner.reserved_active<this.policy.reserved_per_life)this.#grant(owner.core[0],'reserved');
      }
      while(lifeIds.length&&this.#sharedActive<this.policy.shared_slots) {
        const candidate=this.#sharedCandidate(lifeIds,'core')??this.#sharedCandidate(lifeIds,'delegates');
        if(!candidate)break;this.#grant(candidate,'shared');
      }
    }catch(error){for(const owner of this.#owners.values())for(const request of [...owner.core,...owner.delegates])this.#reject(request,error);}
    finally{this.#pumping=false;}
  }
  async withLease(context,signal,operation) {
    if(typeof operation!=='function')fail('FAIR_OPERATION_REQUIRED');
    const lease=await this.acquire(context,{signal});
    try{signal?.throwIfAborted();this.#authorize(context);return await operation();}
    finally{lease.release();}
  }
  // With an authentic context, report only that life's counters. The Host may
  // omit context to inspect all owners; shared aggregate capacity is public.
  snapshot(context) {
    const selected=context===undefined?null:this.#authorize(context).lifeId,lifeIds=this.#syncOwners();
    const owners=lifeIds.filter(id=>selected===null||id===selected).map(id=>{
      const {core,delegates,...counts}=this.#owners.get(id);
      return {...counts,non_delegate_queued:core.length,delegate_queued:delegates.length};
    });
    return freeze({schema_version:1,policy:{...this.policy},disposed:this.#disposed,shared_active:this.#sharedActive,owners});
  }
  // Close waiting admission, while held leases retain their capacity until the
  // stream/operation owner releases them. Disposal never aborts another life.
  dispose() {
    if(this.#disposed)return;this.#disposed=true;
    for(const owner of this.#owners.values())for(const request of [...owner.core,...owner.delegates]) {
      const error=new Error('FAIR_ADMISSION_DISPOSED');error.code='FAIR_ADMISSION_DISPOSED';this.#reject(request,error);
    }
  }
}
