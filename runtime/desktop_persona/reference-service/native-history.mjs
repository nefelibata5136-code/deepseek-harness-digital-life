import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isMachineActionResult} from '../../native_dsh/multi-life/recent-events/action-result.mjs';

// Original human↔Persona conversation predates Rooms. Keep its journal intact;
// expose a source-preserving projection only for its explicitly bound Room.
export function projectNativeChat(events,{sessionId,roomId,humanId,lifeId}) {
  let turn=0,active=false,pendingHuman=false;const humanTurns=new Set(),rows=[];
  for(const event of events){const d=event.data??{};
    if(event.type==='turn/start'){turn=d.turn;active=true;if(pendingHuman)humanTurns.add(turn);pendingHuman=false;}
    if(event.type==='turn/end')active=false;
    if(event.type==='agent/inbox/spliced')for(const [index,message]of(d.inserted??[]).entries()){
      if(message.role!=='user'||message.source?.kind!=='user')continue;
      const body=(message.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');if(!body)continue;
      // Native admission usually precedes turn/start. It belongs to the next
      // turn, while an input spliced during execution belongs to the active one.
      if(active)humanTurns.add(turn);else pendingHuman=true;
      rows.push({event,index,body,sender_id:humanId,display_name:'用户',request_id:message.source?.rpcId??null});
    }
    if(event.type==='assistant/message'&&humanTurns.has(d.turn??turn)){
      const body=(d.message?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
      if(body&&!isMachineActionResult(body))rows.push({event,body,sender_id:lifeId,display_name:'人格'});
    }
  }
  return rows.map((row,index)=>({room_id:roomId,message_id:`native:${sessionId}:${row.event.seq}:${row.index??'assistant'}`,
    seq:index+1,sender_id:row.sender_id,display_name:row.display_name,body:row.body,
    timestamp:typeof row.event.time==='number'&&Number.isFinite(row.event.time)?new Date(row.event.time).toISOString():null,
    body_hash:createHash('sha256').update(row.body).digest('hex'),request_id:row.request_id??null,
    source_namespace:'native-session',source_ref:{session_id:sessionId,event_seq:row.event.seq,inserted_index:row.index??null}}));
}
export async function nativeRoomHistory(room,{lives,principal},read=readFile){
  const marker=JSON.parse(await read(new URL('../../multi_life_supervisor/birth.json',import.meta.url),'utf8'));
  if(room.room_id!==marker.human_a_room_id||room.room_type!=='direct'||principal.sender_id!=='human:maintainer')return [];
  const life=lives.find(l=>l.kind==='legacy'&&room.participants.includes(l.life_id));if(!life)return [];
  const identity=JSON.parse(await read(new URL('../../../reports/first_native_start.json',import.meta.url),'utf8'));
  const sessionId=life.authority_session_id;
  if(sessionId!==identity.native_session_id||!/^[a-f0-9-]{36}$/i.test(sessionId))throw Error('NATIVE_CHAT_BINDING_MISMATCH');
  const root=new URL('../../native_dsh/home/sessions/',import.meta.url);
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    let text;try{text=await read(new URL(entry.name+'/'+sessionId+'/session.v4.jsonl',root),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
    const records=text.slice(0,text.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(line=>JSON.parse(line));
    if(records[0]?.id!==sessionId||records[0].version!==4)throw Error('NATIVE_CHAT_IDENTITY_INVALID');
    const events=records.slice(1);if(events.some((e,index)=>e.seq!==index))throw Error('NATIVE_CHAT_SEQUENCE_INVALID');
    return projectNativeChat(events,{sessionId,roomId:room.room_id,humanId:principal.sender_id,lifeId:life.life_id});
  }
  throw Error('NATIVE_CHAT_HISTORY_UNAVAILABLE');
}
