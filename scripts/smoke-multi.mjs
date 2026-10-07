import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {root} from './configure.mjs';
const boundary=await mkdtemp(resolve(tmpdir(),'public-multi-smoke-')),worldRoot=resolve(boundary,'world');await mkdir(worldRoot);
const settings={schemaVersion:1,human:{id:'human:smoke',name:'Synthetic human'},port:0,operatorPort:0,workerPortBase:20844,
 python:process.env.DL_PYTHON||'python',residentEnabled:false,officialBillingProducer:false,memoryWorkspaceId:'UNCONFIGURED',worldRoot,
 peerRoomId:randomUUID(),lives:[],tokens:{human:randomBytes(32).toString('hex'),operator:randomBytes(32).toString('hex'),workers:{}}};
for(const slot of ['A','B']){
 const lifeId='life-'+randomUUID(),base=resolve(boundary,'lives',slot),workspace=resolve(base,'workspace');
 for(const name of ['workspace','state','memory','vault','recovery','capabilities','attachments','versions','workspace/.dsh/skills'])await mkdir(resolve(base,name),{recursive:true});
 const core=resolve(workspace,'core.md');await writeFile(core,'PUBLIC SMOKE CORE '+slot+'\n');await writeFile(resolve(workspace,'AGENTS.md'),'Synthetic isolated workspace.\n');
 const l={slot,name:'Synthetic '+slot,lifeId,base,workspace,core,authoritySessionId:randomUUID(),humanRoomId:randomUUID(),keyEnv:'DL_DEEPSEEK_KEY_'+slot};settings.lives.push(l);settings.tokens.workers[lifeId]=randomBytes(32).toString('hex');
}
await writeFile(resolve(worldRoot,'settings.json'),JSON.stringify(settings,null,2)+'\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/API.?KEY|SECRET|TOKEN|PASSWORD|AUTH|COOKIE/i.test(k)));
Object.assign(env,{DL_WORLD_ROOT:worldRoot,DL_DATA:boundary,DSH_TELEMETRY_DISABLED:'1',DL_OFFLINE_SMOKE:'1',DL_DEEPSEEK_KEY_A:'SYNTHETIC-SMOKE-PROVIDER-A-1234567890',DL_DEEPSEEK_KEY_B:'SYNTHETIC-SMOKE-PROVIDER-B-1234567890'});
const children=[],logs=[];
function launch(file,args=[],extra={}){const child=spawn(process.execPath,[resolve(root,file),...args],{cwd:root,windowsHide:true,env:{...env,...extra},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs.push(b.toString()));child.stderr.on('data',b=>logs.push(b.toString()));children.push(child);return child;}
async function poll(fn,ms=30000){const deadline=Date.now()+ms;let last;while(Date.now()<deadline){try{const r=await fn();if(r)return r;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}throw Error('SMOKE_TIMEOUT '+(last?.message??''));}
let result;
try{
 launch('scripts/world.mjs');
 const control=await poll(async()=>JSON.parse(await readFile(resolve(worldRoot,'supervisor/control.json'),'utf8')));
 const request=async(path,body)=>{const response=await fetch('http://127.0.0.1:'+control.port+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+settings.tokens.human,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(response.status,200);return response.json();};
 const before=await request('/v1/supervisor');assert.equal(before.model_calls,0);assert(before.workers.every(w=>!w.healthy));
 let deployments=JSON.parse(await readFile(resolve(worldRoot,'supervisor/deployments.json'),'utf8'));for(const l of settings.lives)deployments.workers[l.lifeId].execution_disabled=false;await writeFile(resolve(worldRoot,'supervisor/deployments.json'),JSON.stringify(deployments));
 for(const l of settings.lives){const wire=resolve(boundary,'wire-'+l.slot+'.jsonl');launch('runtime/native_dsh/multi-life/supervisor/life-worker.mjs',[l.lifeId,String(deployments.workers[l.lifeId].port)],{NODE_OPTIONS:'--import='+pathToFileURL(resolve(root,'scripts/offline-transport.mjs')).href,DL_SMOKE_WIRE:wire});}
 await poll(async()=>{const view=await request('/v1/supervisor');return view.workers.every(w=>w.healthy)&&view;},60000);
 const page=await fetch('http://127.0.0.1:'+control.port+'/chat?life_id='+settings.lives[1].lifeId);assert.equal(page.status,200);assert((await page.text()).includes(settings.lives[1].humanRoomId));
 for(const l of settings.lives){const sent=await request('/v1/rooms/'+l.humanRoomId+'/messages',{body:'Synthetic message '+l.slot,message_id:randomUUID()});assert.equal(sent.state,'saved');}
 for(const l of settings.lives)await poll(async()=>{try{return (await readFile(resolve(boundary,'wire-'+l.slot+'.jsonl'),'utf8')).trim();}catch{return null;}},30000);
 const a=await request('/v1/rooms/'+settings.lives[0].humanRoomId+'/messages');assert(a.messages.every(m=>!m.body.includes('message B')));
 const b=await request('/v1/rooms/'+settings.lives[1].humanRoomId+'/messages');assert(b.messages.every(m=>!m.body.includes('message A')));
 for(const l of settings.lives){const wire=JSON.parse((await readFile(resolve(boundary,'wire-'+l.slot+'.jsonl'),'utf8')).trim().split('\n')[0]);assert.equal(wire.core_present,true);}
 const worker=async(l,path,method='GET')=>{const response=await fetch('http://127.0.0.1:'+deployments.workers[l.lifeId].port+path,{method,headers:{authorization:'Bearer '+settings.tokens.workers[l.lifeId],'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});assert.equal(response.status,200);return response.json();};
 const [lifeA,lifeB]=settings.lives;
 await poll(async()=>{const s=await worker(lifeA,'/status');return s.sessions.every(r=>!r.busy);});
 deployments.workers[lifeA.lifeId].execution_disabled=true;await writeFile(resolve(worldRoot,'supervisor/deployments.json'),JSON.stringify(deployments));
 assert.equal((await worker(lifeA,'/stop','POST')).life_id,lifeA.lifeId);
 await poll(async()=>{try{await worker(lifeA,'/status');return false;}catch{return true;}});
 assert.equal((await worker(lifeB,'/status')).life_id,lifeB.lifeId);
 const rejected=launch('runtime/native_dsh/multi-life/supervisor/life-worker.mjs',[lifeA.lifeId,String(deployments.workers[lifeA.lifeId].port)]);
 await new Promise(r=>rejected.once('exit',r));assert.notEqual(rejected.exitCode,0);
 deployments.workers[lifeA.lifeId].execution_disabled=false;await writeFile(resolve(worldRoot,'supervisor/deployments.json'),JSON.stringify(deployments));
 launch('runtime/native_dsh/multi-life/supervisor/life-worker.mjs',[lifeA.lifeId,String(deployments.workers[lifeA.lifeId].port)],{NODE_OPTIONS:'--import='+pathToFileURL(resolve(root,'scripts/offline-transport.mjs')).href,DL_SMOKE_WIRE:resolve(boundary,'wire-A.jsonl')});
 const reopened=await poll(async()=>{try{return await worker(lifeA,'/status');}catch{return null;}});
 assert(reopened.sessions.some(s=>s.session_id===lifeA.authoritySessionId));
 await new Promise(r=>setTimeout(r,1800));assert.equal((await readFile(resolve(boundary,'wire-A.jsonl'),'utf8')).trim().split('\n').length,1,'reopen must not repeat completed native execution');
 result={passed:true,worldHasNoModel:true,independentWorkerProcesses:2,nativeProductionAssembly:true,isolatedSyntheticIdentities:true,humanRoomIsolation:true,chatLoaded:true,coreOnWire:true,stopOnePreservesOther:true,disabledRestartRefused:true,sameAuthorityOnReopen:true,noDuplicateProviderOnReopen:true,paidModelCalls:0,realDesktopInput:false,officialBillingNetworkAcceptance:false};
 console.log(JSON.stringify(result));
}catch(error){await writeFile(resolve(boundary,'failure.log'),logs.join(''));console.error('Public multi-life smoke failed: '+error.message+'; local evidence '+boundary);throw error;}
finally{
 for(const child of children.reverse()){if(child.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);}}
}
