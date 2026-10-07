import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createDetector,credentialAccessCandidate,BLOCKED} from './detector.mjs';
import {createKeyOutputGuard} from './guard.mjs';
import {bootNative} from '../native_dsh/boot-native.mjs';
import {fixtureTransport} from '../native_dsh/fixture-transport.mjs';
import {createBudgetGate} from '../budget_guard/provider_gate.mjs';
const secret='sk-'+randomUUID().replaceAll('-','')+'SYNTHETIC';
const folder=resolve(import.meta.dirname,'../../reports/key-output-guard');
const root=resolve(folder,'fixture-'+randomUUID()),workspace=resolve(root,'workspace');
await mkdir(workspace,{recursive:true});
await writeFile(resolve(workspace,'AGENTS.md'),'# Isolated review fixture\n');
await writeFile(resolve(workspace,'persona-core.md'),'Isolated fixture; no actual identity or memories.\n');
const checks=[], detector=createDetector([secret]);
for(const value of [secret,Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('hex'),
 [...secret].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')]) {
 assert(detector.inspect({hidden:{value}}));assert(detector.inspect(JSON.stringify({value})));
}
checks.push('Raw, Base64, Hex and Unicode forms are caught in nested values and serialized request bodies');
assert(detector.inspect('sk-anotherUnknownSyntheticCredential12345'));
assert.equal(detector.inspect('sk-example; ordinary work'),null);
assert(credentialAccessCandidate('read',{file_path:'C:/other/.env'}));
assert.equal(credentialAccessCandidate('read',{file_path:'C:/other/ordinary.md'}),null);
checks.push('Format rule and credential-access candidate signals work independently of known secrets');
let forwarded=0;
const standalone=createKeyOutputGuard({knownSecrets:[secret]});
const transport=standalone.wrapTransport(async()=>{forwarded++;return new Response('ok');});
await assert.rejects(transport('https://example.invalid',{body:JSON.stringify({message:secret})}),/KEY_OUTPUT_BLOCKED/);
await transport('https://example.invalid',{body:'ordinary body',headers:{'x-api-key':secret}});
assert.equal(forwarded,1);
checks.push('Request-body leak is blocked before network dispatch; legitimate authentication header remains usable');
const budgetOperations=[];
const budget=createBudgetGate({rpc:async op=>{budgetOperations.push(op);throw Error('Unexpected billing operation');},
 transport,screenRequest:transport.keyOutputPreflight});
await assert.rejects(budget.within({provider:'deepseek-official',model:'deepseek-flash'},()=>budget.fetch(
 'https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:100,messages:[{role:'user',content:secret}]})})),/KEY_OUTPUT_BLOCKED/);
assert.deepEqual(budgetOperations,[]);assert.equal(forwarded,1);
checks.push('Budget integration rejects leaked text before reservation or network dispatch');
const ordinary='ordinary '.repeat(120000);const start=performance.now();for(let i=0;i<20;i++)assert.equal(detector.inspect(ordinary),null);
const scanMsPerMiB=(performance.now()-start)/20/(Buffer.byteLength(ordinary)/1048576);
process.env.DEEPSEEK_API_KEY=secret;
const fake=fixtureTransport(workspace);
globalThis.fetch=fake.transport;
const sessionId=randomUUID();const ctx=await bootNative({sessionId,testRoot:root,overlays:[{id:'workspace-foundation',config:{python:process.env.DL_PYTHON||'python',workspace,store:resolve(root,'versions'),readRoots:[root],fullAccess:true}}]});
try {
 await ctx.sessionController.create({sessionId,cwd:workspace});
 const {agent}=await ctx.sessionController.resolveAgent(sessionId);
 const call=(name,args={})=>agent.ctx.tools.execute({agent,name,arguments:args,callId:randomUUID(),signal:new AbortController().signal});
 const register=(name,value)=>agent.ctx.tools.register({name,description:'Synthetic guard fixture',parameters:{},
  output:{schema:{},render:()=>[{type:'text',text:'safe display'}]},execute:()=>value});
 register('hidden_key_probe',{hidden:secret});const hidden=await call('hidden_key_probe');
 assert(hidden.isError);assert(!JSON.stringify(hidden).includes(secret));assert(!('value' in hidden));
 checks.push('Actual native tool return hidden value is fully replaced, not merely display-redacted');
 await writeFile(resolve(workspace,'synthetic.txt'),secret);
 const read=await call('read',{file_path:resolve(workspace,'synthetic.txt')});
 assert(read.isError);assert(JSON.stringify(read).includes('KEY_OUTPUT_BLOCKED'));assert(!JSON.stringify(read).includes(secret));
 checks.push('Real filesystem read is screened before result reaches the Agent');
 const script=resolve(root,'synthetic-print.cjs');await writeFile(script,'console.log('+JSON.stringify(secret)+');');
 const terminal=await call('terminal',{command:'node "'+script+'"',timeout:30});
 assert(terminal.isError);assert(!JSON.stringify(terminal).includes(secret));
 checks.push('Actual terminal stdout carrying a synthetic key is blocked');
 const write=await call('write',{file_path:resolve(workspace,'blocked-key.txt'),content:secret});
 assert(write.isError);checks.push('Tool input carrying the literal key is blocked');
 const outside=resolve(root,'outside.txt');const ok=await call('write',{file_path:outside,content:'ordinary external write'});
 assert(!ok.isError);assert.equal(await readFile(outside,'utf8'),'ordinary external write');
 assert.equal(ctx.workspaceFoundation.files.mode,'danger-full-access');
 checks.push('Ordinary workspace-external writes still succeed with full access');
 const event=agent.session.append('key-output-guard/probe',{text:secret});
 assert(!JSON.stringify(event).includes(secret));assert(JSON.stringify(event).includes('KEY_OUTPUT_BLOCKED'));
 await writeFile(resolve(workspace,'audit.txt'),secret);
 const errors=[];ctx.on('agent/error',({error})=>errors.push(String(error.message)));
 await ctx.sessionController.prompt({sessionId,requestId:randomUUID(),mode:'queue',
  content:[{type:'text',text:'Isolated deterministic review fixture.'}],clientTimeZone:'Asia/Shanghai'},new AbortController().signal);
 await agent.whenIdle();assert.deepEqual(errors,[]);assert.equal(fake.count(),3);
 assert(!JSON.stringify(fake.wires).includes(secret));
 assert([...agent.session.ownEvents()].some(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('KEY_OUTPUT_BLOCKED')));
 checks.push('Native Agent loop logs the blocked result and never sends the synthetic key in subsequent model bodies');
 await ctx.sessions.flush(agent.session);
 assert(!JSON.stringify([...agent.session.ownEvents()]).includes(secret));
 checks.push('Raw event append and persisted Session projections are sanitized');
 const status=ctx.keyOutputGuard.status();assert(status.blockedToolOutputs>=3);assert(status.blockedToolInputs>=1);
 assert(!JSON.stringify(ctx.keyOutputGuard.audit()).includes(secret));
 const report={passed:true,observedAt:new Date().toISOString(),root,sessionId,checks,scanMsPerMiB,
  usesLocalModel:false,paidModelCalls:0,syntheticModelRequests:fake.count(),realKeyRead:false,status,productionReloaded:false};
 await writeFile(resolve(folder,'validation.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({passed:true,checks:checks.length,scanMsPerMiB,paidModelCalls:0,realKeyRead:false}));
}finally{await ctx.fiber.dispose();}
