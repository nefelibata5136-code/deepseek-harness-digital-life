// Operator-owned narrow telemetry mount. No prompt, model invocation or restart.
import {fileURLToPath} from 'node:url';
const pid=Number(process.argv[2]);if(!Number.isSafeInteger(pid)||pid<=0)throw Error('EXACT_HOST_PID_REQUIRED');
const anchor=fileURLToPath(new URL('../../native_dsh/package.json',import.meta.url));
process._debugProcess(pid);let targets;
for(let i=0;i<30;i++){try{targets=await(await fetch('http://127.0.0.1:9229/json/list')).json();break;}catch{await new Promise(r=>setTimeout(r,100));}}
if(!targets)throw Error('CACHE_INSPECTOR_UNAVAILABLE');
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));let id=0;
function call(method,params){return new Promise((accept,reject)=>{
  const current=++id,listener=event=>{const value=JSON.parse(event.data);if(value.id!==current)return;socket.removeEventListener('message',listener);
    if(value.error||value.result?.exceptionDetails){const message=String(value.result?.exceptionDetails?.exception?.description??value.error?.message??'').split('\n')[0].replace(/[A-Za-z0-9_-]{32,}/g,'[REDACTED]');return reject(Error('BILLING_HOT_MOUNT_FAILED: '+message.slice(0,220)));}accept(value.result);};
  socket.addEventListener('message',listener);socket.send(JSON.stringify({id:current,method,params}));
});}
try {
  const identity=await call('Runtime.evaluate',{expression:'process.pid',returnByValue:true});if(identity.result.value!==pid)throw Error('CACHE_INSPECTOR_PROCESS_MISMATCH');
  const prototype=await call('Runtime.evaluate',{expression:`process.getBuiltinModule('module').createRequire(${JSON.stringify(anchor)})('@deepseek-ai/dsh-agent').AgentRegistry.prototype`});
  const objects=await call('Runtime.queryObjects',{prototypeObjectId:prototype.result.objectId});
  const mounted=await call('Runtime.callFunctionOn',{objectId:objects.objects.objectId,awaitPromise:true,returnByValue:true,functionDeclaration:`async function(){
    const registry=this.find(r=>r.ctx?.get('systemPrompt')&&r.ctx?.get('tools'));if(!registry)throw Error('NO_NATIVE_AGENT_REGISTRY');
    const ctx=registry.ctx;
    const {mountBillingRuntime,BillingCache}=process.getBuiltinModule('module').createRequire(${JSON.stringify(anchor)})(${JSON.stringify(fileURLToPath(new URL('./summary-entry.mjs',import.meta.url)))});
    const producer=globalThis[Symbol.for('persona.officialBilling.producer')];
    if(producer?.cache.pending)await producer.cache.pending;
    if(producer?.cache){producer.cache.refresh=BillingCache.prototype.refresh;producer.cache.read=BillingCache.prototype.read;}
    const service=await mountBillingRuntime(ctx);const rows=[];
    for(const agent of registry.list())try{
      for(const name of ['billing_status','billing_details','budget_status','cache_status']){const tool=ctx.get('tools').get(name,agent);if(tool)tool.isConcurrencySafe=()=>true;}
      const assembly=await ctx.get('systemPrompt').assemble({agent,scope:agent.ctx});
      const section=assembly.sections.find(s=>s.name==='billing:official-cost');
      const billing=service.forAgent(agent).billing;
      const old=ctx.get('tools').get('budget_status',agent);
      const value=await old.execute({}, {agent});
      rows.push({session_id:agent.session.id,billing,summary_chars:JSON.stringify({billing}).length,
        detail_tool_visible:!!ctx.get('tools').get('billing_details',agent),budget_alias_only_official:!!value.billing&&!JSON.stringify(value).includes('estimated'),
        static_section:section?.text,context_no_current_amount:!section?.text.includes('today_cost')});
    }catch(error){rows.push({error:String(error.message).slice(0,120)});}
    return {pid:process.pid,model_calls_initiated:0,producer_upgraded:!!producer?.cache,snapshots:rows};
  }`});
  console.log(JSON.stringify({pid:mounted.result.value.pid,producer_upgraded:mounted.result.value.producer_upgraded,sessions_checked:mounted.result.value.snapshots.length,all_context_static:mounted.result.value.snapshots.every(s=>s.context_no_current_amount===true),all_tools_official:mounted.result.value.snapshots.every(s=>s.budget_alias_only_official===true)}));
  await process.getBuiltinModule('fs/promises').writeFile(new URL('../../../reports/official-billing-summary-20261007/live-'+pid+'.json',import.meta.url),JSON.stringify(mounted.result.value,null,2));
}finally{
  await call('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('inspector').close(),300);true",returnByValue:true}).catch(()=>{});
  socket.close();await new Promise(r=>setTimeout(r,500));
}
