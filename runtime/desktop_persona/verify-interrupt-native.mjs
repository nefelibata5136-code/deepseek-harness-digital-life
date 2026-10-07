import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bootNative,here} from '../native_dsh/boot-native.mjs';
import {fixtureTransport} from '../native_dsh/fixture-transport.mjs';
const root=resolve(here,'../../reports/task_A/interrupt-'+randomUUID()),workspace=resolve(root,'workspace');
await mkdir(workspace,{recursive:true});
await writeFile(resolve(workspace,'AGENTS.md'),'# Isolated interrupt fixture\n');
await writeFile(resolve(workspace,'persona-core.md'),'# Fixture identity\n');
process.env.DEEPSEEK_API_KEY='offline-placeholder-not-a-secret';
const fixture=fixtureTransport(workspace,{startAt:2});
let entered,aborted=false,count=0;const started=new Promise(r=>entered=r);
globalThis.fetch=async(url,init)=>{
 count++;
 if(count===1){entered();await new Promise((_,reject)=>{
  const abort=()=>{aborted=true;reject(init.signal.reason??new DOMException('Cancelled','AbortError'));};
  if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});
 });}
 return fixture.transport(url,init);
};
const primary=randomUUID(),ctx=await bootNative({sessionId:primary,testRoot:root});
const errors=[];ctx.on('agent/error',({error})=>errors.push(error.name));
try{
 await ctx.sessionController.create({sessionId:primary,cwd:workspace});
 const task=(await ctx.personaTasks.create({title:'插话中断隔离验收'})).sessionId;
 const ids=[randomUUID(),randomUUID()];
 const prompt=async(text,requestId)=>{
  const lease=await ctx.personaTurnAdmission.acquire(task);
  try{await ctx.sessionController.prompt({sessionId:task,requestId,mode:'queue',clientTimeZone:'Asia/Shanghai',content:[{type:'text',text}]},new AbortController().signal);
   const {agent}=await ctx.sessionController.resolveAgent(task);await agent.whenIdle();await ctx.sessions.flush(agent.session);
  }finally{lease.release();}
 };
 const first=prompt('original-running-request',ids[0]);await started;
 assert.deepEqual(ctx.sessionController.cancel({sessionId:task}),{accepted:true});
 const next=prompt('new-supplement-after-interrupt',ids[1]);
 await Promise.race([Promise.all([first,next]),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Cancellation/continuation timed out')),15000);timer.unref();})]);
 const {agent}=await ctx.sessionController.resolveAgent(task),events=[...agent.session.ownEvents()];
 assert(aborted,'Native cancellation must abort provider request');
 for(const id of ids)assert.equal(events.filter(e=>e.type==='agent/inbox/spliced').flatMap(e=>e.data.inserted??[]).filter(m=>m.source?.rpcId===id).length,1);
 assert(events.some(e=>e.type==='turn/end'&&e.data.reason?.kind==='completed'));
 assert(events.some(e=>e.type==='assistant/message'&&JSON.stringify(e.data).includes('Offline integrated native Host acknowledged.')));
 assert(fixture.wires.some(w=>JSON.stringify(w.messages).includes('new-supplement-after-interrupt')));
 const primaryAgent=await ctx.sessionController.resolveAgent(primary);assert(![...primaryAgent.agent.session.ownEvents()].some(e=>e.type==='agent/inbox/spliced'));
 const result={passed:true,observedAt:new Date().toISOString(),realNativeController:true,realTurnAdmission:true,isolatedProvider:true,paidModelCalls:0,productionMessages:0,testSessionId:task,providerRequestAborted:aborted,supplementReceivedExactlyOnce:true,continuedToCompletion:true,primaryUntouched:true,fixtureRoot:root,errors};
 await writeFile(resolve(here,'../../reports/interrupt-input/native-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await ctx.fiber.dispose();}
