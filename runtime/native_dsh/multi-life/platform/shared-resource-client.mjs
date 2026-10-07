import {canonical,fail} from '../contracts.mjs';

// rpc is a Host-only, life-bound control transport. Neither its bearer nor this
// client is a model tool. The Supervisor derives life from authenticated worker.
export function createSharedResourceClient({rpc,lifeId,cleanupTimeoutMs=15000}) {
  if(typeof rpc!=='function'||!/^life-[a-f0-9-]{36}$/.test(lifeId)||!Number.isSafeInteger(cleanupTimeoutMs)||cleanupTimeoutMs<1)
    fail('SHARED_RESOURCE_HOST_BINDING_REQUIRED');
  let acquired=0,released=0;
  return {
    async acquire(context,{path,write=false,signal=new AbortController().signal}) {
      if(context?.lifeId!==lifeId||typeof context.sessionId!=='string'||!context.sessionId)fail('SHARED_RESOURCE_OWNER_MISMATCH');
      if(typeof write!=='boolean')fail('SHARED_RESOURCE_OPERATION_INVALID');
      signal.throwIfAborted();
      const key=canonical(path).replaceAll('\\','/');
      // A read is not an editing conflict. Keep ownership/path checks in the
      // native middleware; do not turn reads into cross-life write leases.
      if(!write)return {release:async()=>({released:true,read_only:true})};
      const result=await rpc('resourceAcquire',{sessionId:context.sessionId,key},signal);
      if(result?.conflict?.error==='FILE_BUSY') {
        const details=result.conflict;
        throw Object.assign(new Error(JSON.stringify(details)),{code:'FILE_BUSY',details});
      }
      if(typeof result?.lease_id!=='string'||!result.lease_id||result.lease_id.length>256)fail('SHARED_RESOURCE_LEASE_RESPONSE_INVALID');
      acquired++;let releasePromise;
      const lease={
        async release() {
          if(!releasePromise)releasePromise=(async()=>{
            // Caller cancellation must not prevent cleanup of a granted lease.
            const response=await rpc('resourceRelease',{sessionId:context.sessionId,lease_id:result.lease_id},AbortSignal.timeout(cleanupTimeoutMs));
            if(response?.released!==true&&response?.already_released!==true)fail('SHARED_RESOURCE_RELEASE_UNCONFIRMED');
            released++;return response;
          })();
          return releasePromise;
        }
      };
      if(signal.aborted){await lease.release();signal.throwIfAborted();}
      return lease;
    },
    status:()=>({life_id:lifeId,coordination:'neutral-host-canonical-path',acquired,released,active:acquired-released})
  };
}
