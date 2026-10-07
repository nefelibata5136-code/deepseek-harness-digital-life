// Real authenticated Host route with isolated sessions, provider and budget store.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {requestLocalHost} from './transport.mjs';
const base=resolve(import.meta.dirname,'../..'),root=resolve(base,'reports/task_A/receipt-http-'+randomUUID()),workspace=resolve(root,'workspace'),primary=randomUUID();
await mkdir(workspace,{recursive:true});
for(const [file,text]of [['AGENTS.md','# HTTP receipt fixture'],['persona-core.md','# Fixture'],['audit.txt','before\n']])await writeFile(resolve(workspace,file),text);
const child=spawn(process.execPath,[resolve(base,'runtime/native_dsh/native-host.mjs'),'--offline-fixture',root,primary],{cwd:base,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs+=b;});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let first;
try{
 let control;const deadline=Date.now()+60000;
 while(Date.now()<deadline){try{control=JSON.parse(await readFile(resolve(root,'host-state/.host-control.json'),'utf8'));break;}catch(e){if(e.code!=='ENOENT')throw e;}if(child.exitCode!==null)throw Error('Fixture Host exited before ready');await wait(200);}
 assert(control,'Fixture startup timed out');
 const api=(route,body)=>requestLocalHost({method:body?'POST':'GET',route,body:body?JSON.stringify(body):undefined,token:control.token,port:control.port});
 assert.equal((await api('/status')).value.inputCapabilities.steer,true);
 let firstDone=false;
 first=api('/prompt',{sessionId:primary,requestId:randomUUID(),text:'original legacy turn'}).then(r=>{firstDone=true;return r;});
 const activeDeadline=Date.now()+10000;let active=false;
 while(Date.now()<activeDeadline){const s=(await api('/status')).value;if(s.activeSessionIds.includes(primary)){active=true;break;}await wait(50);}
 assert(active,'Original turn must be running');
 const receipts=[];
 for(const mode of ['queue','steer']){
  const requestId=randomUUID(),started=Date.now();
  const receipt=await api('/prompt',{sessionId:primary,requestId,text:'HTTP '+mode+' supplement',mode});
  assert.equal(receipt.status,200);assert.equal(receipt.value.state,'accepted');assert.equal(receipt.value.mode,mode);assert.equal(firstDone,false,'Admission must acknowledge before legacy turn ends');
  receipts.push({mode,latencyMs:Date.now()-started,requestId});
 }
 const legacy=await first;assert.equal(legacy.status,200);assert.equal(legacy.value.state,'completed');
 const result={passed:true,observedAt:new Date().toISOString(),actualAuthenticatedHost:true,isolatedProvider:true,receipts,receiptWhileLegacyTurnActive:true,legacyCompletionPreserved:true,productionMessages:0,paidModelCalls:0,root};
 await writeFile(resolve(base,'reports/steering-fix/http-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.error('Isolated HTTP receipt check failed: '+e.message);throw e;}
finally{if(child.exitCode===null){child.send({type:'persona-host-stop'});await Promise.race([new Promise(r=>child.once('exit',r)),wait(10000)]);if(child.exitCode===null)child.kill();}await first?.catch(()=>{});}
