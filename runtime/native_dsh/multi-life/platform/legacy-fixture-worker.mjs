import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {LifeRegistry} from '../registry.mjs';
import {bootNative} from '../../boot-native.mjs';
const [root,phase]=process.argv.slice(2);assert(['first','reopen'].includes(phase));
const marker=JSON.parse(await readFile(resolve(root,'TEST-ONLY.json'),'utf8'));assert(marker.fixture===true);
const m=JSON.parse(await readFile(resolve(root,'TEST-ONLY-manifest.json'),'utf8'));
const registry=new LifeRegistry({root:resolve(root,'registry'),mode:'fixture'});let ctx;
const hash=b=>createHash('sha256').update(b).digest('hex');
process.env.DEEPSEEK_API_KEY='TEST-ONLY-not-a-secret';
globalThis.fetch=async()=>new Response([
  {type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:12,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'TEST ONLY legacy native completion'}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'},
].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
try {
  const ids=registry.sessions(m.lifeId).map(row=>row.sessionId);
  ctx=await bootNative({sessionId:m.authoritySessionId,testRoot:root,multiLife:{registry,manifest:m,simulateLegacy:true,adoptSessionIds:ids.length?ids:[m.authoritySessionId]}});
  const prompt=async id=>{await ctx.sessionController.prompt({sessionId:id,requestId:randomUUID(),mode:'queue',clientTimeZone:'Asia/Shanghai',content:[{type:'text',text:'TEST ONLY original composition regression'}]},new AbortController().signal);
    const r=await ctx.sessionController.resolveAgent(id);if('error'in r)throw r.error;await r.agent.whenIdle();await ctx.sessions.flush(r.agent.session);assert([...r.agent.session.ownEvents()].some(e=>e.type==='assistant/message'&&JSON.stringify(e.data).includes('TEST ONLY legacy native completion')));return r.agent;};
  if(phase==='first') {
    await ctx.sessionController.create({sessionId:m.authoritySessionId,cwd:m.deployment.workspace});const primary=await prompt(m.authoritySessionId);
    await assert.rejects(ctx.agents.create({sessionId:randomUUID(),meta:{cwd:m.deployment.workspace,agentPreset:'persona'},agentOptions:{provider:'deepseek-official',model:'deepseek-flash'}}),/UNKNOWN_SESSION_OWNER/);
    const activity=await ctx.personaTasks.create({title:'TEST ONLY compatibility activity'});await prompt(activity.sessionId);
    assert.equal(registry.owner(activity.sessionId).lifeId,m.lifeId);assert.equal(await ctx.personaTasks.accepts(randomUUID()),false);
    const fork=await ctx.sessionController.fork({sessionId:m.authoritySessionId});assert.equal(registry.owner(fork.sessionId).sourceSessionId,m.authoritySessionId);assert.equal(registry.owner(fork.sessionId).role,'activity');await prompt(fork.sessionId);
    assert.equal(registry.list().length,1);await writeFile(resolve(root,'TEST-ONLY-legacy-receipts.json'),JSON.stringify({primaryHeader:primary.session.header,coreHash:hash(await readFile(m.deployment.core)),activityId:activity.sessionId,forkId:fork.sessionId})+'\n');
  }else {
    const previous=JSON.parse(await readFile(resolve(root,'TEST-ONLY-legacy-receipts.json'),'utf8')),r=await ctx.sessionController.resolveAgent(m.authoritySessionId);assert(!('error'in r));
    assert.deepEqual({...r.agent.session.header,delegationDepth:r.agent.session.header.delegationDepth??0},{...previous.primaryHeader,delegationDepth:previous.primaryHeader.delegationDepth??0});assert.equal(hash(await readFile(m.deployment.core)),previous.coreHash);await prompt(previous.activityId);await prompt(previous.forkId);
  }
  console.log(JSON.stringify({passed:true,phase,formalLife:false,paidCalls:0}));
}finally{if(ctx)await ctx.fiber.dispose();registry.close();}
