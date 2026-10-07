import {saveAttachment,saveClipboard,maxBytes} from './store.mjs';
/** Authenticated Desktop transport calls these routes after validating the selected Session. */
export function attachmentRoutes({root,validateSession,clipboard}) {
  const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  return [
    ['/api/persona.upload',['POST'],async request=>{
      if(Number(request.headers.get('content-length'))>maxBytes+65536)return json({error:'附件超过 128 MB'},413);
      const form=await request.formData(),sessionId=form.get('sessionId'),file=form.get('file');
      await validateSession(sessionId);
      if(!file||typeof file.arrayBuffer!=='function')return json({error:'缺少附件文件'},400);
      if(file.size>maxBytes)return json({error:'附件超过 128 MB'},413);
      return json(await saveAttachment(root,sessionId,{name:file.name,type:file.type,bytes:Buffer.from(await file.arrayBuffer())}));
    }],
    ['/api/persona.clipboard',['POST'],async request=>{
      const {sessionId}=await request.json();await validateSession(sessionId);
      return json(await saveClipboard(root,sessionId,clipboard?await clipboard():undefined));
    }],
  ];
}
