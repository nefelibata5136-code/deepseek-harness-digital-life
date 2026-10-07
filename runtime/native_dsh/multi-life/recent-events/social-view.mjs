import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const communicationEventId=(room,message)=>'event-room-'+hash(room+'\0'+message);
const routingKeys=new Set(['room_id','roomId','conversation_id','conversationId','conversationDisplayName','conversation_display_name',
  'origin_room_id','public_area_id','resolved_targets','room_seq','seq','replyTo','reply_to','source_key','sourceKey',
  'message_id','messageId','inbox_id','native_message_id','reply_message_id','origin_session_id','originSessionId','originTaskId','origin_task_id','execution_session_id','native_ingress']);
// Only Host routing metadata is removed. Never rewrite source text, user bodies,
// immutable journals or the human frontend's Room history.
export function socialView(value) {
  if(Array.isArray(value))return value.map(socialView);
  if(!value||typeof value!=='object')return value;
  const result={};
  for(const [key,item]of Object.entries(value))if(!routingKeys.has(key))result[key]=socialView(item);
  const room=value.room_id??value.conversationId??value.conversation_id;
  const message=value.message_id??value.messageId;
  if(typeof room==='string'&&typeof message==='string')result.event_id=communicationEventId(room,message);
  if(value.inResponseTo!==undefined){result.in_response_to=value.inResponseTo;delete result.inResponseTo;}
  if(value.addressee!==undefined){result.to=value.addressee;delete result.addressee;}
  if(value.speech_visibility!==undefined){result.visibility=value.speech_visibility;delete result.speech_visibility;}
  if(value.event_type==='communication'){result.nature=value.conversation_type==='direct'?'private':value.payload?.room_visibility==='shared'?'public':'private_group';}
  if(value.message_ref?.room_id&&value.message_ref?.message_id)result.message_ref={event_id:communicationEventId(value.message_ref.room_id,value.message_ref.message_id)};
  return result;
}
