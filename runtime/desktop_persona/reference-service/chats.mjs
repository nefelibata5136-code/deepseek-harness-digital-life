import {describeActivityRooms} from './execution.mjs?revision=activity-social-3';
import {connectWorld} from '../../native_dsh/multi-life/supervisor/client.mjs';
import {nativeRoomHistory} from './native-history.mjs?revision=human-decisions-1';

// Reuse the explicit human channel. Never read rooms.json or private Sessions.
export async function chatCatalog(request) {
  request??=await connectWorld();
  const [self,registry,history]=await Promise.all([request('/v1/self'),request('/v1/lives'),request('/v1/rooms')]);
  const statuses=await Promise.all(registry.lives.map(async life=>{
    try{return await request('/v1/status?life_id='+encodeURIComponent(life.life_id));}
    catch{return {life_id:life.life_id,busy:null,observation_stale:true};}
  }));
  return {...self,lives:registry.lives,rooms:await describeActivityRooms(history.rooms,{...self,lives:registry.lives}),statuses};
}
export async function chatPage(url,request) {
  request??=await connectWorld();
  const id=url.searchParams.get('room_id'),after=Number(url.searchParams.get('after')??0);
  if(!id||id.length>200||!Number.isSafeInteger(after)||after<0)throw Error('INVALID_CHAT_PAGE');
  const page=await request('/v1/rooms/'+encodeURIComponent(id)+'/messages?after='+after+'&limit=100');
  if(after===0){const [self,registry]=await Promise.all([request('/v1/self'),request('/v1/lives')]);
    page.native_history=await nativeRoomHistory(page.room,{...self,...registry});}
  return page;
}
export async function sendChat(input,request) {
  if(!input||Object.keys(input).some(k=>!['room_id','message_id','body'].includes(k))||
    typeof input.room_id!=='string'||!input.room_id||input.room_id.length>200||
    typeof input.message_id!=='string'||!/^human-chat:[a-f0-9-]{36}$/i.test(input.message_id)||
    typeof input.body!=='string'||!input.body.trim()||Buffer.byteLength(input.body)>1024*1024)throw Error('INVALID_CHAT_MESSAGE');
  request??=await connectWorld();
  // Host binds sender, timestamps, membership and durable idempotency.
  return request('/v1/rooms/'+encodeURIComponent(input.room_id)+'/messages',{
    method:'POST',input:{message_id:input.message_id,body:input.body}});
}
