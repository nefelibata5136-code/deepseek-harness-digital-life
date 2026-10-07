// Control-side narrow hot mount. No session prompt, restart, or model call.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const pid=Number(process.argv[2]),mode=process.argv[3];
const anchor=fileURLToPath(new URL('../../native_dsh/package.json',import.meta.url));
process._debugProcess(pid);let targets;
for(let i=0;i<30;i++){try{targets=await(await fetch('http://127.0.0.1:9229/json/list')).json();break;}catch{await new Promise(r=>setTimeout(r,100));}}
if(!targets)throw Error('BILLING_INSPECTOR_UNAVAILABLE');
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));let id=0;
function call(method,params){return new Promise((accept,reject)=>{const n=++id;const listener=event=>{const value=JSON.parse(event.data);if(value.id!==n)return;socket.removeEventListener('message',listener);if(value.error||value.result?.exceptionDetails){const text=String(value.result?.exceptionDetails?.exception?.description??value.error?.message??'').split('\n')[0].replace(/[A-Za-z0-9_-]{32,}/g,'[REDACTED]');console.log(JSON.stringify({method,error:text.slice(0,240)}));return reject(Error('BILLING_HOT_MOUNT_FAILED'));}accept(value.result);};socket.addEventListener('message',listener);socket.send(JSON.stringify({id:n,method,params}));});}
try {
 const identity=await call('Runtime.evaluate',{expression:'process.pid',returnByValue:true});
 if(identity.result.value!==pid)throw Error('BILLING_INSPECTOR_PROCESS_MISMATCH');
 const prototype=await call('Runtime.evaluate',{expression:mode==='neutral'?"process.getBuiltinModule('http').Server.prototype":`process.getBuiltinModule('module').createRequire(${mode==='desktop'?'process.argv[1]':JSON.stringify(anchor)})(${JSON.stringify(mode==='desktop'?'@deepseek-ai/dsh-config-editor':'@deepseek-ai/dsh-agent')}).${mode==='desktop'?'ConfigEditor':'AgentRegistry'}.prototype`});
 const objects=await call('Runtime.queryObjects',{prototypeObjectId:prototype.result.objectId});
 const runtimeUrl=new URL('./runtime.mjs',import.meta.url).href,apiUrl=new URL('./billing-api.mjs',import.meta.url).href,uiUrl=new URL('../ui/index.mjs?diagnostics=1',import.meta.url).href;
 const authFile=fileURLToPath(new URL('../../../reports/deepseek-billing-repair-20261007/.verify-auth.json',import.meta.url));
 await mkdir(new URL('../../../reports/deepseek-billing-repair-20261007/',import.meta.url),{recursive:true});
 const result=await call('Runtime.callFunctionOn',{objectId:objects.objects.objectId,awaitPromise:true,returnByValue:true,functionDeclaration:mode==='pause'?`async function(){const s=globalThis[Symbol.for('persona.officialBilling.producer')];if(s)await s.stop();return {pid:process.pid,billing_paused:true};}`:mode==='neutral'?`async function(){
  const require=process.getBuiltinModule('module').createRequire(${JSON.stringify(anchor)});
  const {PublicActivityStore}=require(${JSON.stringify(fileURLToPath(new URL('../../native_dsh/multi-life/platform/public-activity.mjs',import.meta.url)))});
  const {readBilling}=require(${JSON.stringify(fileURLToPath(new URL('./cache.mjs',import.meta.url)))});
  if(!PublicActivityStore.prototype.billingMounted){const old=PublicActivityStore.prototype.read;PublicActivityStore.prototype.read=function(lifeId){const value=old.call(this,lifeId);return {...value,billing:readBilling(lifeId)};};PublicActivityStore.prototype.billingMounted=true;}
  const {billingOverlay}=require(${JSON.stringify(fileURLToPath(new URL('./direct-overlay.mjs',import.meta.url)))});
  const server=this.find(s=>s.listening&&s.address()?.port===18842);if(!server)throw Error('DIRECT_CHAT_SERVER_NOT_FOUND');
  if(!server.billingMounted){const old=server.listeners('request')[0];server.removeListener('request',old);server.on('request',(req,res)=>{if(new URL(req.url,'http://127.0.0.1').pathname==='/chat'){const end=res.end;res.end=function(body,...rest){if(typeof body==='string'&&body.includes('</body>')&&!body.includes('id="billing"'))body=body.replace('</body>',billingOverlay+'</body>');return end.call(this,body,...rest);};}return old(req,res);});server.billingMounted=true;}
  return {pid:process.pid,mode:'neutral',status_billing:true,direct_ui:true};
 }`:mode==='desktop'?`async function(){
  const ctx=this.find(c=>c.ownerContext)?.ownerContext;if(!ctx)throw Error('NO_DESKTOP_CONTEXT');
  for(const [id,name] of [['deepseek-official-billing-api',${JSON.stringify(apiUrl)}],['deepseek-official-billing-ui',${JSON.stringify(uiUrl)}]]){
    await ctx.get('hmr').runExclusive(async()=>{if(![...ctx.loader.entries()].some(e=>e.options.id===id))await ctx.loader.create({id,name});else if(id==='deepseek-official-billing-api'){ctx.loader.remove(id);await ctx.loader.create({id,name});}else await ctx.loader.update(id,{name});await ctx.loader.await();});
  }
  await process.getBuiltinModule('fs/promises').writeFile(${JSON.stringify(authFile)},JSON.stringify({url:ctx.get('connection').authenticatedUrl('http://127.0.0.1:19387/')}));
  return {pid:process.pid,mode:'desktop',api_route:ctx.get('connection').fetchRoutes.has('/api/persona.billing'),plugins_added:true};
 }`:`async function(){
  const registry=this.find(r=>r.ctx?.get('systemPrompt')&&r.ctx?.get('tools'));if(!registry)throw Error('NO_NATIVE_AGENTS');
  const ctx=registry.ctx;const {apply}=process.getBuiltinModule('module').createRequire(${JSON.stringify(anchor)})(${JSON.stringify(fileURLToPath(new URL('./repair-entry.mjs',import.meta.url)))});
  process.getBuiltinModule('module').createRequire("./runtime/native_dsh/package.json")("./runtime/deepseek_billing/service/boundary.mjs").mountBillingBoundary(ctx);
  const service=await apply(ctx,{producer:${mode==='legacy'}});
  const snapshots=[];
  for(const agent of registry.list()){
    try{const value=service.forAgent(agent);const assembly=await ctx.get('systemPrompt').assemble({agent,scope:agent.ctx});
      const section=assembly.sections.find(s=>s.name==='billing:official-cost');
      const recoveryTool=ctx.get('tools').get('billing_recover',agent);const recovery=recoveryTool?await recoveryTool.execute({action:'status'},{agent}):null;
      const binding=(ctx.get('multiLifeContexts')??ctx.get('multiLifeOwnership')?.contexts).forAgent(agent);const guide=binding.manifest.deployment.workspace+'/development/billing-maintenance/README.md';
      let guideReadable=false;try{ctx.get('normalInterfaceOwnership')?.pathFor(binding.lifeId,guide);guideReadable=(await process.getBuiltinModule('fs/promises').readFile(guide,'utf8')).includes('billing_recover');}catch{}
      snapshots.push({recovery_tool_visible:!!recoveryTool,recovery_status_own_cost:recovery?.billing?.today_cost_cny===value.billing.today_cost_cny,guide_readable_under_owner_policy:guideReadable,session_id:agent.session.id,billing:value.billing,context_section_present:!!section,context_section:section?JSON.parse(section.text):null});
    }catch{}
  }
  let profileDenied=false;try{ctx.get('deepseekBillingBoundary').check(process.env.LOCALAPPDATA+'/PersonaHost/DeepSeekBillingBrowser/deepseek-billing-profile/Cookies');}catch(e){profileDenied=e.code==='TRUSTED_CONTROL_RESOURCE';}
  return {pid:process.pid,mode:${JSON.stringify(mode)},snapshots,profile_boundary_denied:profileDenied,producer:${mode==='legacy'}};
 }`});
 console.log(JSON.stringify({...result.result.value,snapshots:result.result.value.snapshots?.map(({context_section,...row})=>row)}));
 await writeFile(new URL('../../../reports/deepseek-billing-repair-20261007/'+mode+'-mount.json',import.meta.url),JSON.stringify(result.result.value,null,2));
}finally{await call('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('inspector').close(),300);true",returnByValue:true}).catch(()=>{});socket.close();await new Promise(r=>setTimeout(r,500));}
