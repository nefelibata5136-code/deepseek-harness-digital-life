import {freeze,fail,canonical,contains,privatePaths} from '../contracts.mjs';

export function rejectSecrets(value) {
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)) {
    if(/^(value|secret|password|cookie|token|apiKey|api_key|credentialsValue)$/i.test(key))fail('SECRET_VALUE_IN_BINDINGS');
    rejectSecrets(child);
  }
}
export function rejectForeignRoot(registry,lifeId,path) {
  for(const other of registry.list())if(other.lifeId!==lifeId)for(const privatePath of privatePaths(other)) {
    const root=canonical(privatePath);
    if(contains(root,path)||contains(path,root))fail('BINDING_FOREIGN_PRIVATE_ROOT');
  }
}

// Host-owned mapping. Model-facing arguments contain logical names, never targets.
export class OwnerBindings {
  #rows=new Map();
  constructor({contexts,bindings=new Map()}) {
    this.contexts=contexts;
    const identityOwners=new Map(),browserOwners=new Map(),browserReferences=new Map(),accountOwners=new Map();
    for(const [lifeId,input] of bindings) {
      contexts.registry.life(lifeId);
      const row=structuredClone(input);
      if(Object.keys(row).some(key=>!['accounts','credentials','browsers'].includes(key)))fail('OWNER_BINDING_INVALID');
      for(const [name,value] of Object.entries(row.accounts??{})) {
        rejectSecrets(value);
        if(!value?.accountRef||!['provider','identity'].includes(value.kind))fail('ACCOUNT_BINDING_INVALID');
        if(value.kind==='identity') {
          if(value.shared===true)fail('EXTERNAL_IDENTITY_CANNOT_BE_SHARED');
          const key=value.accountRef;
          if(identityOwners.has(key)&&identityOwners.get(key)!==lifeId)fail('EXTERNAL_IDENTITY_OWNER_COLLISION');
          identityOwners.set(key,lifeId);
        }
        const previous=accountOwners.get(value.accountRef);
        if(previous&&previous.lifeId!==lifeId&&!(previous.kind==='provider'&&previous.shared===true&&value.kind==='provider'&&value.shared===true))fail('ACCOUNT_OWNER_COLLISION');
        accountOwners.set(value.accountRef,{lifeId,...value});
      }
      for(const value of Object.values(row.browsers??{})) {
        rejectSecrets(value);
        if(!value?.bindingRef||!value.profileRoot)fail('BROWSER_BINDING_INVALID');
        value.profileRoot=canonical(value.profileRoot);
        rejectForeignRoot(contexts.registry,lifeId,value.profileRoot);
        if(browserOwners.has(value.profileRoot)&&browserOwners.get(value.profileRoot)!==lifeId)fail('BROWSER_OWNER_COLLISION');
        if(browserReferences.has(value.bindingRef)&&browserReferences.get(value.bindingRef)!==lifeId)fail('BROWSER_OWNER_COLLISION');
        browserOwners.set(value.profileRoot,lifeId);
        browserReferences.set(value.bindingRef,lifeId);
      }
      for(const refs of Object.values(row.credentials??{}))for(const value of Object.values(refs)) {
        rejectSecrets(value);
        if(!value?.hostRef||!value.accountName||!row.accounts?.[value.accountName])fail('CREDENTIAL_BINDING_INVALID');
        if(Object.keys(value).some(k=>/^(value|secret|password|cookie|token|apiKey)$/i.test(k)))fail('SECRET_VALUE_IN_BINDINGS');
      }
      this.#rows.set(lifeId,freeze(row));
    }
  }
  #owner(context){const c=this.contexts.require(context),row=this.#rows.get(c.lifeId);if(!row)fail('OWNER_BINDING_REQUIRED');return [c,row];}
  account(context,name) {
    const [c,row]=this.#owner(context),value=row.accounts?.[name];if(!value)fail('ACCOUNT_BINDING_REQUIRED');
    return freeze({lifeId:c.lifeId,name,...value});
  }
  credential(context,capabilityId,logicalRef) {
    const [c,row]=this.#owner(context),value=row.credentials?.[capabilityId]?.[logicalRef];
    if(!value)fail('CREDENTIAL_BINDING_REQUIRED');
    const account=this.account(c,value.accountName);
    return freeze({lifeId:c.lifeId,capabilityId,logicalRef,hostRef:value.hostRef,accountRef:account.accountRef,accountKind:account.kind});
  }
  browser(context,name='default') {
    const [c,row]=this.#owner(context),value=row.browsers?.[name];if(!value)fail('BROWSER_BINDING_REQUIRED');
    return freeze({lifeId:c.lifeId,name,...value});
  }
  capability(context,capabilityId) {
    const c=this.contexts.require(context);
    if(typeof capabilityId!=='string'||!/^[a-z][a-z0-9_-]{0,80}$/.test(capabilityId))fail('CAPABILITY_ID_INVALID');
    return freeze({lifeId:c.lifeId,capabilityId,instanceId:c.lifeId+'/'+capabilityId,root:c.manifest.deployment.capabilities});
  }
  attribution(context,{operation,accountName}={}) {
    const c=this.contexts.require(context);
    return freeze({lifeId:c.lifeId,sessionId:c.sessionId,runId:c.runId,requestId:c.requestId,callId:c.callId,
      category:c.costCategory,operation:operation??null,accountRef:accountName?this.account(c,accountName).accountRef:null});
  }
}
