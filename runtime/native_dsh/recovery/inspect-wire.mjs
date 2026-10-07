// Read-only native projection + shipped serializer, with an in-process fake transport.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Session} from '@deepseek-ai/dsh-session';
import {DeepSeekAdapter,resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {fixtureTransport} from '../fixture-transport.mjs';
import {base} from './service-control.mjs';
const id='80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b',dir=resolve(base,'runtime/native_dsh/home/sessions');
for(const name of await readdir(dir)) {
  let text;try{text=await readFile(resolve(dir,name,id,'session.v4.jsonl'),'utf8');}catch{continue;}
  const rows=text.trim().split('\n').map(JSON.parse),header=rows.shift(),session=Session.create(id,rows,header);
  const fake=fixtureTransport('.', {startAt:2});let body;
  globalThis.fetch=async(url,init)=>{body=JSON.parse(init.body);return fake.transport(url,init);};
  const connection=resolveAdapterOptions({baseURL:'https://api.deepseek.com/anthropic',maxTokens:512});
  const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'offline-user',prepareExtensions:async()=>({fields:{},accept:async()=>{}})});
  const messages=session.deriveMessages().map(m=>({...m,content:m.content.filter(b=>b.type!=='image')}));
  try{for await(const _c of adapter.stream({provider:'deepseek-official',model:'deepseek-flash',messages,reasoningEffort:'off',tools:[]})){};}
  catch(e){console.log(JSON.stringify({serializationError:e.message}));}
  if(body){
    const index=body.messages.findIndex(m=>m.content.some(b=>b.id==='call_00_QSSSWjA9fr6mRHR63pBA5712'));
    const protocol=body.messages.slice(index-1,index+7).map((m,i)=>({index:index-1+i,role:m.role,blocks:m.content.map(b=>({type:b.type,id:b.id,tool_use_id:b.tool_use_id}))}));
    const result={primaryId:id,protocol,paidCalls:0,sourceUnchanged:true};
    await writeFile(resolve(base,'reports/self-recovery/wire-protocol.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
