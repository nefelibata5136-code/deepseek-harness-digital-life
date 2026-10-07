import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {PrivateVaultStore} from '../../private-vault/store.mjs';
import {VaultError} from '../../private-vault/crypto.mjs';
import {canonical,fail} from '../contracts.mjs';

export function createVaultService({contexts}) {
  const stores=new Map(),inflight=new Set();let disposed=false;
  const keys={write:['namespace','path','value'],read:['namespace','path'],delete:['namespace','path'],
    list:['namespace','prefix','offset','limit'],search:['namespace','prefix','offset','limit','query'],status:[]};
  async function storeFor(c) {
    if(disposed)fail('VAULT_SERVICE_CLOSED');
    const root=canonical(c.manifest.deployment.vault),key=c.lifeId+'@'+c.manifestRevision;
    if(!stores.has(key)) {
      const pending=(async()=>{
        const store=await new PrivateVaultStore(root).init();
        const lease=new DatabaseSync(resolve(root,'runtime-owner.sqlite'));
        try{lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}
        catch(error){lease.close();if(error.code==='ERR_SQLITE_ERROR')fail('VAULT_OWNER_ALREADY_ACTIVE');throw error;}
        return {store,lease,root};
      })();
      stores.set(key,pending);
      try{await pending;}catch(error){stores.delete(key);throw error;}
    }
    const item=await stores.get(key);if(item.root!==root)fail('VAULT_STALE_ROOT_BINDING');return item.store;
  }
  return {async execute(context,operation,args={}) {
    if(disposed)fail('VAULT_SERVICE_CLOSED');
    const c=contexts.require(context);
    if(c.role==='delegate')fail('VAULT_DELEGATE_DENIED');
    if(!Object.hasOwn(keys,operation)||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!keys[operation].includes(k)))fail('VAULT_ARGUMENT_SCOPE_INVALID');
    const run=(async()=>{
      const store=await storeFor(c);contexts.require(c);
      try{return await store[operation](structuredClone(args));}
      catch(error){return {ok:false,error:error instanceof VaultError?error.code:'VAULT_OPERATION_FAILED'};}
    })();
    inflight.add(run);try{return await run;}finally{inflight.delete(run);}
  },async dispose(){
    disposed=true;
    await Promise.allSettled([...inflight]);
    for(const pending of stores.values()){const {store,lease}=await pending;await store.queue;lease.exec('ROLLBACK');lease.close();}
    stores.clear();
  }};
}
