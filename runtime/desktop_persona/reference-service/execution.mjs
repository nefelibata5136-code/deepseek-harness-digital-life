// Human owner view of the two existing authority journals. No model request.
import {readFile,readdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {projectEvents} from '../transport.mjs';
import {redactThinking} from '../thinking.mjs';
import {projectRoomRuns} from './runs.mjs?revision=run-delivery-1';
import {projectDeliveries} from './delivery.mjs';
import {projectNativeChat} from './native-history.mjs?revision=human-decisions-1';
import {connectWorld,workerRequest} from '../../native_dsh/multi-life/supervisor/client.mjs';
import {migrationRoot,worldRoot,worldSnapshot} from '../../native_dsh/multi-life/supervisor/deployment.mjs';
import {readConversationSnapshot} from '../../native_dsh/multi-life/platform/conversation-storage.mjs?revision=readonly-snapshot-1';
const cache=new Map();
export function executionRoomTurns(events,{lifeId,nativeRoomId,inbox={},messages=[],sessionId,admittedOnly=false}){
 const turns=new Map();let turn=0,active=false,pending=new Set();
 const add=(t,id)=>{if(!id)return;if(!turns.has(t))turns.set(t,new Set());turns.get(t).add(id);};
 for(const e of events){const d=e.data??{};
  if(e.type==='turn/start'){turn=d.turn;active=true;for(const id of pending)add(turn,id);pending.clear();}
  if(e.type==='turn/end')active=false;
  if(e.type==='agent/inbox/spliced')for(const m of d.inserted??[]){const s=m.source??{},ids=[];
   if(s.kind==='user'&&nativeRoomId)ids.push(nativeRoomId);
   for(const id of s.inboxIds??(s.inboxId?[s.inboxId]:[])){const row=inbox[id];if(row?.owner_life_id===lifeId)ids.push(row.room_id);}
   for(const id of ids)if(active)add(turn,id);else pending.add(id);
  }
  if(!admittedOnly&&e.type==='tool/call'&&['life_send_message','life_turn_ack','life_message_decide'].includes(d.name)){
   for(const m of messages)if((m.senderPrincipalId??m.sender_id)===lifeId&&(m.originSessionId??m.origin_session_id)===sessionId&&(m.messageId??m.message_id)===`native-send:${lifeId}:${sessionId}:${d.callId}`)add(d.turn??turn,m.conversationId??m.room_id);
   try{const a=JSON.parse(d.arguments);add(d.turn??turn,a.room_id);for(const action of a.actions??[])add(d.turn??turn,action.conversation_id??action.room_id);}catch{}
  }
 }return turns;
}
export function projectExecution(events,{lifeId,sessionId,displayName,running=false}){
 const projection=projectEvents(events);
 const rows=projection.rows.filter(r=>['thinking','tool','result','state','progress'].includes(r.role)).map(r=>{
  const {args,images,phases,...rest}=r;
  return {...rest,text:redactThinking(r.text),detail:r.detail==null?null:redactThinking(r.detail),result:r.result==null?null:redactThinking(r.result),
   status:r.status==='running'&&!running?'unknown':r.status,life_id:lifeId,display_name:displayName,session_id:sessionId,
   timestamp:Number.isFinite(r.time)?new Date(r.time).toISOString():null,source_namespace:'native-session',source_ref:{session_id:sessionId,event_seq:r.seq,result_seq:r.resultSeq??null},
   image_refs:(images??[]).filter(x=>typeof x?.attachmentId==='string'&&/^[a-z0-9_-]{1,200}$/i.test(x.attachmentId)).map(x=>({attachmentId:x.attachmentId,width:x.width,height:x.height}))};
 });
 return {life_id:lifeId,session_id:sessionId,display_name:displayName,running,rows,total:rows.length};
}
export async function journal(life,id=life.authority_session_id){
 const snapshot=worldSnapshot(),manifest=snapshot.lives[life.life_id];
 if(!manifest||manifest.authoritySessionId!==life.authority_session_id)throw Error('EXECUTION_OWNER_BINDING_MISMATCH');
 const owner=snapshot.sessions[id];if(!/^[a-f0-9-]{36}$/i.test(id)||owner?.lifeId!==life.life_id||owner.status!=='ready'||owner.role==='delegate')throw Error('INVALID_EXECUTION_SESSION');
 // History stays readable when execution is disabled. Do not ask the worker
 // deployment/launch gate for permission to read already persisted records.
 const deployments=manifest.kind==='legacy'?null:JSON.parse(await readFile(resolve(worldRoot,'supervisor/deployments.json'),'utf8'));
 const historicalRoot=deployments?.workers?.[life.life_id]?.session_root;
 if(manifest.kind!=='legacy'&&(deployments?.schema_version!==1||typeof historicalRoot!=='string'))throw Error('EXECUTION_HISTORY_ROOT_UNAVAILABLE');
 const root=manifest.kind==='legacy'?resolve(migrationRoot,'runtime/native_dsh/home/sessions'):resolve(historicalRoot);
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;
  const path=resolve(root,entry.name,id,'session.v4.jsonl');let meta;
  try{meta=await stat(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  const old=cache.get(path);if(old?.size===meta.size&&old?.mtime===meta.mtimeMs)return old.events;
  const text=await readFile(path,'utf8'),records=text.slice(0,text.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(s=>JSON.parse(s));
  if(records[0]?.version!==4||records[0]?.id!==id)throw Error('EXECUTION_JOURNAL_IDENTITY_MISMATCH');
  const events=records.slice(1);if(events.some((e,i)=>e.seq!==i))throw Error('EXECUTION_JOURNAL_SEQUENCE_INVALID');
  cache.set(path,{size:meta.size,mtime:meta.mtimeMs,events});return events;
 }throw Error('EXECUTION_JOURNAL_UNAVAILABLE');
}
// Presentation metadata uses trusted receiver bindings and original native titles.
export async function describeActivityRooms(rooms,{lives,principal}){
 if(principal?.sender_id!=='human:maintainer')return rooms;
 const {state}=readConversationSnapshot(resolve(worldRoot,'kernel/platform/conversations'));
 return Promise.all(rooms.map(async room=>{
  const bindings=state.rooms[room.room_id]?.sessionBindings??{},activities=[];
  for(const life of lives){const id=bindings[life.life_id];if(!id||id===life.authority_session_id)continue;
   try{const events=await journal(life,id);const title=events.findLast(e=>e.type==='session/title')?.data?.title;
    let isTest=false;try{const tests=JSON.parse(await readFile(resolve(worldRoot,'workers',life.life_id,'test-sessions.json'),'utf8'));isTest=tests.life_id===life.life_id&&tests.sessions?.some(s=>s.session_id===id&&s.source==='host-developer-ultra-test')===true;}catch(error){if(error.code!=='ENOENT')throw error;}
    activities.push({life_id:life.life_id,session_id:id,is_test:isTest,title:(isTest?'【测试】':'')+(typeof title==='string'?title:life.display_name+'的独立活动')});
   }catch{}
  }
  if(!activities.length)return room;
  const subject=activities.find(a=>!a.title.includes('接收证据'))??activities[0];
  const kind=room.room_type==='group'?(room.visibility==='shared'?'公开消息':'私密群聊'):room.participants.includes(principal.sender_id)?'给用户的私聊':'双方私聊';
  return {...room,activity_sessions:activities,display_name:subject.title+' · '+kind};
 }));
}
export async function chatExecution(url,request){
 request??=await connectWorld();const roomId=url.searchParams.get('room_id');
 if(!roomId||roomId.length>200)throw Error('INVALID_EXECUTION_ROOM');
 const [self,registry,page]=await Promise.all([request('/v1/self'),request('/v1/lives'),request('/v1/rooms/'+encodeURIComponent(roomId)+'/messages?after=0&limit=1')]);
 // This is Maintainer's explicitly requested owner dashboard, not a life tool.
 if(self.principal?.sender_id!=='human:maintainer'||page.room.room_id!==roomId)throw Error('EXECUTION_HUMAN_OWNER_REQUIRED');
 const lives=registry.lives.filter(l=>page.room.participants.includes(l.life_id));
 const {state:roomState}=readConversationSnapshot(resolve(worldRoot,'kernel/platform/conversations'));
 const birth=JSON.parse(await readFile(resolve(worldRoot,'birth.json'),'utf8'));
 const agents=(await Promise.all(lives.map(async life=>{
  const bound=roomState.rooms[roomId]?.sessionBindings?.[life.life_id]??life.authority_session_id;
  const sessionIds=new Set([bound,...(roomState.rooms[roomId]?.messages??[]).filter(m=>m.senderPrincipalId===life.life_id).map(m=>m.originSessionId).filter(Boolean)]);
  return Promise.all([...sessionIds].map(async sessionId=>{
  const events=await journal(life,sessionId);let live;
  let statusTimer;try{live=await Promise.race([workerRequest(life.life_id,'/execution-status'),new Promise((_,reject)=>{statusTimer=setTimeout(()=>reject(Error('WORKER_STATUS_TIMEOUT')),1800);})]);}catch{}finally{clearTimeout(statusTimer);}
  const running=life.kind==='legacy'?live?.activeSessionIds?.includes(sessionId)===true:live?.sessions?.find(s=>s.session_id===sessionId)?.busy===true;
  const projected=projectExecution(events,{lifeId:life.life_id,sessionId:sessionId,displayName:life.display_name,running});
  const turns=executionRoomTurns(events,{lifeId:life.life_id,nativeRoomId:life.kind==='legacy'&&sessionId===life.authority_session_id?birth.human_a_room_id:null,inbox:roomState.inbox,sessionId,messages:roomState.rooms[roomId]?.messages??[]});
  const admissions=executionRoomTurns(events,{lifeId:life.life_id,nativeRoomId:life.kind==='legacy'&&sessionId===life.authority_session_id?birth.human_a_room_id:null,inbox:roomState.inbox,sessionId,messages:roomState.rooms[roomId]?.messages??[],admittedOnly:true});
  const turnRows=projected.rows.filter(row=>turns.get(row.turn)?.has(roomId));
  const relevant=turnRows.filter(row=>{
   if(row.role!=='tool')return true;try{const a=JSON.parse(row.detail);return !a.room_id||a.room_id===roomId;}catch{return true;}
  });
  const currentTurn=events.findLast(e=>e.type==='turn/start')?.data?.turn;
  const scopedRunning=running&&turns.get(currentTurn)?.has(roomId)===true;
  const nativeMessageSeqs=life.kind==='legacy'&&sessionId===life.authority_session_id&&roomId===birth.human_a_room_id?projectNativeChat(events,{sessionId:sessionId,roomId,humanId:'human:maintainer',lifeId:life.life_id}).filter(m=>m.sender_id===life.life_id).map(m=>m.source_ref.event_seq):[];
  const runProjection=projectRoomRuns(events,turnRows,roomState.rooms[roomId]?.messages??[],{lifeId:life.life_id,sessionId:sessionId,displayName:life.display_name,running:scopedRunning,legacy:life.kind==='legacy',nativeMessageSeqs,relatedTurns:[...turns].filter(([,ids])=>ids.has(roomId)).map(([t])=>t),admittedTurns:[...admissions].filter(([,ids])=>ids.has(roomId)).map(([t])=>t)});
  const deliveries=projectDeliveries(events,roomState.inbox,roomState.rooms[roomId]?.messages??[],{lifeId:life.life_id,sessionId:sessionId,displayName:life.display_name,runs:runProjection.runs,running,statusAvailable:!!live});
  return {...projected,...runProjection,deliveries,total:relevant.length,rows:relevant.slice(-100),running:scopedRunning,status_available:!!live,scope:'room-linked-turns',legacy:life.kind==='legacy'};
  }));
 }))).flat();
 return {room_id:roomId,scope:'room-linked-execution',agents,observed_at:new Date().toISOString()};
}
