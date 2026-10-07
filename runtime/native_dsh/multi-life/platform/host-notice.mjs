import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {fail} from '../contracts.mjs';

// Operator notices carry Host provenance. RPC reuse never makes a second
// notice; a cold pending notice can be woken through native maintenance.
export async function queueHostNotice({ctx,sessionId,binding,text,requestId}) {
  if(typeof text!=='string'||!text.trim()||! /^[a-f0-9-]{36}$/i.test(requestId??''))fail('EXPLICIT_HOST_NOTICE_REQUIRED');
  const agent=ctx.agents.get(sessionId);
  if(!agent||!binding?.ready||binding.registered_session_id!==sessionId)fail('NOTICE_AUTHORITY_NOT_READY');
  const all=[...agent.session.ownEvents()],materialized=all.some(e=>e.type==='user/message'&&e.data.source?.rpcId===requestId);
  const pending=[...agent.inbox.nextTurn,...agent.inbox.nextStep].find(m=>m.source?.rpcId===requestId);
  const inserted=all.some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.source?.rpcId===requestId));
  if(pending&&pending.source.kind!=='host-notice')fail('NOTICE_RPC_SOURCE_CONFLICT');
  let state=materialized?'materialized':'queued';
  if(!materialized&&pending&&agent.status==='idle') {
    await agent.runMaintenance(async()=>{
      agent.inbox.remove(pending.id);
      agent.send(pending,'next-turn',true);
      await ctx.sessions.flush(agent.session);
    });
  }else if(!materialized&&!pending&&!inserted) {
    agent.send(createUserMessage({content:[{type:'text',text}],source:{kind:'host-notice',rpcId:requestId,receiverLifeId:binding.life_id,
      sender:{sender_id:'host:development',sender_type:'host',life_id:null,display_name:'开发 Host（转交用户请求）'},messageTimestamp:new Date().toISOString(),clientTimeZone:'Asia/Shanghai'}}),'next-turn',true);
    await ctx.sessions.flush(agent.session);
  }else if(!materialized&&!pending)state='previously_removed';
  return {state,duplicate:materialized||Boolean(pending)||inserted,session_id:sessionId,request_id:requestId,source_kind:'host-notice'};
}
