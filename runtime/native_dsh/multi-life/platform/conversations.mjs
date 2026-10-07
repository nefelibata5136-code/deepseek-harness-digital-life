import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {freeze,copy,fail,LifeError} from '../contracts.mjs';
import {socialView} from './social.mjs';
import {RecentWorld} from '../recent-events/world.mjs';
import {ConversationStorage} from './conversation-storage.mjs';
import {migrateInputTruth,roomEffectResult,inputHealth} from './input-truth.mjs';

// Single Host writer. Messages, recipient inboxes and replies commit together.
// This is social history, never a private Memory store.
export class Conversations {
  #state;#root;#storage;#recentMessages=new Map();
  constructor({contexts,root,now=()=>Date.now(),tasks,migrationMarks={}}) {
    Object.assign(this,{contexts,now,tasks});this.#root=resolve(root);
    this.#storage=new ConversationStorage({root:this.#root,migrate:source=>{
      if(![1,2,3].includes(source.schemaVersion)||!source.rooms||Array.isArray(source.rooms))fail('INVALID_CONVERSATION_STORE');
      const previousSchema=source.schemaVersion;
      if(previousSchema===1)source=this.#migrate(source);
      if(!Number.isSafeInteger(source.nextMessageSeq)) {
        const messages=Object.values(source.rooms).flatMap(r=>r.messages).sort((a,b)=>String(a.observedAt??'').localeCompare(String(b.observedAt??''))||a.messageId.localeCompare(b.messageId));
        messages.forEach((m,index)=>m.timelineSeq=index+1);source.nextMessageSeq=messages.length+1;
      }
      this.#backfillHumanInputs(source);
      const migrated=migrateInputTruth(source,{marks:migrationMarks});
      if(previousSchema<3)migrated.state.input_truth_migration={source_schema:previousSchema,at:this.#at(),changes:migrated.provenance};
      return migrated;
    }});
    this.#state=this.#storage.state;
    try {
    if(this.#state.schemaVersion!==3)fail('INVALID_CONVERSATION_STORE');
    if(!this.#state.humans||!this.#state.inbox||!Number.isSafeInteger(this.#state.nextInboxSeq))fail('INVALID_CONVERSATION_STORE');
    for(const [id,room] of Object.entries(this.#state.rooms)) {
      if(room.conversationId!==id||!Array.isArray(room.messages)||!Array.isArray(room.members)||!room.sessionBindings)fail('INVALID_CONVERSATION_STORE');
      for(const m of room.messages)if(m.bodyHash!==this.#hash(m.body)||m.conversationId!==id)fail('CONVERSATION_EVIDENCE_CHANGED');
    }
    for(const item of Object.values(this.#state.inbox)) {
      this.contexts.registry.life(item.owner_life_id);
      if(!['pending','deferred','handled','ignored','revoked'].includes(item.status))fail('INVALID_INPUT_DISPOSITION');
      if(!this.#state.rooms[item.room_id]?.messages.some(m=>m.messageId===item.message_id))fail('INVALID_ROOM_INBOX');
    }
    const repaired=copy(this.#state);if(this.#backfillHumanInputs(repaired))this.#commit(repaired);
    for(const room of Object.values(this.#state.rooms))this.#recentMessage(room,null);
    this.recentEvents=new RecentWorld({rooms:this,root:resolve(root,'recent-events'),now});
    }catch(error){this.close();throw error;}
  }
  #at(){return new Date(this.now()).toISOString();}
  get socialRoutingPath(){return resolve(this.#root,'social-routing.json');}
  #hash(body){return createHash('sha256').update(body).digest('hex');}
  #commit(next) {
    try{this.#storage.commit(next);}catch(error) {
      // Only durable readback of the unchanged revision proves this write did
      // not commit. Transport or unreadable storage remains an unknown result.
      let row;try{row=this.#storage.db.prepare('SELECT revision,data FROM conversation_state WHERE singleton=1').get();}catch{}
      if(row?.revision===this.#storage.revision&&row.data===JSON.stringify(this.#state)) {
        const rejected=new LifeError('ROOM_ACTION_NOT_COMMITTED');rejected.cause=error;
        rejected.effect_result={status:'confirmed_failure',kind:'room_message',committed:false,error_code:rejected.code};throw rejected;
      }
      throw error;
    }
    this.#state=next;
  }
  close(){if(this.closed)return;this.closed=true;try{this.recentEvents?.store.close();}finally{this.#storage?.close();}}
  #migrate(source) {
    const next=copy(source);Object.assign(next,{schemaVersion:2,humans:{},inbox:{},nextInboxSeq:1});
    for(const r of Object.values(next.rooms)) {
      r.roomType=r.members.length>2?'group':'direct';r.createdAt=r.observedAt??null;
      for(const member of r.members) {
        member.epoch=randomUUID();
        if(member.principalId.startsWith('human:'))next.humans[member.principalId]??={sender_id:member.principalId,sender_type:'human',life_id:null,display_name:null};
      }
      for(const m of r.messages) {
        const life=m.senderPrincipalId.startsWith('human:')?null:this.contexts.registry.life(m.senderPrincipalId);
        m.sender={sender_id:m.senderPrincipalId,sender_type:life?'life':'human',life_id:life?.lifeId??null,display_name:life?.displayName??null};
        m.originTaskId=null;m.timestamp=m.sentAt??null;
        for(const member of r.members.filter(x=>x.removedAt===null&&!x.principalId.startsWith('human:')&&x.principalId!==m.senderPrincipalId&&m.seq>=x.firstVisibleSeq))
          this.#enqueue(next,r,m,member,m.receipts?.[member.principalId]?'needs_review':'queued');
      }
    }
    return next; // Native admission was never a semantic completion decision.
  }
  #humanInboxId(room,message,member){return 'inbox-human:'+this.#hash(JSON.stringify([room.conversationId,message.messageId,member.principalId,member.epoch]));}
  #backfillHumanInputs(state) {
    let added=0;
    for(const room of Object.values(state.rooms))for(const message of room.messages) {
      if(message.sender?.sender_type!=='human'||!message.senderPrincipalId?.startsWith('human:'))continue;
      for(const member of room.members.filter(member=>member.removedAt===null&&!member.principalId.startsWith('human:')&&message.seq>=member.firstVisibleSeq&&
        (!Array.isArray(message.eventAudience)||message.eventAudience.includes(member.principalId)))) {
        try{this.contexts.registry.life(member.principalId);}catch{continue;}
        if(Object.values(state.inbox).some(item=>item.owner_life_id===member.principalId&&item.room_id===room.conversationId&&item.message_id===message.messageId&&item.membership_epoch===member.epoch))continue;
        const item=this.#enqueue(state,room,message,member);
        item.received_at=message.observedAt??item.received_at;
        const reply=room.messages.find(reply=>reply.senderPrincipalId===member.principalId&&reply.replyTo===message.messageId);
        if(reply){item.reply_message_id=reply.messageId;item.reply_body_hash=reply.bodyHash;item.reply_receipt=this.#effectReceipt(reply);}
        item.recent_event_id='event-room-'+this.#hash(room.conversationId+'\0'+message.messageId);
        item.migration={from_status:'native-human-history',reason:'legacy-human-input-without-central-row',already_delivered:'unknown',auto_delivery:false};added++;
      }
    }
    return added;
  }
  registerHuman({sender_id,display_name}) {
    if(typeof sender_id!=='string'||!/^human:[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(sender_id)||typeof display_name!=='string'||!display_name.trim())fail('EXPLICIT_HUMAN_IDENTITY_REQUIRED');
    const value={sender_id,sender_type:'human',life_id:null,display_name},old=this.#state.humans[sender_id];
    if(old?.display_name&&old.display_name!==display_name)fail('HUMAN_IDENTITY_IMMUTABLE');
    const next=copy(this.#state);next.humans[sender_id]=value;this.#commit(next);return freeze(copy(value));
  }
  principal(id) {
    if(this.#state.humans[id])return freeze(copy(this.#state.humans[id]));
    const m=this.contexts.registry.life(id);return freeze({sender_id:id,sender_type:'life',life_id:id,display_name:m.displayName??null});
  }
  #room(id){const room=this.#state.rooms[id];if(!room)fail('CONVERSATION_NOT_VISIBLE');return room;}
  #id(args){return args.room_id??args.conversationId;}
  #member(room,id){const m=room.members.find(x=>x.principalId===id&&x.removedAt===null);if(!m)fail('CONVERSATION_NOT_VISIBLE');return m;}
  #reader(room,id){const reader=room.members.find(x=>x.principalId===id&&x.removedAt===null)??room.observers?.find(x=>x.principalId===id&&x.removedAt===null);if(!reader)fail('CONVERSATION_NOT_VISIBLE');return reader;}
  #summary(r,readerId) {
    const members=r.members.filter(m=>m.removedAt===null);
    return {room_id:r.conversationId,room_type:r.roomType,created_at:r.createdAt,visibility:r.visibility,
      access:{mode:'members',membership_revision:r.membershipRevision,read_only_observers:(r.observers??[]).filter(o=>o.removedAt===null).map(o=>({...this.principal(o.principalId),granted_at:o.joinedAt})),
        ...readerId===undefined?{}:{can_send:members.some(m=>m.principalId===readerId)}},participants:members.map(m=>m.principalId),
      participant_details:members.map(m=>({...this.principal(m.principalId),membership_epoch:m.epoch,joined_at:m.joinedAt})),
      conversationId:r.conversationId,membershipRevision:r.membershipRevision};
  }
  #message(m){return {...copy(m),message_id:m.messageId,room_id:m.conversationId,...m.sender,timestamp:m.timestamp??null,
    speech_visibility:m.conversationType==='direct'?'private':this.#state.rooms[m.conversationId]?.visibility==='shared'?'public':'private_group',
    timeline_seq:m.timelineSeq,origin_task_id:m.originTaskId??null,origin_session_id:m.originSessionId??null,reply_to:m.replyTo,body_hash:m.bodyHash,observed_at:m.observedAt,
    order_semantics:{seq:'room-local-contiguous',timeline_seq:'global-durable-commit-order; authorized views may contain gaps'}};}
  defineRoom({room_id,conversationId=room_id??randomUUID(),participants,visibility='private',room_type}) {
    if(this.#state.rooms[conversationId])fail('CONVERSATION_ALREADY_EXISTS');
    if(typeof conversationId!=='string'||!conversationId||!Array.isArray(participants)||!participants.length||new Set(participants).size!==participants.length||!['private','shared'].includes(visibility))fail('INVALID_ROOM_MEMBERSHIP');
    for(const id of participants)this.principal(id);
    const roomType=room_type??(participants.length>2?'group':'direct');if(!['direct','group'].includes(roomType)||roomType==='direct'&&participants.length>2)fail('INVALID_ROOM_TYPE');
    const at=this.#at(),next=copy(this.#state);
    next.rooms[conversationId]={conversationId,visibility,roomType,createdAt:at,membershipRevision:1,members:participants.map(principalId=>({principalId,epoch:randomUUID(),firstVisibleSeq:1,joinedAt:at,removedAt:null})),messages:[],sessionBindings:{},observedAt:at};
    this.#commit(next);return freeze(this.#summary(next.rooms[conversationId]));
  }
  setRoomVisibility({room_id,visibility,expected_revision}){
    const room=this.#room(room_id);
    if(room.roomType!=='group'||!['private','shared'].includes(visibility)||expected_revision!==room.membershipRevision)fail('ROOM_VISIBILITY_UPDATE_INVALID');
    if(room.visibility===visibility)return freeze(this.#summary(room));
    const next=copy(this.#state),updated=next.rooms[room_id];
    updated.visibility=visibility;updated.membershipRevision++;updated.observedAt=this.#at();
    updated.visibilityChanges=[...(updated.visibilityChanges??[]),{from:room.visibility,to:visibility,at:updated.observedAt}];
    this.#commit(next);return freeze(this.#summary(updated));
  }
  assertMember(roomId,principalId){return freeze(copy(this.#member(this.#room(roomId),principalId)));}
  assertReader(roomId,principalId){return freeze(copy(this.#reader(this.#room(roomId),principalId)));}
  grantInitialObserver({room_id,principalId}) {
    const room=this.#room(room_id);
    if(this.principal(principalId).sender_type!=='human')fail('EXPLICIT_ROOM_OBSERVER_REQUIRED');
    if(room.observers?.some(o=>o.principalId===principalId))return freeze(this.#summary(room,principalId));
    return this.setObserver({room_id,principalId,present:true,expectedRevision:room.membershipRevision});
  }
  setObserver({room_id,principalId,present,expectedRevision,fromSeq=1}) {
    const room=this.#room(room_id);if(room.membershipRevision!==expectedRevision)fail('ROOM_REVISION_CONFLICT');
    if(this.principal(principalId).sender_type!=='human'||typeof present!=='boolean'||!Number.isSafeInteger(fromSeq)||fromSeq<1||fromSeq>room.messages.length+1)fail('EXPLICIT_ROOM_OBSERVER_REQUIRED');
    const next=copy(this.#state),r=next.rooms[room_id];r.observers??=[];const current=r.observers.find(o=>o.principalId===principalId&&o.removedAt===null);
    if(present&&!current)r.observers.push({principalId,epoch:randomUUID(),firstVisibleSeq:fromSeq,joinedAt:this.#at(),removedAt:null});
    if(!present&&current)current.removedAt=this.#at();r.membershipRevision++;this.#commit(next);return freeze(this.#summary(r,principalId));
  }
  setMembership({conversationId,room_id,principalId,present,expectedRevision}) {
    conversationId??=room_id;const room=this.#room(conversationId);if(room.membershipRevision!==expectedRevision)fail('ROOM_REVISION_CONFLICT');this.principal(principalId);
    const next=copy(this.#state),r=next.rooms[conversationId],current=r.members.find(m=>m.principalId===principalId&&m.removedAt===null),at=this.#at();
    if(present&&!current){if(r.roomType==='direct'&&r.members.filter(m=>m.removedAt===null).length>=2)r.roomType='group';r.members.push({principalId,epoch:randomUUID(),firstVisibleSeq:r.messages.length+1,joinedAt:at,removedAt:null});}
    if(!present&&current){current.removedAt=at;for(const item of Object.values(next.inbox))if(item.room_id===conversationId&&item.owner_life_id===principalId&&item.membership_epoch===current.epoch&&!['ignored','revoked','handled'].includes(item.status)){item.status='revoked';item.revision++;item.updated_at=at;}}
    r.membershipRevision++;this.#commit(next);return freeze(this.#summary(r));
  }
  list(c){return this.listForPrincipal(this.contexts.require(c).lifeId);}
  listForPrincipal(id){this.principal(id);return Object.values(this.#state.rooms).filter(r=>r.members.some(m=>m.principalId===id&&m.removedAt===null)||r.observers?.some(o=>o.principalId===id&&o.removedAt===null)).map(r=>freeze(this.#summary(r,id)));}
  read(c,args){return this.readForPrincipal(this.contexts.require(c).lifeId,args);}
  timeline(c,args={}){return this.timelineForPrincipal(this.contexts.require(c).lifeId,args);}
  timelineForPrincipal(id,{after=0,limit=50}={}) {
    this.principal(id);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('EXPLICIT_TIMELINE_PAGE_REQUIRED');
    const visible=Object.values(this.#state.rooms).flatMap(r=>{let reader;try{reader=this.#reader(r,id);}catch{}return reader?r.messages.filter(m=>m.seq>=reader.firstVisibleSeq&&m.timelineSeq>after):[];}).sort((a,b)=>a.timelineSeq-b.timelineSeq),messages=visible.slice(0,limit).map(m=>freeze(this.#message(m)));
    return {messages,nextAfter:messages.at(-1)?.timeline_seq??after,hasMore:visible.length>messages.length,order:'host-committed-timeline',time_zone:'timestamps-are-UTC'};
  }
  #recentMessage(room,id) {
    let index=this.#recentMessages.get(room.conversationId);
    if(!index){index={count:0,byId:new Map()};this.#recentMessages.set(room.conversationId,index);}
    // Build once after load; afterwards index only the appended suffix.
    for(let i=index.count;i<room.messages.length;i++){const message=room.messages[i];index.byId.set(message.messageId,message);}
    index.count=room.messages.length;return index.byId.get(id);
  }
  recentMessageById(lifeId,sessionId,ids) {
    return Object.values(this.#state.rooms).flatMap(room=>{
      let member;try{member=this.#member(room,lifeId);}catch{return [];}
      if(!this.recentRoomScope(lifeId,sessionId,room.conversationId))return [];
      return [...new Set(ids.filter(id=>typeof id==='string'))].map(id=>this.#recentMessage(room,id)).filter(message=>message&&message.seq>=member.firstVisibleSeq).map(message=>({room:{...this.#summary(room,lifeId)},message:this.#message(message),audience:message.eventAudience??room.members.filter(m=>m.firstVisibleSeq<=message.seq&&(m.removedAt===null||Date.parse(m.removedAt)>=Date.parse(message.observedAt))).map(m=>m.principalId)}));
    });
  }
  recentEventVisible(lifeId,event) {
    if(!event.visibility?.members?.includes(lifeId))return false;
    if(event.event_type!=='communication')return true;
    try {const room=this.#room(event.conversation_id),member=this.#member(room,lifeId);
      return event.payload.room_seq>=member.firstVisibleSeq&&this.#recentMessage(room,event.payload.message_id)?.bodyHash===event.payload.body_hash;
    }catch{return false;}
  }
  recentRoomScope(lifeId,sessionId,roomId) {
    const room=this.#room(roomId),authority=this.contexts.registry.life(lifeId).authoritySessionId;
    return (room.sessionBindings[lifeId]??authority)===sessionId;
  }
  resolveRecentActionTarget({lifeId,sessionId,action,resolvedRoomId}) {
    const owner=this.contexts.registry.assertTarget(lifeId,sessionId);
    if(owner.role==='delegate')fail('DELEGATE_SOCIAL_SEND_DENIED');
    let room;
    if(action.to_actor_id!==undefined) {
      if(action.to_actor_id===lifeId)fail('RECENT_ACTION_TARGET_NOT_AVAILABLE');
      const eligible=Object.values(this.#state.rooms).filter(candidate=>candidate.roomType==='direct'&&
        candidate.members.some(member=>member.principalId===lifeId&&member.removedAt===null)&&
        candidate.members.some(member=>member.principalId===action.to_actor_id&&member.removedAt===null)&&
        this.recentRoomScope(lifeId,sessionId,candidate.conversationId));
      if(resolvedRoomId!==undefined)room=eligible.find(candidate=>candidate.conversationId===resolvedRoomId);
      else {
        if(eligible.length>1)fail('RECENT_ACTION_TARGET_AMBIGUOUS');
        room=eligible[0];
      }
      if(!room)fail('RECENT_ACTION_TARGET_NOT_AVAILABLE');
    }else {
      const id=action.public_area_id??action.conversation_id;
      if(resolvedRoomId!==undefined&&resolvedRoomId!==id)fail('RECENT_ACTION_ROUTE_CHANGED');
      room=this.#room(id);this.#member(room,lifeId);
      if(!this.recentRoomScope(lifeId,sessionId,id))fail('DELIVERY_ACTION_SESSION_MISMATCH');
      if(action.public_area_id!==undefined&&(room.roomType!=='group'||room.visibility!=='shared'))fail('PUBLIC_AREA_REQUIRES_SHARED_GROUP');
    }
    const member=this.#member(room,lifeId);
    if(action.reply_to!==undefined&&!room.messages.some(message=>message.messageId===action.reply_to&&message.seq>=member.firstVisibleSeq))fail('REPLY_TARGET_NOT_VISIBLE');
    return room.conversationId;
  }
  recentMessageSources(lifeId,sessionId,{after=0}={}) {
    this.contexts.registry.assertTarget(lifeId,sessionId);
    return Object.values(this.#state.rooms).flatMap(room=>{
      let member;try{member=this.#member(room,lifeId);}catch{return [];}
      if(!this.recentRoomScope(lifeId,sessionId,room.conversationId))return [];
      let low=0,high=room.messages.length;
      while(low<high){const middle=(low+high)>>>1;if(room.messages[middle].timelineSeq<=after)low=middle+1;else high=middle;}
      return room.messages.slice(low).filter(message=>message.seq>=member.firstVisibleSeq).map(message=>({
        room:{...this.#summary(room,lifeId),execution_session_id:room.sessionBindings[lifeId]??null},message:this.#message(message),
        audience:message.eventAudience??room.members.filter(m=>m.firstVisibleSeq<=message.seq&&(m.removedAt===null||Date.parse(m.removedAt)>=Date.parse(message.observedAt))).map(m=>m.principalId)
      }));
    }).sort((a,b)=>a.message.timeline_seq-b.message.timeline_seq);
  }
  recentInboxItems(lifeId,sessionId) {
    return Object.values(this.#state.inbox).filter(item=>item.owner_life_id===lifeId).filter(item=>{
      try{this.#visibleItem(item.inbox_id,lifeId);return this.recentRoomScope(lifeId,sessionId,item.room_id);}catch{return false;}
    }).map(item=>this.#viewItem(item));
  }
  healthForLife({lifeId,sessionId,...options}) {
    this.contexts.registry.life(lifeId);if(sessionId!==undefined)this.contexts.registry.assertTarget(lifeId,sessionId);
    const items=Object.values(this.#state.inbox).filter(item=>item.owner_life_id===lifeId).filter(item=>{
      try{this.#visibleItem(item.inbox_id,lifeId);return sessionId===undefined||this.recentRoomScope(lifeId,sessionId,item.room_id);}catch{return false;}
    });
    return freeze(inputHealth(items,{...options,rooms:this.#state.rooms,now:this.now()}));
  }
  deferRecentEvent({lifeId,sessionId,event,until}) {
    if(event.event_type!=='communication')return;
    const item=this.recentInboxItems(lifeId,sessionId).find(item=>item.message_id===event.payload.message_id&&item.room_id===event.conversation_id);
    if(!item||['ignored','revoked','handled'].includes(item.status)||item.status==='deferred'&&item.defer_until===until)return;
    return this.decideForLife({lifeId,inbox_id:item.inbox_id,expectedRevision:item.revision,action:'defer',until,originSessionId:sessionId,originTaskId:this.tasks?.forSession(sessionId)?.task_id??null});
  }
  completeRecentBatch({lifeId,sessionId,batch,result}) {
    this.contexts.registry.assertTarget(lifeId,sessionId);
    const completed=new Set(result.completed_event_ids??[]);if(!completed.size)return;
    const next=copy(this.#state);let changed=false;
    for(const event of batch.events) {
      if(event.event_type!=='communication'||!completed.has(event.event_id))continue;
      const item=Object.values(next.inbox).find(item=>item.owner_life_id===lifeId&&item.room_id===event.conversation_id&&item.message_id===event.payload.message_id);
      if(item?.status==='deferred')fail('ACK_CONFLICTS_WITH_INPUT_DECISION');
    }
    for(const event of batch.events) {
      if(event.event_type!=='communication'||!completed.has(event.event_id))continue;
      const item=Object.values(next.inbox).find(item=>item.owner_life_id===lifeId&&item.room_id===event.conversation_id&&item.message_id===event.payload.message_id);
      if(!item||['ignored','revoked','handled'].includes(item.status))continue;
      this.#visibleItem(item.inbox_id,lifeId);if(!this.recentRoomScope(lifeId,sessionId,item.room_id))fail('DELIVERY_BATCH_SESSION_MISMATCH');
      Object.assign(item,{status:'handled',requested:false,last_decision:'complete',decision_at:this.#at(),handled_batch_id:batch.batch_id,
        disposition:result.disposition,updated_at:this.#at(),revision:item.revision+1,decision_revision:(item.decision_revision??1)+1});changed=true;
    }
    if(changed)this.#commit(next);
  }
  readForPrincipal(id,args) {
    const {after=0,limit=50}=args,r=this.#room(this.#id(args)),member=this.#reader(r,id);
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('EXPLICIT_ROOM_PAGE_REQUIRED');
    const visible=r.messages.filter(m=>m.seq>after&&m.seq>=member.firstVisibleSeq),messages=visible.slice(0,limit).map(m=>freeze(this.#message(m)));
    return {room:freeze(this.#summary(r,id)),messages,nextAfter:messages.at(-1)?.seq??after,hasMore:visible.length>messages.length,membershipRevision:r.membershipRevision};
  }
  #enqueue(next,r,m,member,status='pending') {
    const id=m.sender?.sender_type==='human'?this.#humanInboxId(r,m,member):randomUUID();if(next.inbox[id])fail('INBOX_ID_CONFLICT');
    return next.inbox[id]={inbox_id:id,inbox_seq:next.nextInboxSeq++,owner_life_id:member.principalId,room_id:r.conversationId,message_id:m.messageId,membership_epoch:member.epoch,
      status,requested:false,revision:1,decision_revision:1,received_at:this.#at(),updated_at:this.#at(),defer_until:null,reply_message_id:null,attempt:null};
  }
  #appendTo(next,id,args,trusted={}) {
    const room=next.rooms[this.#id(args)];if(!room)fail('CONVERSATION_NOT_VISIBLE');const member=this.#member(room,id);
    const {body,replyTo=args.reply_to??null,originSessionId=null,originTaskId=null}=args,messageId=args.message_id??args.messageId??randomUUID();
    if(typeof body!=='string'||!body.length||Buffer.byteLength(body)>1024*1024||typeof messageId!=='string'||!messageId)fail('INVALID_ROOM_MESSAGE');
    const old=room.messages.find(x=>x.messageId===messageId),bodyHash=this.#hash(body);
    if(old){if(old.senderPrincipalId!==id||old.bodyHash!==bodyHash||old.replyTo!==replyTo||old.originTaskId!==originTaskId||
      (old.inResponseTo??null)!==(args.inResponseTo??null)||(old.addressee??null)!==(args.addressee??null))fail('MESSAGE_ID_CONFLICT');return old;}
    if(replyTo){const target=room.messages.find(x=>x.messageId===replyTo);if(!target||target.seq<member.firstVisibleSeq)fail('REPLY_TARGET_NOT_VISIBLE');}
    const at=this.#at(),timestamp=trusted.occurredAt??at;
    if(typeof timestamp!=='string'||!Number.isFinite(Date.parse(timestamp)))fail('TRUSTED_MESSAGE_TIME_INVALID');
    const m={messageId,conversationId:room.conversationId,seq:room.messages.length+1,timelineSeq:next.nextMessageSeq++,senderPrincipalId:id,sender:copy(this.principal(id)),sentAt:timestamp,timestamp,observedAt:at,replyTo,originSessionId,originTaskId,bodyHash,body,receipts:{},
      eventAudience:room.members.filter(member=>member.removedAt===null).map(member=>member.principalId),conversationType:room.roomType,conversationDisplayName:room.displayName??room.conversationId};
    if(args.inResponseTo!==undefined)m.inResponseTo=args.inResponseTo;
    if(args.addressee!==undefined)m.addressee=args.addressee;
    room.messages.push(m);
    for(const receiver of room.members.filter(x=>x.removedAt===null&&!x.principalId.startsWith('human:')&&x.principalId!==id))this.#enqueue(next,room,m,receiver);
    return m;
  }
  #guardSender(args){if(['senderPrincipalId','sender_id','sender_type','life_id','display_name','sender','originSessionId','origin_session_id','originTaskId','origin_task_id','timestamp','sentAt'].some(k=>args[k]!==undefined))fail('SENDER_IS_HOST_BOUND');}
  post(c,args) {
    c=this.contexts.require(c);if(c.role==='delegate')fail('DELEGATE_SOCIAL_SEND_DENIED');this.#guardSender(args);
    const reply=this.#replyTarget(c.lifeId,args);if(reply)return this.#replyViaSend(reply,{...args,lifeId:c.lifeId,originSessionId:c.sessionId,originTaskId:this.tasks?.forSession(c.sessionId)?.task_id??null});
    if(!args.message_id&&!args.messageId&&c.callId)args={...args,message_id:'native-send:'+c.lifeId+':'+c.sessionId+':'+c.callId};
    const next=copy(this.#state),m=this.#appendTo(next,c.lifeId,{...args,originSessionId:c.sessionId,originTaskId:this.tasks?.forSession(c.sessionId)?.task_id??null});
    this.#commit(next);return freeze({...this.#message(m),effect_result:this.#effectReceipt(m)});
  }
  postForLife({lifeId,sessionId,args,occurredAt,callId,semanticSpeech=false}) {
    const row=this.contexts.registry.assertTarget(lifeId,sessionId);if(row.role==='delegate')fail('DELEGATE_SOCIAL_SEND_DENIED');this.#guardSender(args);
    const reply=this.#replyTarget(lifeId,args);if(reply&&!semanticSpeech)return this.#replyViaSend(reply,{...args,lifeId,originSessionId:sessionId,originTaskId:this.tasks?.forSession(sessionId)?.task_id??null,occurredAt});
    if(!args.message_id&&!args.messageId&&callId)args={...args,message_id:'native-send:'+lifeId+':'+sessionId+':'+callId};
    const next=copy(this.#state),m=this.#appendTo(next,lifeId,{...args,originSessionId:sessionId,originTaskId:this.tasks?.forSession(sessionId)?.task_id??null},{occurredAt});
    this.#commit(next);return freeze({...this.#message(m),effect_result:this.#effectReceipt(m)});
  }
  bindReceiver({lifeId,room_id,sessionId}) {
    this.#member(this.#room(room_id),lifeId);const row=this.contexts.registry.assertTarget(lifeId,sessionId);
    if(row.role==='delegate')fail('DELEGATE_ROOM_PROCESSING_DENIED');
    const next=copy(this.#state);next.rooms[room_id].sessionBindings[lifeId]=sessionId;this.#commit(next);
    return {room_id,owner_life_id:lifeId,execution_session_id:sessionId};
  }
  postHuman(id,args){if(this.principal(id).sender_type!=='human')fail('AUTHENTICATED_HUMAN_REQUIRED');this.#guardSender(args);const next=copy(this.#state),m=this.#appendTo(next,id,args);this.#commit(next);return freeze(this.#message(m));}
  recordHumanTimeline({principalId,lifeId,args,occurredAt,sessionId,requestId}) {
    if(this.principal(principalId).sender_type!=='human')fail('AUTHENTICATED_HUMAN_REQUIRED');this.contexts.registry.life(lifeId);
    const room=this.#room(this.#id(args)),member=this.#member(room,lifeId);this.#guardSender(args);
    sessionId??=this.contexts.registry.life(lifeId).authoritySessionId;this.contexts.registry.assertTarget(lifeId,sessionId);
    requestId??=args.message_id??args.messageId;
    if(typeof requestId!=='string'||!requestId||(args.message_id??args.messageId)!==requestId)fail('NATIVE_HUMAN_REFERENCE_CONFLICT');
    const next=copy(this.#state),message=this.#appendTo(next,principalId,args,{occurredAt});
    const item=Object.values(next.inbox).find(item=>item.owner_life_id===lifeId&&item.room_id===room.conversationId&&item.message_id===message.messageId&&item.membership_epoch===member.epoch)??this.#enqueue(next,next.rooms[room.conversationId],message,member);
    const ingress={session_id:sessionId,request_id:requestId};
    if(item.native_ingress&&JSON.stringify(item.native_ingress)!==JSON.stringify(ingress))fail('NATIVE_HUMAN_REFERENCE_CONFLICT');
    // This reserves the existing native prompt route before its admission; it
    // does not claim the native input ran, completed, or produced any effect.
    if(!item.native_ingress){item.native_ingress=ingress;item.revision++;item.updated_at=this.#at();}
    if(JSON.stringify(next)!==JSON.stringify(this.#state))this.#commit(next);
    return freeze({...this.#message(message),inbox_id:item.inbox_id,native_ingress:ingress});
  }
  #visibleItem(id,lifeId) {
    const item=this.#state.inbox[id];if(!item||item.owner_life_id!==lifeId)fail('INBOX_NOT_VISIBLE');
    const room=this.#room(item.room_id),member=this.#member(room,lifeId),message=room.messages.find(m=>m.messageId===item.message_id);
    if(member.epoch!==item.membership_epoch||!message||message.seq<member.firstVisibleSeq||item.status==='revoked')fail('INBOX_MEMBERSHIP_REVOKED');
    return {item,room,message};
  }
  #token(item){return 'decision:'+Buffer.from(JSON.stringify([item.inbox_id,item.membership_epoch,item.decision_revision??1])).toString('base64url');}
  #viewItem(item){const value=copy(item),summary=attempt=>{if(!attempt)return attempt;const {native_message,...metadata}=attempt;return {...metadata,native_message_id:native_message?.id??metadata.native_message_id,
    model_admission_durability:native_message?.source?.modelAdmissionDurability??metadata.model_admission_durability??null};};
    value.attempt=summary(value.attempt);if(value.previous_attempts)value.previous_attempts=value.previous_attempts.map(summary);
    const room=this.#room(item.room_id),bound=room.sessionBindings[item.owner_life_id];
    return freeze({...value,effect_result:roomEffectResult(item,this.#state.rooms)??{status:'no_action',kind:'room_message',inbox_id:item.inbox_id},
    health_notes:inputHealth([item],{rooms:this.#state.rooms,now:this.now()}),execution_session_id:bound??this.contexts.registry.life(item.owner_life_id).authoritySessionId,execution_binding:bound?'room-explicit':'registry-authority-default',
    decision_revision:item.decision_revision??1,decision_token:this.#token(item),message_ref:{room_id:item.room_id,message_id:item.message_id},
    received_at_semantics:'durably-enqueued; not a read receipt or model thinking timestamp',message:this.#message(this.#room(item.room_id).messages.find(m=>m.messageId===item.message_id))});}
  #replyTarget(lifeId,args){const target=args.reply_to??args.replyTo;if(!target)return null;return Object.values(this.#state.inbox).find(i=>i.owner_life_id===lifeId&&i.room_id===this.#id(args)&&i.message_id===target&&i.status!=='revoked')??null;}
  #effectReceipt(message){return {status:'confirmed_success',kind:'room_message',room_id:message.conversationId,message_id:message.messageId,
    body_hash:message.bodyHash,reply_to:message.replyTo,observed_at:message.observedAt,committed:true};}
  #replyViaSend(item,args) {
    this.#visibleItem(item.inbox_id,args.lifeId);
    if(typeof args.body!=='string'||!args.body.length||Buffer.byteLength(args.body)>1024*1024)fail('INVALID_ROOM_MESSAGE');
    const bodyHash=this.#hash(args.body),room=this.#room(item.room_id);
    const actual=room.messages.filter(m=>m.senderPrincipalId===args.lifeId&&m.replyTo===item.message_id);
    const previous=actual.find(m=>m.messageId===item.reply_message_id)??actual[0];
    if(previous&&previous.bodyHash!==bodyHash)fail('REPLY_ALREADY_COMMITTED_USE_NEW_MESSAGE_FOR_FOLLOWUP');
    const effect=roomEffectResult(item,this.#state.rooms);
    if(!previous&&effect?.status==='unknown')fail('REPLY_OUTCOME_UNKNOWN_READ_ACTION_RESULT');
    const next=copy(this.#state),stored=next.inbox[item.inbox_id];
    const message=previous??this.#appendTo(next,args.lifeId,{room_id:item.room_id,body:args.body,
      message_id:'inbox-reply:'+item.inbox_id+':'+item.membership_epoch,reply_to:item.message_id,
      originSessionId:args.originSessionId,originTaskId:args.originTaskId,inResponseTo:args.inResponseTo,addressee:args.addressee},{occurredAt:args.occurredAt});
    const receipt=this.#effectReceipt(message);
    if(!previous||stored.reply_message_id!==message.messageId||JSON.stringify(stored.reply_receipt)!==JSON.stringify(receipt)) {
      stored.reply_message_id=message.messageId;stored.reply_body_hash=message.bodyHash;stored.reply_receipt=receipt;
      stored.updated_at=this.#at();stored.revision++;this.#commit(next);
    }
    return freeze({...this.#message(message),inbox_id:item.inbox_id,inbox_status:stored.status,reply_path:'inbox-reply-transaction',effect_result:receipt});
  }
  actionResultForLife({lifeId,sessionId,room_id,message_id,reply_to,inbox_id}) {
    this.contexts.registry.life(lifeId);if(sessionId!==undefined)this.contexts.registry.assertTarget(lifeId,sessionId);
    let item;if(inbox_id!==undefined){item=this.#visibleItem(inbox_id,lifeId).item;if(room_id!==undefined&&room_id!==item.room_id||reply_to!==undefined&&reply_to!==item.message_id)fail('ACTION_RESULT_REFERENCE_CONFLICT');room_id=item.room_id;reply_to=item.message_id;if(message_id===undefined&&item.reply_message_id)message_id=item.reply_message_id;}
    if(room_id===undefined&&message_id!==undefined) {
      const matches=Object.values(this.#state.rooms).filter(room=>room.messages.some(m=>m.messageId===message_id&&m.senderPrincipalId===lifeId));
      if(matches.length!==1)return freeze({status:'unknown',kind:'room_message',message_id,reason:'room-reference-required'});room_id=matches[0].conversationId;
    }
    if(room_id===undefined)fail('ACTION_RESULT_REFERENCE_REQUIRED');
    const room=this.#room(room_id),member=this.#member(room,lifeId);
    if(reply_to!==undefined&&!room.messages.some(m=>m.messageId===reply_to&&m.seq>=member.firstVisibleSeq))fail('REPLY_TARGET_NOT_VISIBLE');
    item??=Object.values(this.#state.inbox).find(i=>i.owner_life_id===lifeId&&i.room_id===room_id&&i.message_id===reply_to&&i.membership_epoch===member.epoch&&i.status!=='revoked');
    const actual=room.messages.find(m=>m.senderPrincipalId===lifeId&&m.seq>=member.firstVisibleSeq&&
      (message_id!==undefined?m.messageId===message_id:reply_to!==undefined&&m.replyTo===reply_to));
    if(actual) {
      if(reply_to!==undefined&&actual.replyTo!==reply_to)fail('ACTION_RESULT_REFERENCE_CONFLICT');
      if(actual.bodyHash!==this.#hash(actual.body))return freeze({status:'unknown',kind:'room_message',room_id,message_id:actual.messageId,reason:'room-message-evidence-conflict'});
      return freeze({...this.#effectReceipt(actual),...item?{inbox_id:item.inbox_id}:{}});
    }
    if(message_id===undefined&&item&&!item.reply_message_id&&!item.reply_receipt)return freeze({status:'no_action',kind:'room_message',room_id,reply_to,inbox_id:item.inbox_id});
    return freeze({status:'unknown',kind:'room_message',room_id,message_id:message_id??item?.reply_message_id??null,reply_to:reply_to??null,
      ...item?{inbox_id:item.inbox_id}:{},reason:'referenced-room-message-missing'});
  }
  receive(c,args={}){const lifeId=this.contexts.require(c).lifeId;if(args.lifeId!==undefined||args.owner_life_id!==undefined)fail('INBOX_OWNER_IS_CONTEXT_BOUND');return this.inboxForLife({...args,lifeId});}
  inboxForLife({lifeId,sessionId,executionOnly=false,after=0,limit=50,includeTerminal=false,includeUnsettledTerminal=false}) {
    if(typeof executionOnly!=='boolean'||executionOnly&&typeof sessionId!=='string')fail('SCHEDULER_SESSION_REQUIRED');
    if(sessionId!==undefined)this.contexts.registry.assertTarget(lifeId,sessionId);
    const authoritySessionId=this.contexts.registry.life(lifeId).authoritySessionId;if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('EXPLICIT_INBOX_PAGE_REQUIRED');
    const visible=Object.values(this.#state.inbox).filter(i=>i.owner_life_id===lifeId&&i.inbox_seq>after&&(includeTerminal||!['ignored','revoked','handled'].includes(i.status)||includeUnsettledTerminal&&['prepared','absent','pending','running','interrupted','ambiguous'].includes(i.attempt?.state)))
      .filter(i=>sessionId===undefined||(this.#state.rooms[i.room_id]?.sessionBindings[lifeId]??authoritySessionId)===sessionId)
      // Scheduling is not the semantic Inbox view. Settled execution remains
      // recorded and readable even when its input is still pending/deferred.
      .filter(i=>!executionOnly||i.requested===true||!(['completed','failed','cancelled','interrupted'].includes(i.attempt?.state)&&i.attempt.retryable!==true&&
        i.attempt.native_evidence?.state===i.attempt.state&&Number.isSafeInteger(i.attempt.native_evidence.turn_end_seq)))
      .filter(i=>{try{this.#visibleItem(i.inbox_id,lifeId);return true;}catch{return false;}}).sort((a,b)=>a.inbox_seq-b.inbox_seq),items=visible.slice(0,limit).map(i=>this.#viewItem(i));
    return {owner_life_id:lifeId,items,nextAfter:items.at(-1)?.inbox_seq??after,hasMore:visible.length>items.length};
  }
  decide(c,args) {
    c=this.contexts.require(c);if(c.role==='delegate')fail('DELEGATE_INBOX_DECISION_DENIED');
    if(['lifeId','owner_life_id','originSessionId','originTaskId'].some(k=>args[k]!==undefined))fail('INBOX_OWNER_IS_CONTEXT_BOUND');
    return this.decideForLife({...args,lifeId:c.lifeId,originSessionId:c.sessionId,originTaskId:this.tasks?.forSession(c.sessionId)?.task_id??null});
  }
  decideForLife({lifeId,inbox_id,decision_token,message_id,message_ref,action,expectedRevision,expected_revision,until=null,body,reply_message_id,originSessionId=null,originTaskId=null}) {
    if(expected_revision!==undefined){if(expectedRevision!==undefined&&expectedRevision!==expected_revision)fail('INBOX_REVISION_ALIAS_CONFLICT');expectedRevision=expected_revision;}
    let token;
    if(decision_token!==undefined){try{if(typeof decision_token!=='string'||!decision_token.startsWith('decision:'))throw Error();token=JSON.parse(Buffer.from(decision_token.slice(9),'base64url').toString());if(!Array.isArray(token)||token.length!==3)throw Error();}catch{fail('INVALID_DECISION_TOKEN');}if(inbox_id!==undefined&&inbox_id!==token[0])fail('DECISION_REFERENCE_CONFLICT');inbox_id=token[0];}
    const ref=typeof message_ref==='string'?{message_id:message_ref}:message_ref;
    // message_id historically named the outbound reply. With an inbox/token it
    // remains a compatibility alias; otherwise it identifies the received item.
    if(!inbox_id&&(message_id||ref?.message_id)){const matches=Object.values(this.#state.inbox).filter(i=>i.owner_life_id===lifeId&&i.message_id===(ref?.message_id??message_id)&&(!ref?.room_id||i.room_id===ref.room_id)&&i.status!=='revoked');if(matches.length!==1)fail('MESSAGE_REFERENCE_NOT_VISIBLE_OR_AMBIGUOUS');inbox_id=matches[0].inbox_id;message_id=undefined;}
    if(!inbox_id)fail('INBOX_DECISION_REFERENCE_REQUIRED');
    if(!this.#state.inbox[inbox_id]&&Object.values(this.#state.inbox).some(i=>i.owner_life_id===lifeId&&i.message_id===inbox_id))fail('INBOX_ID_IS_MESSAGE_ID_USE_MESSAGE_REF_OR_DECISION_TOKEN');
    const {item}=this.#visibleItem(inbox_id,lifeId);
    if(ref&&(ref.message_id!==item.message_id||ref.room_id!==undefined&&ref.room_id!==item.room_id))fail('DECISION_REFERENCE_CONFLICT');
    if(message_id===item.message_id)message_id=undefined;
    if(action==='reply') {
      const receipt=roomEffectResult(item,this.#state.rooms);
      if(receipt?.status==='confirmed_success'&&receipt.body_hash===this.#hash(body??''))return this.#viewItem(item);
      fail('REPLY_USE_SEND_MESSAGE');
    }
    if(token&&(token[1]!==item.membership_epoch||token[2]!== (item.decision_revision??1)))fail('DECISION_TOKEN_STALE_RECEIVE_CURRENT_ITEM');
    if(!token&&item.revision!==expectedRevision)fail('INBOX_REVISION_CONFLICT_RECEIVE_CURRENT_ITEM');
    if(!['complete','continue','defer','ignore','process'].includes(action))fail('INVALID_INBOX_DECISION');
    if(action==='defer'&&until!==null&&(!Number.isFinite(Date.parse(until))||Date.parse(until)<=this.now()))fail('DEFER_REQUIRES_FUTURE_TIME');
    if(action==='process'&&['prepared','absent','pending','running'].includes(item.attempt?.state))fail('INBOX_ALREADY_ADMITTED_OR_PROCESSING');
    const next=copy(this.#state),stored=next.inbox[inbox_id];
    stored.status=({complete:'handled',continue:'pending',defer:'deferred',ignore:'ignored',process:'pending'})[action];
    stored.requested=action==='process';stored.last_decision=action;stored.decision_at=this.#at();
    stored.defer_until=action==='defer'?until:null;stored.revision++;stored.decision_revision=(stored.decision_revision??1)+1;stored.updated_at=this.#at();this.#commit(next);return this.#viewItem(stored);
  }
  // Former eager API is now only a durable inbox lookup. Sending never wakes.
  async deliverToLife({conversationId,room_id,messageId,message_id,lifeId}) {
    const r=this.#room(room_id??conversationId),member=this.#member(r,lifeId),m=r.messages.find(x=>x.messageId===(message_id??messageId));
    if(!m||m.seq<member.firstVisibleSeq)fail('MESSAGE_NOT_VISIBLE');
    const item=Object.values(this.#state.inbox).find(i=>i.room_id===r.conversationId&&i.message_id===m.messageId&&i.owner_life_id===lifeId&&i.membership_epoch===member.epoch);
    if(!item)fail('INBOX_NOT_VISIBLE');return this.#viewItem(item);
  }
  // Deferred expiry requests reconsideration under the current idle policy; it
  // never sends a reply. null means indefinite deferral. This transition is
  // durable and idempotent, including after a Supervisor restart.
  refreshDeferred({lifeId}={}) {
    const due=Object.values(this.#state.inbox).filter(i=>(lifeId===undefined||i.owner_life_id===lifeId)&&i.status==='deferred'&&i.defer_until!==null&&Date.parse(i.defer_until)<=this.now());
    if(!due.length)return {reopened:0};const next=copy(this.#state);
    for(const row of due){const item=next.inbox[row.inbox_id];item.status='pending';item.requested=true;item.previous_defer_until=item.defer_until;item.defer_until=null;item.delivery_reason='defer-expired-reconsideration';item.revision++;item.decision_revision=(item.decision_revision??1)+1;item.updated_at=this.#at();}
    this.#commit(next);return {reopened:due.length};
  }
  deliveryCandidates({lifeId,limit=20,human_idle=true,peer_idle=true}) {
    this.contexts.registry.life(lifeId);this.refreshDeferred({lifeId});if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('EXPLICIT_BATCH_LIMIT_REQUIRED');
    return Object.values(this.#state.inbox).filter(i=>i.owner_life_id===lifeId&&this.#candidate(i))
      .filter(i=>{try{const {message}=this.#visibleItem(i.inbox_id,lifeId);return i.requested===true||(message.sender.sender_type==='human'?human_idle:peer_idle);}catch{return false;}})
      .sort((a,b)=>a.inbox_seq-b.inbox_seq).slice(0,limit).map(i=>this.#viewItem(i));
  }
  #candidate(item) {
    if(item.status!=='pending'||['prepared','absent','pending','running'].includes(item.attempt?.state))return false;
    if(item.requested===true)return true;
    if(!item.attempt)return !item.native_ingress&&(!item.migration||['queued','pending','requested'].includes(item.migration.from_status));
    return ['failed','interrupted'].includes(item.attempt.state)&&item.attempt.retryable===true&&Date.parse(item.attempt.retry_after??0)<=this.now();
  }
  selectWorkerBatch({lifeId,sessionId,items}) {
    const owner=this.contexts.registry.assertTarget(lifeId,sessionId);if(owner.status!=='ready'||owner.role==='delegate')fail('TRUSTED_WORKER_RECEIVER_REQUIRED');
    if(!Array.isArray(items)||!items.length||items.length>100||new Set(items.map(i=>i.inbox_id)).size!==items.length)fail('EXPLICIT_DELIVERY_BATCH_REQUIRED');
    const current=items.map(input=>{const row=this.#visibleItem(input.inbox_id,lifeId);if(row.item.revision!==input.expectedRevision)fail('INBOX_REVISION_CONFLICT');
      if((row.room.sessionBindings[lifeId]??this.contexts.registry.life(lifeId).authoritySessionId)!==sessionId)fail('DELIVERY_SESSION_BINDING_CHANGED');return row;}).sort((a,b)=>a.item.inbox_seq-b.item.inbox_seq);
    const recovering=current.find(row=>['prepared','absent','pending','running'].includes(row.item.attempt?.state));
    if(recovering){const attempt=recovering.item.attempt;if(attempt.session_id!==sessionId||current.some(row=>row.item.attempt?.attempt_id!==attempt.attempt_id))fail('DELIVERY_BATCH_RECOVERY_MUST_KEEP_ATTEMPT');return freeze({items:current.map(row=>this.#viewItem(row.item)),attempt:copy(attempt),native_message:copy(attempt.native_message)});}
    for(const {item,room} of current){if(!this.#candidate(item))fail('RECEIVER_CHOICE_BLOCKS_DELIVERY');if(room.sessionBindings[lifeId]&&room.sessionBindings[lifeId]!==sessionId)fail('DELIVERY_SESSION_BINDING_CHANGED');}
    const attemptId=randomUUID(),requestId='room-inbox-batch:'+lifeId+':'+attemptId,inboxIds=current.map(row=>row.item.inbox_id),requestedInboxIds=current.filter(row=>row.item.requested===true).map(row=>row.item.inbox_id);
    const nativeMessage=createUserMessage({content:[{type:'text',text:JSON.stringify({kind:'social-events',items:current.map(({item,message})=>socialView({room_id:item.room_id,message_id:item.message_id,received_at:item.received_at,decision_token:this.#token(item),message:this.#message(message)})),
      choices:['complete','continue','defer','ignore'],instructions:'Host events: understand who spoke to whom and whether public or private. The native life_send_message tool takes to=contact name, visibility and body; optional in_response_to references an event. You can speak repeatedly and use all existing native tools before finishing. Sending does not end this activity or complete its inputs. life_turn_ack ends this wake; completed_event_ids explicitly chooses completed inputs. No reply is required. Unknown effects require readback of the original native call before sending again. received_at is not a read receipt.'})}],
      source:{kind:'room-inbox-batch',rpcId:requestId,attemptId,inboxIds,requested_inbox_ids:requestedInboxIds,receiverLifeId:lifeId,sender_types:[...new Set(current.map(row=>row.message.sender.sender_type))],
        ...current.every(row=>row.message.sender.sender_id==='human:developer-ultra')?{reasonKind:'developer-test'}:{},modelAdmissionDurability:'journal-flushed-before-provider',clientTimeZone:'Asia/Shanghai'}});
    const attempt={attempt_id:attemptId,session_id:sessionId,request_id:requestId,inbox_ids:inboxIds,requested_inbox_ids:requestedInboxIds,native_message:copy(nativeMessage),prepared_at:this.#at(),state:'prepared',retryable:false,
      retry_generation:Math.max(0,...current.map(row=>row.item.attempt?.retry_count??row.item.retry_count??0))};
    const next=copy(this.#state);for(const {item} of current){const stored=next.inbox[item.inbox_id];if(stored.attempt){stored.previous_attempts??=[];stored.previous_attempts.push(stored.attempt);}stored.attempt=copy(attempt);stored.requested=false;stored.revision++;stored.updated_at=this.#at();}
    this.#commit(next);return freeze({items:current.map(row=>this.#viewItem(next.inbox[row.item.inbox_id])),attempt:copy(attempt),native_message:copy(nativeMessage)});
  }
  authorizeWorkerBatchDelivery({lifeId,sessionId,inbox_ids,attempt_id}) {
    if(!Array.isArray(inbox_ids)||!inbox_ids.length)fail('EXPLICIT_DELIVERY_BATCH_REQUIRED');for(const inbox_id of inbox_ids)this.authorizeWorkerDelivery({lifeId,sessionId,inbox_id,attempt_id});return freeze({authorized:true,inbox_ids:[...inbox_ids],attempt_id});
  }
  acknowledgeWorkerBatchDelivery(input) {
    this.authorizeWorkerBatchDelivery(input);const next=copy(this.#state);
    let changed=false;
    for(const id of input.inbox_ids){const item=next.inbox[id];if(!['prepared','absent'].includes(item.attempt.state))continue;item.attempt.state='pending';item.revision++;item.updated_at=this.#at();changed=true;}
    if(changed)this.#commit(next);return freeze({items:input.inbox_ids.map(id=>this.#viewItem(this.#state.inbox[id])),attempt_id:input.attempt_id});
  }
  reconcileWorkerDelivery({lifeId,sessionId,inbox_id,attempt_id,evidence}) {
    this.contexts.registry.assertTarget(lifeId,sessionId);const {item}=this.#visibleItem(inbox_id,lifeId);
    const attempt=item.attempt?.attempt_id===attempt_id?item.attempt:item.previous_attempts?.find(a=>a.attempt_id===attempt_id);
    if(!attempt||attempt.session_id!==sessionId)fail('DELIVERY_ATTEMPT_REPLACED');
    if(!evidence||!['absent','pending','running','completed','failed','cancelled','interrupted','ambiguous'].includes(evidence.state))fail('NATIVE_DELIVERY_EVIDENCE_REQUIRED');
    const observed=copy(evidence);delete observed.side_effects;
    if(attempt.state===observed.state&&JSON.stringify(attempt.native_evidence)===JSON.stringify(observed))return this.#viewItem(item);
    if(['completed','failed','cancelled','interrupted'].includes(attempt.state)&&attempt.state!==observed.state)return this.#viewItem(item);
    const next=copy(this.#state),stored=next.inbox[inbox_id],target=stored.attempt?.attempt_id===attempt_id?stored.attempt:stored.previous_attempts.find(a=>a.attempt_id===attempt_id);
    target.state=observed.state;target.native_evidence=observed;target.retryable=false;
    if(['failed','interrupted'].includes(observed.state)) {
      if(!target.failure_recorded){target.retry_count=(target.retry_count??target.retry_generation??item.retry_count??0)+1;target.failure_recorded=true;}
      target.retryable=observed.no_effect_dispatch_proven===true&&observed.assistant_committed!==true&&observed.retryable===true&&target.retry_count<=3;
      if(target.retryable&&target.retry_after===undefined)target.retry_after=new Date(this.now()+Math.min(30000,1000*2**Math.max(0,target.retry_count-1))).toISOString();
    }
    target.error_code=observed.error_code??null;
    if(observed.state==='ambiguous'||observed.state==='interrupted'&&!target.retryable)target.reconcile_error=observed.error_code??'NATIVE_DELIVERY_OUTCOME_UNKNOWN';else delete target.reconcile_error;
    stored.updated_at=this.#at();stored.revision++;this.#commit(next);return this.#viewItem(stored);
  }
  selectWorkerDelivery({lifeId,sessionId,inbox_id,expectedRevision}) {
    const batch=this.selectWorkerBatch({lifeId,sessionId,items:[{inbox_id,expectedRevision}]});
    return freeze({item:batch.items[0],attempt:batch.attempt,native_message:batch.native_message});
  }
  authorizeWorkerDelivery({lifeId,sessionId,inbox_id,attempt_id}) {
    this.contexts.registry.assertTarget(lifeId,sessionId);const {item,room}=this.#visibleItem(inbox_id,lifeId);
    if((room.sessionBindings[lifeId]??this.contexts.registry.life(lifeId).authoritySessionId)!==sessionId)fail('DELIVERY_SESSION_BINDING_CHANGED');
    if(item.attempt?.attempt_id!==attempt_id||item.attempt.session_id!==sessionId)fail('INBOX_CHOICE_CHANGED');
    if(item.status!=='pending'&&['prepared','absent','pending','running'].includes(item.attempt.state))fail('INBOX_CHOICE_CHANGED');
    return freeze({authorized:true,inbox_id,attempt_id,status:item.status});
  }
  acknowledgeWorkerDelivery(input) {
    return this.acknowledgeWorkerBatchDelivery({...input,inbox_ids:[input.inbox_id]}).items[0];
  }
  failWorkerDelivery(input) {
    this.authorizeWorkerDelivery(input);const next=copy(this.#state),stored=next.inbox[input.inbox_id];
    if(['prepared','absent','pending','running'].includes(stored.attempt.state)) {
      stored.attempt.state=input.error_code==='LIFE_BUSY'?'absent':'ambiguous';stored.attempt.retryable=false;
      stored.attempt.error_code=/^[A-Z_]+$/.test(input.error_code??'')?input.error_code:'WORKER_DELIVERY_FAILED';
      if(stored.attempt.state==='ambiguous')stored.attempt.reconcile_error=stored.attempt.error_code;
      stored.revision++;stored.updated_at=this.#at();this.#commit(next);
    }
    return this.#viewItem(this.#state.inbox[input.inbox_id]);
  }
  processRequested(){return {accepted:false,reason:'NATIVE_INBOX_BATCH_REQUIRED'};}
}
