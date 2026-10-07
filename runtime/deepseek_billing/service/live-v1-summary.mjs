// Fixed operator release seam: exact PID + Session, no prompt/model/producer call.
import {fileURLToPath} from 'node:url';
import {writeFile,mkdir} from 'node:fs/promises';
const pid=Number(process.argv[2]),sessionId=process.argv[3];
if(!Number.isSafeInteger(pid)||pid<=0||!/^[a-f0-9-]{36}$/i.test(sessionId??''))throw Error('EXACT_HOST_PID_AND_SESSION_REQUIRED');
const anchor=fileURLToPath(new URL('../../native_dsh/package.json',import.meta.url));
process._debugProcess(pid);
let targets;
for(let i=0;i<30;i++){
  try{targets=await(await fetch('http://127.0.0.1:9229/json/list')).json();break;}
  catch{await new Promise(resolve=>setTimeout(resolve,100));}
}
if(!targets?.[0]?.webSocketDebuggerUrl)throw Error('BILLING_INSPECTOR_UNAVAILABLE');
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
let id=0,verified=false;
function call(method,params){return new Promise((accept,reject)=>{
  const current=++id,listener=event=>{
    const response=JSON.parse(event.data);if(response.id!==current)return;
    socket.removeEventListener('message',listener);
    if(response.error||response.result?.exceptionDetails)return reject(Error('BILLING_FIXED_MOUNT_FAILED'));
    accept(response.result);
  };
  socket.addEventListener('message',listener);socket.send(JSON.stringify({id:current,method,params}));
});}
try{
  const identity=await call('Runtime.evaluate',{expression:'process.pid',returnByValue:true});
  if(identity.result.value!==pid)throw Error('BILLING_INSPECTOR_PROCESS_MISMATCH');verified=true;
  const prototype=await call('Runtime.evaluate',{expression:`process.getBuiltinModule('module').createRequire(${JSON.stringify(anchor)})('@deepseek-ai/dsh-agent').AgentRegistry.prototype`});
  const objects=await call('Runtime.queryObjects',{prototypeObjectId:prototype.result.objectId});
  const mounted=await call('Runtime.callFunctionOn',{objectId:objects.objects.objectId,awaitPromise:true,returnByValue:true,functionDeclaration:`async function(){
    const registry=this.find(item=>item.ctx?.get('tools')&&item.list().some(agent=>agent.session.id===${JSON.stringify(sessionId)}));
    if(!registry)throw Error('EXACT_NATIVE_SESSION_NOT_LOADED');
    const ctx=registry.ctx,agent=registry.list().find(agent=>agent.session.id===${JSON.stringify(sessionId)});
    const release=await import(${JSON.stringify(new URL('./summary-entry.mjs?official-v1=4',import.meta.url).href)});
    const service=await release.mountBillingRuntime(ctx);
    const definition=name=>ctx.get('tools').get(name,agent);
    const status=await definition('billing_status').execute({}, {agent});
    const details=await definition('billing_details').execute({period:'today',limit:1}, {agent});
    const alias=await definition('budget_status').execute({}, {agent});
    return {pid:process.pid,session_id:agent.session.id,summary_mounted:service.summaryMounted,model_calls_initiated:0,
      billing:status.billing,details_billing:details.billing,details_windows:details.windows,budget_billing:alias.billing,
      loaded_tools:['billing_status','billing_details','budget_status'].map(name=>({name,description:definition(name).description})),
      source:'operator read of actual loaded native tools; life acceptance still required'};
  }`});
  const result=mounted.result.value;
  const directory=new URL('../../../reports/v1-capabilities-20261007/billing/',import.meta.url);
  await mkdir(directory,{recursive:true});
  await writeFile(new URL('live-mount-'+pid+'.json',directory),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{
  if(verified)await call('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('inspector').close(),300);true",returnByValue:true}).catch(()=>{});
  socket.close();await new Promise(resolve=>setTimeout(resolve,500));
}
