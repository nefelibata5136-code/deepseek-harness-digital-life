// Installed only by smoke-multi child processes. It cannot reach a paid provider.
import {appendFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
if(process.env.DL_OFFLINE_SMOKE!=='1')throw Error('OFFLINE_SMOKE_MARKER_REQUIRED');
const raw=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(url.hostname==='api.deepseek.com'){
  const request=JSON.parse(init.body);
  appendFileSync(process.env.DL_SMOKE_WIRE,JSON.stringify({system_sha256:createHash('sha256').update(JSON.stringify(request.system)).digest('hex'),tools_sha256:createHash('sha256').update(JSON.stringify(request.tools)).digest('hex'),message_hashes:request.messages.map(m=>createHash('sha256').update(JSON.stringify(m)).digest('hex')),core_present:JSON.stringify(request.system).includes('PUBLIC SMOKE CORE'),paidModelCalls:0})+'\n');
  const events=[{type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:100,output_tokens:0,cache_read_input_tokens:70,cache_creation_input_tokens:30}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Synthetic offline response.'}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
  return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 }
 if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('OFFLINE_SMOKE_EXTERNAL_NETWORK_BLOCKED');
 return raw(input,init);
};
