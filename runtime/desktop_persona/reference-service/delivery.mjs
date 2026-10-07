// Read-only, per-message receipt projection; never exposes decision tokens,
// native prompts, private data or mutation/retry operations.
export function projectDeliveries(events,inbox,messages,{lifeId,sessionId,displayName,runs,running,statusAvailable}){
 const allowed=new Set(messages.filter(m=>m.senderPrincipalId==='human:maintainer').slice(-100).map(m=>m.messageId)),bindings=new Map();let turn=0,active=false,pending=[];
 for(const e of events){if(e.type==='turn/start'){turn=e.data.turn;active=true;for(const id of pending)bindings.set(id,turn);pending=[];}if(e.type==='agent/inbox/spliced')for(const m of e.data.inserted??[])for(const id of m.source?.inboxIds??(m.source?.inboxId?[m.source.inboxId]:[])){if(active)bindings.set(id,turn);else pending.push(id);}if(e.type==='turn/end')active=false;}
 const byTurn=new Map(runs.map(r=>[r.turn,r]));
 return Object.values(inbox).filter(x=>x.owner_life_id===lifeId&&allowed.has(x.message_id)).map(item=>{
  const owned=item.attempt?.session_id===sessionId,evidence=owned?item.attempt.native_evidence:null,t=bindings.get(item.inbox_id)??evidence?.turn,run=byTurn.get(t);let stage='queued',label=running?'等待交付；对方正在处理其他内容':'已保存，等待对方接收',error=null;
  if(item.status==='failed'||evidence?.state==='failed'||run?.status==='failed'){stage='failed';label=evidence?.pre_input?'已交付，但运行启动失败':'处理失败';error=run?.failure??{code:item.delivery_error_code??evidence?.error_code??'EXECUTION_FAILED',message:'本轮执行失败，尚未确认完成。'};}
  else if(item.status==='replied'){stage='replied';label='已回复';}
  else if(item.status==='ignored'){stage='ignored';label='选择忽略这条消息';}
  else if(item.status==='deferred'){stage='deferred';label='已接收，选择暂缓处理';}
  else if(run?.status==='interrupted'){stage='interrupted';label='运行已中断，未确认完成';}
  else if(run?.status==='running'){stage='processing';label=run.phase?.label??'正在处理';}
  else if(run?.status==='completed'||evidence?.state==='completed'||['handled','processed'].includes(item.status)){stage=run?.decision?.kind==='no_action'?'no_action':'completed';label=stage==='no_action'?'选择不行动':'本轮处理已完成';}
  else if(bindings.has(item.inbox_id)||item.status==='admitted'){stage='admitted';label=statusAvailable?'已交付，等待运行状态':'已交付，当前运行状态未确认';}
  if(!statusAvailable&&stage==='queued')label='已保存，接收方连接暂时不可用';
  return {message_id:item.message_id,life_id:lifeId,display_name:displayName,stage,label,error,phase:run?.phase??null,run_id:run?.run_id??null,received_at:item.received_at,updated_at:item.updated_at,reply_message_id:item.reply_message_id??null,source_ref:{namespace:'room-inbox',inbox_id:item.inbox_id,session_id:owned?sessionId:null,turn:t??null}};
 });
}
