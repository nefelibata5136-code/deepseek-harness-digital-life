import {createHash} from 'node:crypto';
import {findTurnActionResult} from '../../native_dsh/multi-life/recent-events/action-result.mjs';
import {redactThinking} from '../thinking.mjs';
// Read-only human renderer metadata. Never changes events or Agent input.
export function projectRoomRuns(events,rows,messages,{lifeId,sessionId,displayName,running=false,legacy=false,nativeMessageSeqs=[],relatedTurns=[],admittedTurns=[]}){
 const related=new Set(relatedTurns),admitted=new Set(admittedTurns);
 const runs=new Map(),seqTurn=new Map(),callTurn=new Map(),callName=new Map(),messageRun=new Map();let turn=0;
 const ensure=t=>{if(!runs.has(t))runs.set(t,{run_id:lifeId+':'+sessionId+':turn:'+t,life_id:lifeId,session_id:sessionId,display_name:displayName,turn:t,start_seq:null,start_time:null,end_time:null,status:'unknown',legacy,rows:[],message_ids:[],silent:false});return runs.get(t);};
 for(const e of events){const d=e.data??{};if(e.type==='turn/start'){turn=d.turn;Object.assign(ensure(turn),{start_seq:e.seq,start_time:e.time});}
  seqTurn.set(e.seq,d.turn??turn);
  if(e.type==='tool/call'){callTurn.set(d.callId,d.turn??turn);callName.set(d.callId,d.name);}
  if(e.type==='turn/end'){const r=ensure(d.turn??turn);r.end_time=e.time;r.status=d.reason?.kind==='completed'?'completed':d.reason?.kind==='error'?'failed':'interrupted';if(r.status==='failed')r.failure={code:d.reason.error?.code??'EXECUTION_FAILED',message:redactThinking(d.reason.error?.message??'本轮运行失败').slice(0,1200),seq:e.seq,time:e.time};}
 }
 const current=events.findLast(e=>e.type==='turn/start')?.data?.turn;if(running&&current!=null&&!ensure(current).end_time)ensure(current).status='running';
 for(const row of rows)ensure(row.turn).rows.push({...row,run_id:ensure(row.turn).run_id});
 const owned=messages.filter(m=>m.senderPrincipalId===lifeId&&m.originSessionId===sessionId),byId=new Map(owned.map(m=>[m.messageId,m]));
 const bind=(id,t)=>{if(!byId.has(id))return;const previous=messageRun.get(id);if(previous!==undefined&&previous!==t)return;messageRun.set(id,t);};
 const visit=(value,t)=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(['message_id','messageId'].includes(key)&&typeof item==='string')bind(item,t);else if(typeof item==='object')visit(item,t);}};
 for(const e of events)if(e.type==='tool/result'){const d=e.data??{},id=d.message?.toolCallId,t=callTurn.get(id);if(t==null||d.message?.isError||!['life_send_message','life_message_decide','life_turn_ack'].includes(callName.get(id)))continue;for(const b of d.message?.content??[])if(b.type==='text'){try{visit(JSON.parse(b.text),t);}catch{}}}
 // A successful send may return only a receipt. Match exact body hash,
 // sender/session and the call/result time interval, never time alone.
 const results=new Map(events.filter(e=>e.type==='tool/result').map(e=>[e.data?.message?.toolCallId,e]));
 for(const e of events)if(e.type==='tool/call'&&['life_send_message','life_message_decide','life_turn_ack'].includes(e.data?.name)){
  const d=e.data,result=results.get(d.callId);if(!result||result.data?.message?.isError)continue;let a;try{a=JSON.parse(d.arguments);}catch{continue;}
  for(const action of [a,...a.actions??[]]){if(typeof action.body!=='string')continue;const hash=createHash('sha256').update(action.body).digest('hex'),target=action.room_id??action.conversation_id;
   const matches=owned.filter(m=>m.bodyHash===hash&&(!target||m.conversationId===target)&&Date.parse(m.timestamp)>=e.time&&Date.parse(m.timestamp)<=result.time);
   if(matches.length===1)bind(matches[0].messageId,seqTurn.get(e.seq));
  }
 }
 for(const [id,t]of messageRun)ensure(t).message_ids.push(id);
 // Native visible text has an exact event sequence. Expose only the binding,
 // not a second copy of messages (the existing chat endpoint owns text).
 const nativeSeqs=new Set(nativeMessageSeqs),native_event_runs={};for(const e of events)if(e.type==='assistant/message'&&nativeSeqs.has(e.seq)){const run=ensure(seqTurn.get(e.seq));native_event_runs[e.seq]=run.run_id;run.native_times??=[];run.native_times.push(e.time);}
 const visible=[];
 const windows=new Map();for(const e of events){const t=seqTurn.get(e.seq);if(!windows.has(t))windows.set(t,[]);windows.get(t).push({...e,data:{...e.data,turn:t}});}
 for(const r of runs.values()){
  // Reuse the native ACK validator (matching arguments/result, terminal ACK,
  // unambiguous source), and require the whole turn to have succeeded.
  if(r.status==='completed')try{const ack=findTurnActionResult(windows.get(r.turn)??[],{turn:r.turn});
   if(ack?.result.disposition==='silent'){
    const e=windows.get(r.turn).find(x=>x.seq===ack.event_seq);r.silent=true;
    r.decision={kind:'no_action',time:e.time,seq:e.seq,source_ref:{session_id:sessionId,event_seq:e.seq}};
   }
  }catch{}
  const openCurrent=related.has(r.turn)&&r.turn===current&&r.start_seq!=null&&!r.end_time;
  if(!r.rows.some(row=>row.role!=='state')&&!r.message_ids.length&&!r.native_times?.length&&!(openCurrent||related.has(r.turn)&&(r.decision||r.failure||r.status==='interrupted')))continue;
  // Admission-linked execution is visible from its actual turn/start, before
  // the first settled model message or tool call. This remains its anchor.
  r.admitted=admitted.has(r.turn);
  const window=windows.get(r.turn)??[],pendingCalls=new Map();for(const e of window){if(e.type==='tool/call')pendingCalls.set(e.data.callId,e);if(e.type==='tool/result')pendingCalls.delete(e.data.message?.toolCallId);}
  const tool=[...pendingCalls.values()].at(-1),attempt=window.findLast(e=>e.type==='assistant/attempt');
  r.phase={kind:r.status==='running'?(tool?'tool':attempt?'waiting_model':'preparing'):r.status,label:r.status==='running'?(tool?'正在使用工具：'+redactThinking(tool.data.name):attempt?'等待模型输出':'正在准备运行'):r.status==='failed'?'处理失败':r.status==='completed'?'本轮已完成':r.status==='interrupted'?'运行已中断':'当前运行状态未确认',step:attempt?.data.step??null,last_activity_time:window.findLast(e=>['turn/start','assistant/attempt','assistant/message','tool/call','tool/result','turn/end'].includes(e.type))?.time??r.start_time};
  if(r.failure)r.rows.push({id:'run-failure:'+r.failure.seq,role:'progress',text:'处理失败：'+r.failure.message,time:r.failure.time,timestamp:new Date(r.failure.time).toISOString(),seq:r.failure.seq,turn:r.turn,life_id:lifeId,session_id:sessionId,status:'error',source_ref:{session_id:sessionId,event_seq:r.failure.seq}});
  else if(r.status==='interrupted'&&!r.rows.some(row=>row.role!=='state'))r.rows.push({id:'run-interrupted:'+r.start_seq,role:'progress',text:'本轮运行已中断，未确认完成。',time:r.end_time,seq:window.at(-1)?.seq,turn:r.turn,life_id:lifeId,session_id:sessionId,status:'error'});
  if(openCurrent&&!r.rows.some(row=>row.role!=='state'))r.rows.unshift({id:'run-start:'+r.start_seq,role:'progress',text:(r.admitted?'消息已接收，本轮已开始，':'本轮已开始，')+(r.status==='running'?'正在等待模型输出…':'当前运行状态暂时无法确认。'),time:r.start_time,timestamp:new Date(r.start_time).toISOString(),seq:r.start_seq,turn:r.turn,life_id:lifeId,session_id:sessionId,status:r.status,source_ref:{session_id:sessionId,event_seq:r.start_seq}});
  // A run which also spoke publicly is not labelled as no action.
  if(r.message_ids.length||r.native_times?.length){r.silent=false;r.decision=null;}
  const times=[...r.rows.map(x=>x.time),...r.message_ids.map(id=>Date.parse(byId.get(id).timestamp)),...r.native_times??[],...(related.has(r.turn)?[r.start_time]:[]),...(r.decision?[r.decision.time]:[])].filter(Number.isFinite);
  r.first_visible_time=times.length?Math.min(...times):null;
  visible.push(r);
 }
 visible.sort((a,b)=>(a.first_visible_time??Infinity)-(b.first_visible_time??Infinity)||a.start_seq-b.start_seq);
 const selected=visible.slice(-100),ids=new Set(selected.map(r=>r.run_id));
 return {runs:selected,native_event_runs:Object.fromEntries(Object.entries(native_event_runs).filter(([,id])=>ids.has(id)))};
}
