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
    if(value.error||value.result?.exceptionDetails)return reject(Error('CACHE_HOT_MOUNT_FAILED'));accept(value.result);};
  socket.addEventListener('message',listener);socket.send(JSON.stringify({id:current,method,params}));
});}
try {
  const identity=await call('Runtime.evaluate',{expression:'process.pid',returnByValue:true});if(identity.result.value!==pid)throw Error('CACHE_INSPECTOR_PROCESS_MISMATCH');
  const prototype=await call('Runtime.evaluate',{expression:`process.getBuiltinModule('module').createRequire(${JSON.stringify(anchor)})('@deepseek-ai/dsh-agent').AgentRegistry.prototype`});
  const objects=await call('Runtime.queryObjects',{prototypeObjectId:prototype.result.objectId});
  const mounted=await call('Runtime.callFunctionOn',{objectId:objects.objects.objectId,awaitPromise:true,returnByValue:true,functionDeclaration:`async function(){
    const registry=this.find(r=>r.ctx?.get('systemPrompt')&&r.ctx?.get('tools'));if(!registry)throw Error('NO_NATIVE_AGENT_REGISTRY');
    const {mountCacheHealth}=await import(${JSON.stringify(new URL('./cache-usage.mjs',import.meta.url).href)});
    const service=await mountCacheHealth(registry.ctx);const rows=[];
    for(const agent of registry.list())try{
      const value=await service.forAgent(agent);
      const tool=registry.ctx.tools.schemas(agent).some(t=>t.name==='cache_status');
      const assembly=await registry.ctx.systemPrompt.assemble({agent,scope:agent.ctx});
      rows.push({session_id:agent.session.id,life_id:value.life_id,error:value.error??null,cache_status_visible:tool,
        context_section_present:assembly.sections.some(s=>s.name==='billing:cache-health'),latest_request:value.latest_request??null,
        advisory:value.advisory??null,billing:registry.ctx.get('deepseekBillingStatus')?.forAgent(agent).billing??null});
    }catch{}
    return {pid:process.pid,model_calls_initiated:0,snapshots:rows};
  }`});
  console.log(JSON.stringify(mounted.result.value));
}finally{
  await call('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('inspector').close(),300);true",returnByValue:true}).catch(()=>{});
  socket.close();await new Promise(r=>setTimeout(r,500));
}
