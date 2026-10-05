import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bootNative,here} from './boot-native.mjs';
const root=resolve(here,'../../reports/task_A/parallel-'+randomUUID());
const workspace=resolve(root,'workspace');await mkdir(workspace,{recursive:true});
await writeFile(resolve(workspace,'persona-core.md'),'# Parallel conversation fixture\n');
await writeFile(resolve(workspace,'AGENTS.md'),'# Fixture\n');
const response=block=>new Response([
 {type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:100,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
 {type:'content_block_start',index:0,content_block:block.type==='text'?{type:'text',text:''}:{...block,input:{}}},
 {type:'content_block_delta',index:0,delta:block.type==='text'?{type:'text_delta',text:block.text}:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}},
 {type:'content_block_stop',index:0},
 {type:'message_delta',delta:{stop_reason:block.type==='text'?'end_turn':'tool_use'},usage:{output_tokens:20}},
 {type:'message_stop'}].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
process.env.DEEPSEEK_API_KEY='offline-placeholder-not-a-secret';
globalThis.fetch=async(_url,init)=>{
 const body=JSON.parse(init.body);const all=JSON.stringify(body.messages);
 const userText=body.messages.filter(m=>m.role==='user').flatMap(m=>m.content??[]).filter(b=>b.type==='text').map(b=>b.text).join(' ');
 const marker=['writer-a','writer-c','chat-b','writer-d'].find(x=>userText.includes(x));
 const done=body.messages.some(m=>m.content?.some(b=>b.type==='tool_result'));
 if(marker==='writer-d'){
  const readDone=body.messages.some(m=>m.content?.some(b=>b.type==='tool_result'));
  const writeDone=body.messages.some(m=>m.content?.some(b=>b.type==='tool_use'&&b.name==='write'));
  return response(writeDone?{type:'text',text:'writer-d answered'}:readDone?{type:'tool_use',id:randomUUID(),name:'write',input:{file_path:resolve(workspace,'writer-a.txt'),content:'writer-d'}}:{type:'tool_use',id:randomUUID(),name:'read',input:{file_path:resolve(workspace,'writer-a.txt')}});
 }
 return response(marker==='chat-b'||done?{type:'text',text:marker+' answered'}:{type:'tool_use',id:randomUUID(),name:'write',input:{file_path:resolve(workspace,marker+'.txt'),content:marker}});
};
const primary=randomUUID();const ctx=await bootNative({sessionId:primary,testRoot:root});
ctx.on('agent/error',({error})=>console.error(error));
let releaseA,enteredA;const held=new Promise(r=>releaseA=r),entered=new Promise(r=>enteredA=r);
let simultaneous=0,maxSimultaneous=0,cEntered=false,dReadEntered=false,dId,dCall;
const dCalled=new Promise(r=>dCall=r);
ctx.on('session/event',(session,event)=>{if(String(session.id)===dId&&event.type==='tool/call'&&event.data.name==='read')dCall();});
ctx.on('tools/execute',async(exec,next)=>{
 if(exec.name==='read'&&String(exec.agent.session.id)===dId)dReadEntered=true;
 if(exec.name!=='write')return next();
 simultaneous++;maxSimultaneous=Math.max(maxSimultaneous,simultaneous);
 try {
  if(exec.agent.session.id===primary){enteredA();await held;}
  else cEntered=true;
  return await next();
 }finally{simultaneous--;}
});
try {
 await ctx.sessionController.create({sessionId:primary,cwd:workspace});
 const b=(await ctx.personaTasks.create({title:'Chat B'})).sessionId;
 const c=(await ctx.personaTasks.create({title:'Writer C'})).sessionId;
 dId=(await ctx.personaTasks.create({title:'Same file writer D'})).sessionId;
 const prompt=async(id,text)=>{
  const lease=await ctx.personaTurnAdmission.acquire(id);
  try {
  await ctx.sessionController.prompt({sessionId:id,requestId:randomUUID(),mode:'queue',content:[{type:'text',text}],clientTimeZone:'Asia/Shanghai'},new AbortController().signal);
  const result=await ctx.sessionController.resolveAgent(id);await result.agent.whenIdle();
  const events=[...result.agent.session.ownEvents()];
  assert(events.some(e=>e.type==='assistant/message'&&JSON.stringify(e.data).includes(text+' answered')),JSON.stringify(events.filter(e=>['assistant/message','turn/end','assistant/attempt'].includes(e.type))));
  } finally {lease.release();}
 };
 const a=prompt(primary,'writer-a');await entered;
 const pendingC=prompt(c,'writer-c');
 const pendingD=prompt(dId,'writer-d');
 await dCalled;assert.equal(dReadEntered,false);
 await Promise.race([prompt(b,'chat-b'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Chat was blocked by file writer')),10000))]);
 await Promise.race([pendingC,new Promise((_,reject)=>setTimeout(()=>reject(Error('Different file was blocked')),10000))]);
 assert.equal(cEntered,true);assert(ctx.workspaceFoundation.fileAccess.owners.includes(primary));
 assert.equal(dReadEntered,false);releaseA();await Promise.all([a,pendingD]);assert(dReadEntered);
 assert.equal(maxSimultaneous,2);assert.equal(cEntered,true);
 assert.equal(await readFile(resolve(workspace,'writer-a.txt'),'utf8'),'writer-d');
 assert.equal(await readFile(resolve(workspace,'writer-c.txt'),'utf8'),'writer-c');
 ctx.workspaceFoundation.assertHealthy();assert.equal(ctx.workspaceFoundation.fileAccess.owner,null);
 const names=['runtime/native_dsh/task-host.mjs','runtime/native_dsh/native-host.mjs','runtime/workspace_foundation/lifecycle.mjs','runtime/workspace_foundation/file-operation-locks.mjs','runtime/workspace_foundation/snapshots.py','runtime/native_dsh/home/profiles/persona/cordis.patch.yml'];
 const sourceSha256=Object.fromEntries(await Promise.all(names.map(async n=>[n,createHash('sha256').update(await readFile(resolve(here,'../..',n))).digest('hex')])));
 const report={passed:true,observedAt:new Date().toISOString(),chatAnsweredWhileFileToolHeld:true,differentFileToolsParallel:true,sameFileReadAndWriteSerialized:true,staleWritePolicyPreserved:true,maxSimultaneous,fileContentsVerified:true,sourceSha256,paidModelCalls:0,root};
 await writeFile(resolve(here,'../../reports/task_A/parallel-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{releaseA();await ctx.fiber.dispose();}
