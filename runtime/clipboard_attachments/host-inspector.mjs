import {writeFile} from 'node:fs/promises';
const pid=Number(process.argv[2]);if(!pid)throw Error('Specify Desktop transport Host PID');
process._debugProcess(pid);
let targets;for(let i=0;i<30;i++){try{targets=await(await fetch('http://127.0.0.1:9229/json/list')).json();break;}catch{await new Promise(done=>setTimeout(done,100));}}
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise(done=>socket.addEventListener('open',done,{once:true}));
let next=0;
function call(method,params){return new Promise((done,reject)=>{const id=++next;const listener=event=>{const r=JSON.parse(event.data);if(r.id!==id)return;socket.removeEventListener('message',listener);if(r.error||r.result?.exceptionDetails)reject(Error(JSON.stringify(r.error??r.result.exceptionDetails)));else done(r.result);};socket.addEventListener('message',listener);socket.send(JSON.stringify({id,method,params}));});}
try {
  const proto=await call('Runtime.evaluate',{expression:"process.getBuiltinModule('module').createRequire(process.argv[1])('@deepseek-ai/dsh-config-editor').ConfigEditor.prototype"});
  const contexts=await call('Runtime.queryObjects',{prototypeObjectId:proto.result.objectId});
  const result=await call('Runtime.callFunctionOn',{objectId:contexts.objects.objectId,functionDeclaration:`async function(){const context=this.find(c=>c.ownerContext)?.ownerContext;if(!context)throw Error('Desktop profile context missing');const req=process.getBuiltinModule('module').createRequire(process.argv[1]);const boot=req('@deepseek-ai/dsh-app-boot');const profile=context.profileContext;const before=[...context.loader.entries()].find(e=>e.options.id==='persona-desktop-usage');if(!before)throw Error('Adapter entry missing');const result={profile:profile.dir,beforeRevision:before.options.config?.revision,fiberState:before.fiber?.state};${process.argv.includes('--reload')?"const hmr=context.get('hmr');if(!hmr)throw Error('Desktop HMR unavailable');await hmr.runExclusive(async()=>{await before.update({disabled:true});await context.loader.await();await before.update({disabled:false});await context.loader.await();});result.reloaded=true;":""}const after=[...context.loader.entries()].find(e=>e.options.id==='persona-desktop-usage');result.afterRevision=after?.options.config?.revision;result.activeRoutes=[...after.fiber.ctx.connection.fetchRoutes.keys()].filter(p=>p.includes('persona'));return result;}`,awaitPromise:true,returnByValue:true});
  console.log(JSON.stringify(result.result.value));
  await writeFile(new URL('../../reports/clipboard_attachments/'+(process.argv.includes('--reload')?'transport-reload.json':'host-state.json'),import.meta.url),JSON.stringify(result.result.value,null,2));
} finally {
  await call('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('inspector').close(),300);true",returnByValue:true}).catch(()=>{});socket.close();
}
