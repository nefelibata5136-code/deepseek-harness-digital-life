import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {fail} from '../contracts.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
export {socialView,communicationEventId} from '../recent-events/social-view.mjs';
import {socialView,communicationEventId} from '../recent-events/social-view.mjs';
export const speechParameters={to:{type:'string',required:true},
  visibility:{type:'string',enum:['private','public'],required:true},body:{type:'string',required:true},in_response_to:{type:'string'}};
export const speechDescription='向主体说话：to 填联系人名字（如用户、人格、新生命，公开广播用 everyone），visibility 为 private/public，body 为正文。Host 负责路由。可选 in_response_to 是回应的事件引用，与发表方式独立。同一活动可多次发言并继续使用原生工具；成功发送不结束活动，也不自动完成输入。unknown 先查 life_action_result，不能盲重发。';
function fields(value,allowed) {if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('SOCIAL_ARGUMENT_INVALID');}
const id=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/u.test(value);

export class SocialCommunication {
  constructor(rooms){this.rooms=rooms;}
  scoped({lifeId,sessionId}) {
    this.rooms.contexts.registry.assertTarget(lifeId,sessionId);
    return this.rooms.listForPrincipal(lifeId).filter(room=>this.rooms.recentRoomScope(lifeId,sessionId,room.room_id));
  }
  event(owner,eventId) {
    if(!id(eventId))fail('SOCIAL_EVENT_REQUIRED');
    this.rooms.recentEvents.sync(owner.lifeId,owner.sessionId);
    const event=this.rooms.recentEvents.store.event(eventId);
    if(!event||!this.rooms.recentEvents.scoped(owner.lifeId,owner.sessionId,event))fail('SOCIAL_EVENT_NOT_VISIBLE');
    return event;
  }
  contacts(owner,args={}) {
    fields(args,[]);const actors=new Map();
    for(const room of this.scoped(owner))for(const actor of room.participant_details.filter(p=>p.sender_id!==owner.lifeId)) {
      const row=actors.get(actor.sender_id)??{to:actor.display_name??actor.sender_id,display_name:actor.display_name,sender_type:actor.sender_type,private_available:false,public_available:false};
      if(room.room_type==='direct')row.private_available=true;
      if(room.room_type==='group'&&room.visibility==='shared')row.public_available=true;
      actors.set(actor.sender_id,row);
    }
    return {actors:[...actors.values()],public_broadcast_available:this.scoped(owner).some(r=>r.room_type==='group'&&r.visibility==='shared')};
  }
  read(owner,args) {fields(args,['event_id']);return socialView(this.event(owner,args.event_id));}
  messages(owner,args={}) {
    fields(args,['after','limit']);const {after=0,limit=50}=args;
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('SOCIAL_EVENT_PAGE_INVALID');
    this.rooms.recentEvents.sync(owner.lifeId,owner.sessionId);
    const visible=this.rooms.recentEvents.all(owner.lifeId).filter(e=>e.seq>after&&e.event_type==='communication'&&this.rooms.recentEvents.scoped(owner.lifeId,owner.sessionId,e));
    const page=visible.slice(0,limit);return {events:page.map(e=>({...socialView(e),event_seq:e.seq})),nextAfter:page.at(-1)?.seq??after,hasMore:visible.length>page.length};
  }
  configuration() {
    let value;try{value=existsSync(this.rooms.socialRoutingPath)?JSON.parse(readFileSync(this.rooms.socialRoutingPath,'utf8')):{version:1,private:{},public:{}};}catch{fail('SOCIAL_ROUTING_CONFIGURATION_INVALID');}
    if(value.version!==1||!value.private||!value.public)fail('SOCIAL_ROUTING_CONFIGURATION_INVALID');return value;
  }
  target(owner,value) {
    if(value==='everyone')return value;
    const actors=new Map(this.scoped(owner).flatMap(room=>room.participant_details.map(actor=>[actor.sender_id,actor])));
    const alias=this.configuration().aliases?.[value];
    const matches=[...actors.values()].filter(actor=>actor.sender_id===value||actor.display_name===value||actor.sender_id===alias);
    if(matches.length!==1)fail(matches.length?'SOCIAL_TARGET_AMBIGUOUS':'SOCIAL_TARGET_NOT_AVAILABLE');return matches[0].sender_id;
  }
  speak(owner,args,callId,occurredAt) {
    fields(args,['to','visibility','body','in_response_to']);
    if(!id(args.to)||!['private','public'].includes(args.visibility)||typeof args.body!=='string'||!args.body.trim()||Buffer.byteLength(args.body)>1024*1024)fail('SOCIAL_SPEECH_INVALID');
    const namedTarget=args.to;args={...args,to:this.target(owner,args.to)};
    if(args.to===owner.lifeId||args.visibility==='private'&&args.to==='everyone')fail('SOCIAL_TARGET_INVALID');
    if(args.to!=='everyone')this.rooms.principal(args.to);
    const source=args.in_response_to===undefined?null:this.event(owner,args.in_response_to);
    if(source&&source.event_type!=='communication')fail('SOCIAL_RESPONSE_REQUIRES_COMMUNICATION_EVENT');
    const eligible=this.scoped(owner).filter(room=>args.visibility==='private'
      ?room.room_type==='direct'&&room.participants.length===2&&room.participants.includes(args.to)
      :room.room_type==='group'&&room.visibility==='shared'&&(args.to==='everyone'||room.participants.includes(args.to)));
    if(!eligible.length)fail('SOCIAL_TARGET_NOT_AVAILABLE');
    if(!id(callId))fail('NATIVE_ACTION_ID_REQUIRED');
    // A distinct native call is a distinct speech, even about the same event.
    // Replaying the same persisted call remains idempotent.
    const messageId='native-send:'+owner.lifeId+':'+owner.sessionId+':'+callId;
    const old=this.rooms.recentMessageById(owner.lifeId,owner.sessionId,[messageId])[0];
    if(old&&(old.message.body!==args.body||old.message.inResponseTo!==(source?.event_id??null)||old.message.addressee!==args.to))fail('SOCIAL_INTENT_ALREADY_COMMITTED');
    const configured=this.configuration();
    const defaultId=args.visibility==='private'?configured.private[owner.lifeId]?.[args.to]:configured.public[owner.lifeId];
    const room=old?eligible.find(r=>r.room_id===old.room.room_id):eligible.find(r=>r.room_id===source?.conversation_id)
      ??eligible.find(r=>r.room_id===defaultId)??(eligible.length===1?eligible[0]:null);
    if(!room)fail(old?'SOCIAL_COMMITTED_ROUTE_NOT_AVAILABLE':'SOCIAL_ROUTE_AMBIGUOUS');
    const reply=source?.conversation_id===room.room_id?source.payload.message_id:undefined;
    const result=this.rooms.postForLife({...owner,occurredAt,semanticSpeech:true,args:{room_id:room.room_id,body:args.body,message_id:messageId,
      ...(reply?{reply_to:reply}:{}),inResponseTo:source?.event_id??null,addressee:args.to}});
    // The returned event reference must already be usable as factual evidence
    // in a same-turn finish. Publishing it does not expand the fixed input batch.
    this.rooms.recentEvents.sync(owner.lifeId,owner.sessionId);
    return {...socialView(result),to:args.to==='everyone'?'everyone':this.rooms.principal(args.to).display_name??namedTarget,visibility:args.visibility,in_response_to:source?.event_id??null};
  }
  result(owner,args) {
    fields(args,['event_id','message_id','in_response_to','inbox_id','operation_id','speech']);
    if(!args.operation_id&&args.speech?.in_response_to){
      const speech={...args.speech,to:this.target(owner,args.speech.to)};this.event(owner,speech.in_response_to);
      const found=this.rooms.recentMessageSources(owner.lifeId,owner.sessionId).find(x=>x.message.inResponseTo===speech.in_response_to&&x.message.sender_id===owner.lifeId&&
        x.message.origin_session_id===owner.sessionId&&x.message.addressee===speech.to&&x.message.body===speech.body&&
        (speech.visibility==='private'?x.room.room_type==='direct':x.room.room_type==='group'&&x.room.visibility==='shared'));
      return found?socialView(this.rooms.actionResultForLife({...owner,room_id:found.room.room_id,message_id:found.message.message_id})):{status:'unknown',reason:'original_speech_not_proven'};
    }
    let room_id,message_id=args.message_id;
    if(args.event_id){const event=this.event(owner,args.event_id);room_id=event.conversation_id;message_id=event.payload?.message_id;}
    if(args.operation_id)message_id='native-send:'+owner.lifeId+':'+owner.sessionId+':'+args.operation_id;
    if(args.in_response_to) {
      this.event(owner,args.in_response_to);
      const found=this.rooms.recentMessageSources(owner.lifeId,owner.sessionId).filter(x=>x.message.inResponseTo===args.in_response_to&&x.message.sender_id===owner.lifeId);
      return {results:found.map(x=>socialView(this.rooms.actionResultForLife({...owner,room_id:x.room.room_id,message_id:x.message.message_id}))),status:found.length?'confirmed_success':'unknown'};
    }
    if(room_id===undefined&&message_id){const found=this.rooms.recentMessageById(owner.lifeId,owner.sessionId,[message_id]).filter(x=>x.message.sender_id===owner.lifeId);if(found.length===1)room_id=found[0].room.room_id;}
    return socialView(this.rooms.actionResultForLife({...owner,room_id,message_id,...args.inbox_id?{inbox_id:args.inbox_id}:{}}));
  }
  decide(owner,args) {
    const input={...args};
    if(args.event_id){const event=this.event(owner,args.event_id);input.message_ref={room_id:event.conversation_id,message_id:event.payload.message_id};delete input.event_id;}
    if(input.message_ref?.event_id){const event=this.event(owner,input.message_ref.event_id);input.message_ref={room_id:event.conversation_id,message_id:event.payload.message_id};}
    return socialView(this.rooms.decideForLife({...input,lifeId:owner.lifeId,originSessionId:owner.sessionId,originTaskId:this.rooms.tasks?.forSession(owner.sessionId)?.task_id??null}));
  }
}
