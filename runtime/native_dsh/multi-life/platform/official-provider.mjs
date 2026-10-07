import {DeepSeekAdapter,resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {createKeyOutputGuard} from '../../../key_output_guard/guard.mjs';
import {fail} from '../contracts.mjs';
import {hasOfficialSearchContext,dispatchOfficialSearch} from './official-search.mjs';

const factories=new WeakSet();let installed,active,nativeTransport;
export const isOfficialProviderFactory=factory=>factories.has(factory);
export const isOfficialRawTransport=transport=>!!nativeTransport&&transport===nativeTransport;
export function captureOfficialRawTransport() {
  if(nativeTransport)return nativeTransport;
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'fetch');
  if(descriptor?.writable===false||descriptor?.configurable===false)fail('LEGACY_FROZEN_FETCH_REQUIRES_NEW_PROCESS');
  nativeTransport=globalThis.fetch.bind(globalThis);return nativeTransport;
}

// One permanent provider-domain broker, one active Host binding. No turn lock,
// current-life variable, environment credential, vendor patch or raw fallback
// for the protected domain. Old legacy's frozen fetch needs a new process.
function installBroker(host,transport) {
  if(active)fail('PROVIDER_BROKER_HOST_ALREADY_ACTIVE');
  if(!installed) {
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,'fetch');
    if(descriptor?.writable===false||descriptor?.configurable===false)fail('LEGACY_FROZEN_FETCH_REQUIRES_NEW_PROCESS');
    const raw=captureOfficialRawTransport();
    installed=async(input,init)=>{
      let url;try{url=new URL(typeof input==='string'||input instanceof URL?input:input.url);}catch{fail('INVALID_PROVIDER_URL');}
      if(url.hostname.toLowerCase().replace(/\.+$/,'')==='api.deepseek.com') {
        if(!active)fail('PROVIDER_BROKER_NO_ACTIVE_HOST');
		if(url.href!=='https://api.deepseek.com/anthropic/v1/messages')fail('UNPRICED_PROVIDER_ENDPOINT');
        if(hasOfficialSearchContext())return dispatchOfficialSearch(input,init,{transport:raw,
          rpc:(c,operation,args)=>active.host.budget.execute(c,operation,args),screenRequest:active.host.screenModelRequest});
        return active.transport(input,init);
      }
      return raw(input,init);
    };
    Object.defineProperty(globalThis,'fetch',{value:installed,writable:false,configurable:false});
  }else if(globalThis.fetch!==installed)fail('PROVIDER_BROKER_REPLACED');
  const token={};active={token,transport,host};
  host.ctx.effect(()=>()=>{if(active?.token===token)active=null;},'official provider broker ownership');
}

// Credential callback is a trusted Host-side operation on explicit account refs.
// Resolve every configured provider key before any Agent is created, so the
// existing output guard knows exact secrets before journaling or paid reserve.
export function createOfficialProviderFactory({credentialForAccount}) {
  if(typeof credentialForAccount!=='function')fail('EXPLICIT_PROVIDER_CREDENTIAL_BACKEND_REQUIRED');
  const factory=async({host,transport})=>{
    if(!host.budget||typeof host.modelExecution!=='function')fail('NATIVE_PROVIDER_BUDGET_REQUIRED');
    const keys=new Map();
    for(const manifest of host.contexts.registry.list()) {
      // An execution context cannot exist until native setup; account refs are
      // bound by the Host's budget composition, and selected again at resolveAuth.
      const accountRef=host.providerAccountBindings?.get(manifest.lifeId);
      if(typeof accountRef!=='string')fail('PROVIDER_ACCOUNT_BINDING_REQUIRED');
      if(!keys.has(accountRef)) {
        const key=await credentialForAccount(accountRef);
        if(typeof key!=='string'||key.length<16)fail('PROVIDER_CREDENTIAL_UNAVAILABLE');
        if([...keys.values()].includes(key))fail('DISTINCT_PROVIDER_ACCOUNTS_REQUIRE_DISTINCT_CREDENTIALS');
        keys.set(accountRef,key);
      }
    }
    const guard=createKeyOutputGuard({knownSecrets:[...keys.values()]});guard.mount(host.ctx);
    host.screenModelRequest=guard.wrapTransport(async()=>undefined);
    // Enable the adapter's per-request effort switch; preserve its prior off
    // default. A Host High override must reach the wire rather than being
    // rejected by an adapter configured as permanently thinking-disabled.
    const connection=resolveAdapterOptions({baseURL:'https://api.deepseek.com/anthropic',thinking:'enabled',reasoningEffort:'off',maxTokens:65536,
      models:[{id:'deepseek-flash',name:'DeepSeek Flash',contextWindow:1000000,maxTokens:65536,inputModalities:['text'],
        systemPromptUpdate:'in-history',toolUpdate:'addition-only'}],retryPolicy:{mode:'normal',maxRetries:0}});
    const noFiles=Object.freeze({ensureUploaded:()=>fail('MODEL_FILES_NOT_RELEASED'),invalidate:()=>fail('MODEL_FILES_NOT_RELEASED')});
    const adapter=new DeepSeekAdapter({options:()=>connection,providerName:'DeepSeek',
      resolveAuth:async()=>{
        const c=host.modelExecution(),accountRef=host.budget.accountRefFor(c),key=keys.get(accountRef);
        if(!key)fail('PROVIDER_ACCOUNT_BINDING_REQUIRED');return {headers:{authorization:'Bearer '+key}};
      },resolveUserId:()=>host.modelExecution().lifeId,
      resolveFiles:()=>noFiles,prepareExtensions:async()=>({fields:{},accept:async()=>{}})});
    installBroker(host,transport);return adapter;
  };
  factories.add(factory);return factory;
}
