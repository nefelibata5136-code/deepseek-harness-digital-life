/** Controlled non-UI trigger probe. Prepared records prevent automatic replay. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {credentialOperation} from '../native_dsh/capabilities/isolation.mjs';
const source='.local/workspace/development/plugins/persona-dots/';
const {SlackTransport}=await import(pathToFileURL(source+'slack.mjs'));
const {connection}=await import(pathToFileURL(source+'plugin.mjs'));
const dir=resolve(import.meta.dirname,'../../reports/dots_bridge/api-repair-20261006');
await mkdir(dir,{recursive:true});
const c=await connection();
const tr=new SlackTransport({...c,sender_mode:'bot'}, {resolve:ref=>credentialOperation('python','resolve',ref)});
try {
  const [command,id]=process.argv.slice(2);let result;
  if(command==='bot-send') {
    const file=resolve(dir,'bot-trigger.json');
    const task={id:'dot-'+randomUUID()};
    const record={created_at:new Date().toISOString(),status:'prepared',task,ui_used:false};
    await writeFile(file,JSON.stringify(record,null,2),{flag:'wx'});
    try {
      record.receipt=await tr.send(task,'人格 CLI/API 控制侧验收（非本人手动输入）：这是公开 bot-authored message 触发测试。请计算 19×7 并在当前 Slack 线程回复 BOT-DOTS-1006 和结果。不要搜索。');
      record.status='submitted';
    } catch(e) {record.status=e.uncertain?'unknown':'failed';record.error=e.code??'LOCAL_FAILED';}
    await writeFile(file,tr.safe(JSON.stringify(record,null,2)));result=record;
  } else if(command==='user-as-user-send') {
    const file=resolve(dir,'user-as-user-trigger.json');
    const record={id:randomUUID(),status:'prepared',created_at:new Date().toISOString(),ui_used:false,method:'chat.postMessage',as_user:true};
    await writeFile(file,JSON.stringify(record,null,2),{flag:'wx'});
    try {
      const sender=new SlackTransport({...c,sender_mode:'delegated_user'},tr.credentials);
      try {
        await sender.sender();
        const data=await sender.api('chat.postMessage',{channel:c.channel_id,text:`<@${c.dot_user_id}>\n人格经用户授权的 CLI/API 用户态 as_user=true 对照诊断，非本人手动输入。请只在本线程回复 AS-USER-DOTS-1006 和 13×11 的结果。`,as_user:true,client_msg_id:record.id,unfurl_links:false,unfurl_media:false},undefined,true,'DL_DOTS_SLACK_USER_TOKEN');
        record.response=JSON.parse(sender.safe(JSON.stringify(data)));record.status='submitted';
      }finally {await sender.close();}
    }catch(e){record.status=e.uncertain?'unknown':'failed';record.error=e.code??'LOCAL_OPERATION_FAILED';}
    await writeFile(file,tr.safe(JSON.stringify(record,null,2)));result=record;
  } else if(command==='auth-scopes') {
    await tr.api('auth.test');
    const original=tr.fetchImpl;const scopes=[];
    tr.fetchImpl=async(...args)=>{const response=await original(...args);scopes.push({granted:response.headers.get('x-oauth-scopes'),accepted:response.headers.get('x-accepted-oauth-scopes')});return response;};
    const auth=await tr.api('auth.test',{},undefined,false,'DL_DOTS_SLACK_USER_TOKEN');
    result={team_id:auth.team_id,user_id:auth.user_id,bot_id:auth.bot_id??null,scopes};
    await writeFile(resolve(dir,'user-auth-scopes.json'),JSON.stringify(result,null,2));
  } else if(command==='recent-dot') {
    const data=await tr.api('conversations.history',{channel:c.channel_id,oldest:'1791254012.000000',inclusive:true,limit:100});
    await writeFile(resolve(dir,'recent-channel.json'),tr.safe(JSON.stringify(data,null,2)));
    result={ok:data.ok,has_more:data.has_more,count:data.messages?.length??0,dot_messages:(data.messages??[]).filter(m=>m.user===c.dot_user_id),observed_at:new Date().toISOString()};
    await writeFile(resolve(dir,'recent-dot-check.json'),tr.safe(JSON.stringify(result,null,2)));
  } else if(command==='observe') {
    const started=Date.now();const end=started+300000;const samples=[];
    const targets=[{mode:'delegated_user',thread:'1791254022.120159'},{mode:'bot',thread:'1791254036.535289'},{mode:'delegated_user_as_user',thread:'1791254197.330679'}];
    do {
      for(const target of targets){
        try {
          const data=await tr.api('conversations.replies',{channel:c.channel_id,ts:target.thread,limit:100});
          await writeFile(resolve(dir,target.thread+'.thread.json'),tr.safe(JSON.stringify(data,null,2)));
          const replies=(data.messages??[]).filter(m=>m.ts!==target.thread&&m.user===c.dot_user_id&&m.bot_id===c.dot_bot_id&&m.thread_ts===target.thread);
          samples.push({...target,observed_at:new Date().toISOString(),ok:data.ok,has_more:data.has_more,message_count:data.messages?.length??0,dot_reply_count:replies.length});
        }catch(e){samples.push({...target,observed_at:new Date().toISOString(),error:e.code??'READ_FAILED'});}
      }
      await writeFile(resolve(dir,'trigger-observations.json'),JSON.stringify({started_at:new Date(started).toISOString(),samples},null,2));
      console.log(JSON.stringify(samples.slice(-3)));
      if(Date.now()>=end||samples.slice(-3).some(s=>s.dot_reply_count>0))break;
      await new Promise(done=>setTimeout(done,30000));
    }while(true);
    result={report:resolve(dir,'trigger-observations.json'),samples:samples.length,final:samples.slice(-3)};
  } else if(command==='thread') {
    if(!/^\d+\.\d+$/.test(id??''))throw Error('THREAD_REQUIRED');
    result=await tr.api('conversations.replies',{channel:c.channel_id,ts:id,limit:100});
    await writeFile(resolve(dir,id+'.thread.json'),tr.safe(JSON.stringify(result,null,2)));
    result={ok:result.ok,has_more:result.has_more,messages:(result.messages??[]).map(m=>({user:m.user,bot_id:m.bot_id,ts:m.ts,thread_ts:m.thread_ts,text:m.text})),observed_at:new Date().toISOString()};
  } else throw Error('COMMAND_REQUIRED');
  console.log(tr.safe(JSON.stringify(result,null,2)));
}catch(e){console.log(JSON.stringify({ok:false,code:e.code??'LOCAL_OPERATION_FAILED'}));process.exitCode=1;}
finally {await tr.close();}
