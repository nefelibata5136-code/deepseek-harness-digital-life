/** Official slack.exe with transient broker credentials; no browser or login flow. */
import {createRequire} from 'node:module';
import {stripVTControlCharacters} from 'node:util';
import {resolve} from 'node:path';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {credentialOperation} from '../native_dsh/capabilities/isolation.mjs';
const {redact,assertPublic}=await import(pathToFileURL('.local/workspace/development/plugins/persona-dots/protocol.mjs'));
const {SlackTransport}=await import(pathToFileURL('.local/workspace/development/plugins/persona-dots/slack.mjs'));
const root=import.meta.dirname,exe=resolve(root,'tools/slack-cli-4.8.0/slack.exe');
const pty=createRequire(resolve(root,'../native_dsh/package.json'))('node-pty');
const state=resolve(root,'protected/slack-cli-state'),reports=resolve(root,'../../reports/dots_bridge/cli');
const [command='auth',...args]=process.argv.slice(2);
const user=args.includes('--user');const reference=user?'DL_DOTS_SLACK_USER_TOKEN':'DL_DOTS_SLACK_TOKEN';
const team='UNCONFIGURED_ACCOUNT',channel='UNCONFIGURED_ACCOUNT',owner='UNCONFIGURED_ACCOUNT';
let secrets=[];
try{
  await mkdir(state,{recursive:true});
  const credential=await credentialOperation('python','resolve',reference);
  secrets=[credential.value];
  const env={...process.env};delete env.SLACK_BOT_TOKEN;delete env.SLACK_USER_TOKEN;delete env.DEEPSEEK_API_KEY;delete env.DASHSCOPE_API_KEY;
  env[user?'SLACK_USER_TOKEN':'SLACK_BOT_TOKEN']=credential.value;
  env.HTTPS_PROXY='http://127.0.0.1:7897';env.HTTP_PROXY=env.HTTPS_PROXY;
  const api=async(method,input={})=>{
    if(method.startsWith('conversations.')){
      const reader=new SlackTransport({},{resolve:ref=>credentialOperation('python','resolve',ref)});
      try{return JSON.parse(reader.safe(JSON.stringify(await reader.api(method,input))));}finally{await reader.close();}
    }
    // Slack CLI 4.8.0 stalls on this Windows host with plain redirected handles.
    // Use the Harness's existing ConPTY dependency; this creates no browser/window.
    const responseFile=resolve(state,randomUUID()+'.response');
    const quote=s=>"'"+s.replaceAll("'","''")+"'";
    const payload=method==='chat.meMessage'?['--data',new URLSearchParams(input).toString()]:['--json',JSON.stringify(input)];
    const cliArgs=['api',method,...payload,'--skip-update','--no-color','--accessible','--config-dir',state];
    const script="[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & "+quote(exe)+' '+cliArgs.map(quote).join(' ')+" | Set-Content -Encoding utf8 -LiteralPath "+quote(responseFile)+"; exit $LASTEXITCODE";
    try{await new Promise((done,reject)=>{
      const proc=pty.spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
        {env,cwd:root,cols:1000,rows:50,useConpty:true});
      let data='',settled=false;
      const fail=code=>{if(settled)return;settled=true;clearTimeout(timer);proc.kill();reject(Error(code));};
      const timer=setTimeout(()=>fail('CLI_INTERRUPTED_OUTCOME_UNCONFIRMED'),25000);
      proc.onData(chunk=>{data+=chunk;if(data.length>2097152)fail('CLI_OVERSIZE_RESPONSE');});
      proc.onExit(()=>{if(settled)return;setTimeout(()=>{if(settled)return;settled=true;clearTimeout(timer);done(stripVTControlCharacters(data));},100);});
    });
    const output=(await readFile(responseFile,'utf8')).replace(/^\uFEFF/,'');
    let value;try{value=JSON.parse(output);}catch{
      await mkdir(reports,{recursive:true});
      await writeFile(resolve(reports,'last-cli-diagnostic.txt'),redact(output,secrets).slice(0,4000));
      throw Error('CLI_RESPONSE_UNCONFIRMED');
    }
    return JSON.parse(redact(JSON.stringify(value),secrets));
    }finally{await rm(responseFile,{force:true});}
  };
  const auth=await api('auth.test');
  if(!auth.ok||auth.team_id!==team||user&&(auth.user_id!==owner||auth.bot_id)){
    await mkdir(reports,{recursive:true});await writeFile(resolve(reports,'last-auth-diagnostic.json'),JSON.stringify(auth,null,2));
    throw Error('CLI_AUTH_IDENTITY_MISMATCH');
  }
  let value;
  if(command==='auth')value={cli:'official Slack CLI 4.8.0',reference,team_id:auth.team_id,user_id:auth.user_id,bot_id:auth.bot_id??null,browser_used:false};
  else if(command==='history')value=await api('conversations.history',{channel,limit:50});
  else if(command==='thread'){
    const thread=args.find(a=>!a.startsWith('--'));if(!/^\d+\.\d+$/.test(thread??''))throw Error('THREAD_STRING_REQUIRED');
    value=await api('conversations.replies',{channel,ts:thread,limit:50});
  }else if(command==='confirm'){
    const id=args.find(a=>!a.startsWith('--'));if(!/^[a-f0-9-]{36}$/.test(id??''))throw Error('CLIENT_ID_REQUIRED');
    const path=resolve(reports,id+'.json'),record=JSON.parse(await readFile(path,'utf8'));
    if(record.input.channel!==channel)throw Error('FIXED_TEST_TARGET_REQUIRED');
    const response=await api(record.input.thread_ts?'conversations.replies':'conversations.history',
      {channel,...(record.input.thread_ts?{ts:record.input.thread_ts}:{}),limit:200});
    const matches=response.messages.filter(m=>m.client_msg_id===id&&m.user===owner&&m.text===record.input.text);
    if(matches.length===1){record.status='submitted';record.confirmed_at=new Date().toISOString();record.api_readback=matches[0];await writeFile(path,JSON.stringify(record,null,2));}
    value={id,status:record.status,matches:matches.length,has_more:response.has_more,report:path,browser_used:false};
  }else if(command==='post'){
    if(!user)throw Error('EXPLICIT_USER_SEND_REQUIRED');
    const file=args.find(a=>!a.startsWith('--'));const input=JSON.parse(await readFile(resolve(file),'utf8'));
    if(input.channel!==channel||typeof input.text!=='string'||input.text.length>35000||!input.text.startsWith('<@UNCONFIGURED_ACCOUNT>')&&!input.text.startsWith('<@UNCONFIGURED_ACCOUNT>'))throw Error('FIXED_TEST_TARGET_REQUIRED');
    if(!input.text.includes('CLI')||!input.text.includes('人格'))throw Error('AUTOMATION_DISCLOSURE_REQUIRED');
    assertPublic(input.text);
    if(input.thread_ts&&!/^\d+\.\d+$/.test(input.thread_ts))throw Error('THREAD_STRING_REQUIRED');
    const method=input.method??'chat.postMessage';if(!['chat.postMessage','chat.meMessage'].includes(method))throw Error('CLI_SEND_METHOD_NOT_ALLOWED');
    if(method==='chat.meMessage'&&input.thread_ts)throw Error('ME_MESSAGE_THREAD_UNSUPPORTED');
    const id=input.client_msg_id??randomUUID();if(!/^[a-f0-9-]{36}$/.test(id))throw Error('CLIENT_ID_REQUIRED');
    await mkdir(reports,{recursive:true});const path=resolve(reports,id+'.json');
    const record={id,created_at:new Date().toISOString(),method,input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),status:'prepared',browser_used:false,source:'official Slack CLI',actor:'maintainer CLI test; not Persona model call',input};
    await writeFile(path,JSON.stringify(record,null,2),{flag:'wx'});
    try{
      const payload={channel,text:input.text,...(input.thread_ts?{thread_ts:input.thread_ts}:{}),...(method==='chat.postMessage'?{client_msg_id:id,unfurl_links:false,unfurl_media:false,...(input.as_user===true?{as_user:true}:{})}:{})};
      record.response=await api(method,payload);record.status=record.response.ok?'submitted':'rejected';
    }catch(e){record.status='unknown';record.code=e.message;}
    await writeFile(path,JSON.stringify(record,null,2));value={...record,report:path};
  }else throw Error('COMMANDS_AUTH_HISTORY_THREAD_CONFIRM_POST');
  console.log(redact(JSON.stringify(value,null,2),secrets));
}catch(e){console.log(JSON.stringify({ok:false,code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'CLI_OPERATION_FAILED',browser_used:false}));process.exitCode=1;}
finally{secrets=[];}
// ConPTY's inherited worker keeps a standalone CLI alive after the child exits.
process.exit(process.exitCode??0);
