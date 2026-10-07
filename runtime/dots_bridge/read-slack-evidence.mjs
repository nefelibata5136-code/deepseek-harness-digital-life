/** Maintainer evidence in this task's confirmed private test channel only. */
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {credentialOperation} from '../native_dsh/capabilities/isolation.mjs';
const {SlackTransport}=await import(pathToFileURL('.local/workspace/development/plugins/persona-dots/slack.mjs'));
const python=(process.env.DL_PYTHON || 'python');
const tr=new SlackTransport({},{resolve:ref=>credentialOperation(python,'resolve',ref)});
const thread=process.argv[2];
if(thread&&!/^\d+\.\d+$/.test(thread))throw new Error('INVALID_THREAD');
try{
  await tr.api('auth.test');
  const response=await tr.api(thread?'conversations.replies':'conversations.history',
    {channel:'UNCONFIGURED_ACCOUNT',...(thread?{ts:thread}:{}),limit:50},undefined,false);
  const record=JSON.parse(tr.safe(JSON.stringify({channel:'UNCONFIGURED_ACCOUNT',observed_at:new Date().toISOString(),thread:thread??null,response})));
  const dir=resolve(import.meta.dirname,'../../reports/dots_bridge/slack-evidence');await mkdir(dir,{recursive:true});
  const file=resolve(dir,(thread??'recent')+'-'+Date.now()+'.json');await writeFile(file,JSON.stringify(record,null,2));
  console.log(JSON.stringify({file,has_more:response.has_more,messages:response.messages?.map(m=>({
    user:m.user,bot_id:m.bot_id,app_id:m.app_id,ts:m.ts,thread_ts:m.thread_ts,reply_count:m.reply_count,
    text:m.text?.slice(0,600),truncated_in_console:(m.text?.length??0)>600}))},null,2));
}finally{await tr.close();}
