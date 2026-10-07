// Human presentation bridge; all message writes use the existing human Host.
import {readFile} from 'node:fs/promises';
import {uploadChatAttachment,pasteChatAttachment,readChatAttachment} from './attachments.mjs?revision=attachment-preview-2';
import {readReferenceState} from '../reference-ui/state.mjs';
import {chatCatalog,chatPage,sendChat} from './chats.mjs?revision=activity-social-3';
import {chatExecution} from './execution.mjs?revision=activity-social-3';
import {chatStream} from './stream.mjs';
import {globalStatus,controlLife} from './global-start.mjs?revision=per-life-control-3';
export const inject=['connection'];
export function apply(ctx){
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-persona-reference-version':'1'}});
 for(const [path,method,action] of [['chatUpload','POST',uploadChatAttachment],['chatClipboard','POST',pasteChatAttachment],['chatAttachment','GET',readChatAttachment]])ctx.effect(()=>ctx.connection.fetch.register({path:'/api/persona.'+path,methods:[method],requestBody:'buffered',fetch:async request=>{try{const v=await action(request);return v instanceof Response?v:json(v);}catch(error){return json({error:error.message},400);}}}));
 for(const [path,action] of [
  ['/api/persona.globalStatus',async()=>json(await globalStatus())],
  ['/api/persona.referenceState',async()=>json(await readReferenceState())],
  ['/api/persona.chatRooms',async()=>json(await chatCatalog())],
  ['/api/persona.chatMessages',async request=>json(await chatPage(new URL(request.url)))],
  ['/api/persona.chatExecution',async request=>json(await chatExecution(new URL(request.url)))],
  ['/api/persona.chatStream',chatStream],
  ['/api/persona.referenceImage',async request=>{
   const name=new URL(request.url).searchParams.get('name');
   if(!/^[a-z0-9-]+\.(png|svg)$/.test(name??''))return json({error:'Unknown asset'},404);
   return new Response(new Uint8Array(await readFile(new URL('../reference-ui/assets/'+name,import.meta.url))),{headers:{'content-type':name.endsWith('.svg')?'image/svg+xml':'image/png','cache-control':'public, max-age=3600'}});
  }]
 ])ctx.effect(()=>ctx.connection.fetch.register({path,methods:['GET'],requestBody:'buffered',fetch:async request=>{try{return await action(request);}catch(error){return json({error:'真实状态暂时无法读取'},503);}}}));
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/persona.lifeControl',methods:['POST'],requestBody:'buffered',fetch:async request=>{
  try{return json(await controlLife(await request.json()),202);}
  catch(error){return json({error:/^[A-Z_]+$/.test(error.message)?error.message:'CONTROL_NOT_CONFIRMED'},503);}
 }}));
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/persona.chatMessage',methods:['POST'],requestBody:'buffered',fetch:async request=>{
   try{return json(await sendChat(await request.json()));}
   catch(error){return json({error:'发送未确认，请保留草稿并核对记录',code:/^[A-Z_]+$/.test(error.code??error.message)?error.code??error.message:'CHAT_SEND_UNCONFIRMED'},503);}
 }}));
}
