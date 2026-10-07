import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bootNative} from '../native_dsh/boot-native.mjs';
import {projectEvents} from '../desktop_persona/transport.mjs';
const out=fileURLToPath(new URL('../../reports/activity_progress',import.meta.url));
const root=resolve(out,'native-'+randomUUID()),workspace=resolve(root,'workspace');await mkdir(workspace,{recursive:true});
await writeFile(resolve(workspace,'persona-core.md'),'# Isolated technical progress fixture\n');await writeFile(resolve(workspace,'AGENTS.md'),'# Fixture\n');await writeFile(resolve(workspace,'a.txt'),'42\n');
process.env.DEEPSEEK_API_KEY='offline-placeholder-not-a-secret';let calls=0,policySeen=false;
globalThis.fetch=async(_url,init)=>{
  calls++;const body=JSON.parse(init.body);policySeen ||= JSON.stringify(body.system).includes('【进展】');
  const done=JSON.stringify(body.messages).includes('tool_result');
  const blocks=done?[{type:'text',text:'最终结果：42。'}]:[{type:'text',text:'【进展】我先读取测试资料，核对最后的数值。'},{type:'tool_use',id:'fixture-call',name:'read',input:{file_path:resolve(workspace,'a.txt')}}];
  const es=[{type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:100,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}];
  blocks.forEach((b,index)=>{es.push({type:'content_block_start',index,content_block:b.type==='text'?{type:'text',text:''}:{...b,input:{}}},{type:'content_block_delta',index,delta:b.type==='text'?{type:'text_delta',text:b.text}:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}},{type:'content_block_stop',index});});
  es.push({type:'message_delta',delta:{stop_reason:done?'end_turn':'tool_use'},usage:{output_tokens:20}},{type:'message_stop'});
  return new Response(es.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
};
const primary=randomUUID();const ctx=await bootNative({sessionId:primary,testRoot:root});
try{
  const task=await ctx.personaTasks.create({title:'Native progress fixture'}),id=task.sessionId;
  await ctx.sessionController.prompt({sessionId:id,requestId:randomUUID(),mode:'queue',clientTimeZone:'Asia/Shanghai',content:[{type:'text',text:'读取测试资料并核对最终结果。'}]},new AbortController().signal);
  const {agent}=await ctx.sessionController.resolveAgent(id);await agent.whenIdle();await ctx.sessions.flush(agent.session);await ctx.personaProgressPhases.flush();
  const events=[...agent.session.ownEvents()],phase=(await ctx.personaProgressPhases.read(id)).events,projected=projectEvents(events,phase);
  assert(policySeen,'Progress policy reaches the native model request for user tasks');assert.equal(calls,2);assert(events.some(e=>e.type==='turn/end'&&e.data.reason.kind==='completed'));
  assert.equal(projected.rows.filter(r=>r.role==='progress').length,1);assert.equal(projected.rows.find(r=>r.role==='tool').phases.length,7);
  assert(!events.some(e=>e.type.startsWith('persona/')),'Native Session event types remain supported');
  assert.equal(await readFile(resolve(workspace,'a.txt'),'utf8'),'42\n');
  const result={passed:true,paidModelCalls:0,nativeModelRequests:calls,policySeen,phaseRecords:phase.length,ownReportProjected:true,sessionId:id,root};await writeFile(resolve(out,'native-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await ctx.fiber.dispose();}
