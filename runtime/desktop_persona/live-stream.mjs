// Read-only display tap. Uses native chunks, never touches model requests.
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {native} from '../workspace_foundation/native.mjs';
import {redactThinking} from './thinking.mjs';

export async function mountAssistantDisplay(ctx,{lifeId,sessionId,port,token}) {
  if(ctx.get('assistantDisplay',false))return ctx.get('assistantDisplay');
  if(!lifeId||!sessionId||!token||!Number.isInteger(port))throw Error('EXPLICIT_DISPLAY_OWNER_REQUIRED');
  const {AssistantStreamAccumulator}=await native('dsh-llm');
  let active=null,revision=0;
  const accept=({agent,frame})=>{
    if(agent.session.id!==sessionId)return;
    revision++;
    if(frame.type==='start')active={attemptId:frame.attemptId,turn:frame.turn,step:frame.step,nextIndex:0,stream:new AssistantStreamAccumulator()};
    else if(frame.type==='chunk'){
      if(!active||active.attemptId!==frame.attemptId||active.nextIndex!==frame.index){active=null;return;}
      active.stream.push({time:frame.time,chunk:frame.chunk});active.nextIndex++;
    }else if(frame.type==='end')active=null;
  };
  const snapshot=()=>{
    const chunks=active?.stream.snapshot()??[];
    const channel=type=>redactThinking(chunks.filter(r=>r.type===type).flatMap(r=>r.texts).join(''),{streaming:true});
    return {life_id:lifeId,session_id:sessionId,revision,active:active?{attempt_id:active.attemptId,turn:active.turn,step:active.step,reasoning:channel('reasoning-chunks'),text:channel('text-chunks')}:null};
  };
  const server=createServer((req,res)=>{
    const a=Buffer.from(req.headers.authorization??''),b=Buffer.from('Bearer '+token);
    const allowed=a.length===b.length&&timingSafeEqual(a,b);
    res.writeHead(allowed&&req.method==='GET'&&req.url==='/snapshot'?200:403,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(allowed&&req.method==='GET'&&req.url==='/snapshot'?snapshot():{error:'DISPLAY_AUTHENTICATION_REQUIRED'}));
  });
  await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
  const remove=ctx.on('agent/assistant-stream',accept,{global:true});
  ctx.effect(()=>()=>{remove();server.close();active=null;});
  const service={snapshot,port,source:'native-assistant-stream',modelCalls:0};ctx.provide('assistantDisplay',service);return service;
}

// Supports installing this same module into an existing Host without restart.
export async function mountExistingDisplay(ctx,lifeId){
  const {readFile}=await import('node:fs/promises');const {resolve}=await import('node:path');
  const {worldSnapshot,workerLayout,migrationRoot,python}=await import('../native_dsh/multi-life/supervisor/deployment.mjs');
  const m=worldSnapshot().lives[lifeId];if(!m)throw Error('UNKNOWN_DISPLAY_OWNER');
  let port,token;
  if(m.kind==='legacy'){const c=JSON.parse(await readFile(resolve(migrationRoot,'runtime/native_dsh/host-state/.host-control.json'),'utf8'));port=c.port;token=c.token;}
  else {port=workerLayout(lifeId).port;const {credentialOperation}=await import('../native_dsh/capabilities/isolation.mjs');const {workerReference}=await import('../native_dsh/multi-life/supervisor/neutral.mjs');({value:token}=await credentialOperation(python,'resolve',workerReference(lifeId)));}
  return mountAssistantDisplay(ctx,{lifeId,sessionId:m.authoritySessionId,port:port+100,token});
}
