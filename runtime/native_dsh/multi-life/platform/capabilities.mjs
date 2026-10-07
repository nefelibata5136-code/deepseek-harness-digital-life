import {createBus} from '../../capabilities/bus.mjs';
import {fail} from '../contracts.mjs';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {AsyncLocalStorage} from 'node:async_hooks';

// Reuse the existing reviewed Plugin Manager/isolated worker implementation.
// Each owner has an instance/cache/profile and its own logical credential map.
export function createLifeCapabilityServices({contexts,bindings,credentialBackend,
  python=(process.env.DL_PYTHON || 'python'),fullAccessPolicy=()=>false}) {
  const buses=new Map(),calls=new AsyncLocalStorage();let disposed=false;
  const access=c=>c.role==='delegate'?'delegate-read':'authority';
  const within=(c,operation)=>calls.run(contexts.require(c),operation);
  async function busFor(context) {
    const c=contexts.require(context);if(disposed)fail('CAPABILITY_SERVICES_CLOSED');
    let row=buses.get(c.lifeId);
    if(!row) {
      row={};
      row.bus=createBus({root:c.manifest.deployment.capabilities,python,fullAccess:fullAccessPolicy(c)===true},{
        agentAccess:agent=>{const actual=contexts.forAgent(agent);return actual.lifeId===c.lifeId?access(actual):'denied';},
        runForAgent:(exec,operation)=>within(contexts.execution(exec.agent,{callId:exec.callId}),operation),
        credentialBackend:async(action,logicalRef,capabilityId)=>{
          const current=contexts.require(calls.getStore()),binding=bindings.credential(current,capabilityId,logicalRef);
          if(current.lifeId!==c.lifeId)fail('CAPABILITY_CREDENTIAL_OWNER_MISMATCH');
          if(typeof credentialBackend!=='function')fail('CAPABILITY_CREDENTIAL_BACKEND_REQUIRED');
          if(!['describe','resolve'].includes(action))fail('CAPABILITY_CREDENTIAL_OPERATION_DENIED');
          return credentialBackend(current,binding,action);
        },
      });
      row.ready=row.bus.init();buses.set(c.lifeId,row);
    }
    await row.ready;contexts.require(c);return row.bus;
  }
  return {
    list:c=>within(c,async()=> (await busFor(c)).list(access(c))),
    search:(c,args,agent)=>within(c,async()=>{if(contexts.forAgent(agent).sessionId!==c.sessionId)fail('CAPABILITY_SCOPE_OWNER_MISMATCH');return (await busFor(c)).search(args,agent.ctx,access(c));}),
    manage:(c,args)=>within(c,async()=>{if(c.role==='delegate')fail('CAPABILITY_DELEGATE_READ_ONLY');return (await busFor(c)).manage(args);}),
    call:(c,{capability,name,args,callId,signal})=>within(c,async()=> (await busFor(c)).call(capability,name,args,callId,signal,access(c))),
    async dispose(){disposed=true;await Promise.allSettled([...buses.values()].map(async row=>{await row.ready;await row.bus.dispose();}));buses.clear();},
  };
}
export function mountLifeCapabilities(host,options={}) {
  const {ctx,contexts}=host,services=createLifeCapabilityServices({contexts,bindings:host.privateServices.bindings,...options});
  const tools=[
    ['capability_list','List your own external capabilities and configured logical references.',{},(c,_args,exec)=>services.list(c)],
    ['capability_search','Discover your own capability worker tools into this native Session.',{query:{type:'string'},capability:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},(c,args,exec)=>services.search(c,args,exec.agent)],
    ['capability_manage','Manage your own capability profile. Shared runtime publication remains a separate operation.',{capability:{type:'string',required:true},action:{type:'string',required:true},kind:{type:'string'},description:{type:'string'},credentialRefs:{type:'array',items:{type:'string'}},target:{type:'string'},enabled:{type:'boolean'}},(c,args)=>services.manage(c,args)],
  ];
  for(const [name,description,parameters,run] of tools)ctx.tools.register(defineTool({name,description,parameters,output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    execute:(args,exec)=>run(contexts.execution(exec.agent,{callId:exec.callId}),args,exec)}));
  ctx.effect(()=>()=>services.dispose(),'owner capability worker lifecycle');return services;
}
