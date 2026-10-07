/** Official Slack transport experiment. No OpenAI API, website automation or local web-search pipeline. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { credentialOperation } from '../native_dsh/capabilities/isolation.mjs';
const SOURCE='.local/workspace/development/plugins/persona-dots';
const {SlackTransport,SECRET_REF}=await import(pathToFileURL(resolve(SOURCE,'slack.mjs')));
const EXPECTED_TEAM='UNCONFIGURED_ACCOUNT',OFFICIAL_CHATGPT_APP='A097V82EGG2';
const reportRoot=resolve(import.meta.dirname,'../../reports/dots_bridge/chatgpt');
const python=(process.env.DL_PYTHON || 'python');
const [action='preflight',...args]=process.argv.slice(2);
const transport=new SlackTransport({},{resolve:ref=>credentialOperation(python,'resolve',ref)});
const boundary={provider:'official ChatGPT Slack App',ordinary_chat:'unverified',work:'unverified',web_search:'unverified',openai_api_used:false,local_search_used:false};
const safeError=e=>({code:e.code??(/^[A-Z0-9_]+$/.test(e.message)?e.message:'SLACK_EXPERIMENT_FAILED'),uncertain:!!e.uncertain});
async function auth(){const value=await transport.api('auth.test');if(value.team_id!==EXPECTED_TEAM)throw new Error('WORKSPACE_MISMATCH');
  return {team_id:value.team_id,sender_user_id:value.user_id,sender_bot_id:value.bot_id??null};}
async function appIdentity(userId){
  const user=(await transport.api('users.info',{user:userId})).user;
  if(!user?.is_bot||!user.profile?.bot_id)throw new Error('TARGET_IS_NOT_A_BOT');
  const bot=(await transport.api('bots.info',{bot:user.profile.bot_id})).bot;
  if(bot?.app_id!==OFFICIAL_CHATGPT_APP)throw new Error('OFFICIAL_CHATGPT_APP_ID_MISMATCH');
  return {user_id:user.id,bot_id:bot.id,app_id:bot.app_id,display_name:user.profile.display_name||user.name};
}
async function discover(){
  const bots=[];let cursor='';let pages=0;
  do{
    const data=await transport.api('users.list',{limit:200,...(cursor?{cursor}:{})});
    for(const user of data.members??[])if(user.is_bot&&!user.deleted&&
      (user.profile?.api_app_id===OFFICIAL_CHATGPT_APP||/chatgpt/i.test(user.name+' '+user.profile?.display_name))){
      try{bots.push(await appIdentity(user.id));}catch(error){bots.push({user_id:user.id,verified:false,...safeError(error)});}
    }
    cursor=data.response_metadata?.next_cursor??'';pages++;
  }while(cursor&&pages<10);
  return {bots,more_user_pages:!!cursor};
}
async function privateChannel(channel){
  const c=(await transport.api('conversations.info',{channel})).channel;
  if(!c?.is_private||c.is_shared||c.is_ext_shared||c.is_archived||!c.is_member)throw new Error('PRIVATE_UNSHARED_BRIDGE_CHANNEL_REQUIRED');
  return {channel_id:c.id,name:c.name};
}
async function persist(value){
  await mkdir(reportRoot,{recursive:true});
  const path=resolve(reportRoot,value.experiment_id+'.json');
  await writeFile(path,transport.safe(JSON.stringify(value,null,2))+'\n');return path;
}
const prompts={
  A:'请告诉我 17 × 23 等于多少，并在答案最后写 DL_SLACK_TEST_OK。请直接进行普通问答，不创建Work或Codex任务。',
  B:'请使用你自己的Web Search查询北京时间2026年10月5日OpenAI官方有没有发布新的产品更新，给出原始官方来源及发布日期。不要猜测，查不到明确说不知道；直接在对话回答，不创建Work任务。',
  C:'请查一下最近Anthropic的两件重要动态，按1、2编号，给原始来源。请在普通对话里回答，不创建Work任务。',
  D_OPENAI:'这是独立OpenAI主题任务。只讨论OpenAI。记住这个线程的隔离标记：',
  D_ANTHROPIC:'这是独立Anthropic主题任务。只讨论Anthropic。记住这个线程的隔离标记：'
};
async function send(identity,channel,prompt,thread=null,label='A'){
  const experiment_id='chatgpt-'+randomUUID();
  const record={experiment_id,created_at:new Date().toISOString(),label,...boundary,identity,channel,thread,
    request:prompt,status:'prepared',messages:[],request_sha256:createHash('sha256').update(prompt).digest('hex')};
  const path=await persist(record);
  try{
    const result=await transport.api('chat.postMessage',{channel,text:`<@${identity.user_id}> ${prompt}`,
      ...(thread?{thread_ts:thread}:{}),client_msg_id:experiment_id.slice(8),unfurl_links:false,unfurl_media:false},undefined,true);
    if(result.channel!==channel||!/^\d+\.\d+$/.test(result.ts??''))throw new Error('SUBMISSION_RECEIPT_UNCONFIRMED');
    Object.assign(record,{status:'submitted',request_ts:result.ts,thread:thread??result.ts});
  }catch(error){Object.assign(record,{status:error.uncertain?'unknown':'failed',error:safeError(error)});}
  await persist(record);return {record,path};
}
async function recordFrom(id){if(!/^chatgpt-[a-f0-9-]{36}$/.test(id??''))throw new Error('INVALID_EXPERIMENT_ID');
  return JSON.parse(await readFile(resolve(reportRoot,id+'.json'),'utf8'));}
try{
  let value;
  const credential=await credentialOperation(python,'describe',SECRET_REF);
  if(!credential.configured){value={...boundary,action,status:'not_tested',blocker:'DL_SLACK_APP_CREDENTIAL_NOT_CONFIGURED'};}
  else if(action==='preflight'){value={...boundary,action,status:'inspected',auth:await auth(),...await discover()};}
  else if(action==='dm'){
    await auth();const target=await appIdentity(args[0]);
    try{const dm=await transport.api('conversations.open',{users:target.user_id,return_im:true},undefined,true);
      const sent=await send(target,dm.channel.id,prompts.A,null,'DM_A');value={...sent.record,report:sent.path};
    }catch(error){value={...boundary,route:'bot-to-bot DM',target,status:'failed',error:safeError(error)};}
  }else if(action==='channel'){
    await auth();const [userId,channel,test='A']=args;const target=await appIdentity(userId);await privateChannel(channel);
    const testPrompt=prompts[test];if(!testPrompt)throw new Error('UNKNOWN_ACCEPTANCE_TEST');
    const prompt=testPrompt+(test.startsWith('D_')?randomUUID():'');
    const sent=await send(target,channel,prompt,null,test);value={...sent.record,report:sent.path};
  }else if(action==='check'){
    await auth();const record=await recordFrom(args[0]);
    if(record.status==='unknown'||!record.thread){value={...record,note:'Do not replay uncertain sends'};}
    else{
      await appIdentity(record.identity.user_id);
      const data=await transport.api('conversations.replies',{channel:record.channel,ts:record.thread,limit:15,
        ...(record.cursor?{cursor:record.cursor}:{})});
      for(const message of data.messages??[]){
        if(message.user!==record.identity.user_id||message.bot_id!==record.identity.bot_id||message.thread_ts!==record.thread)continue;
        const raw=JSON.parse(transport.safe(JSON.stringify(message)));const hash=createHash('sha256').update(JSON.stringify(raw)).digest('hex');
        if(!record.messages.some(m=>m.hash===hash))record.messages.push({hash,observed_at:new Date().toISOString(),raw});
      }
      record.cursor=data.response_metadata?.next_cursor??'';
      record.status=record.messages.length?'reply_observed':'submitted';
      record.latest_replies=[...new Map(record.messages.map(m=>[m.raw.ts,m.raw])).values()];
      record.test_A_marker_observed=record.latest_replies.some(m=>/\b391\b/.test(m.text??'')&&(m.text??'').includes('DL_SLACK_TEST_OK'));
      record.web_search_evidence='unverified: citations alone do not prove a Web Search tool was used';
      record.last_checked_at=new Date().toISOString();await persist(record);value=record;
    }
  }else if(action==='continue'){
    await auth();const parent=await recordFrom(args[0]);if(!parent.messages.length)throw new Error('READ_REAL_REPLY_BEFORE_FOLLOWUP');
    const target=await appIdentity(parent.identity.user_id);
    const prompt=parent.label==='C'?'只展开你刚才提到的第二件事。请引用前一回答对应事项，不要改为新的清单。':
      '只根据这个线程的上下文回答：前一条请求给了哪个隔离标记和主题？不要看其它线程。';
    const sent=await send(target,parent.channel,prompt,parent.thread,'FOLLOWUP_'+parent.label);
    sent.record.parent_experiment_id=parent.experiment_id;await persist(sent.record);value={...sent.record,report:sent.path};
  }else throw new Error('UNKNOWN_PROBE_ACTION');
  console.log(transport.safe(JSON.stringify(value,null,2)));
}catch(error){console.log(JSON.stringify({...boundary,action,status:'failed',error:safeError(error)}));process.exitCode=1;}
finally{await transport.close();}
