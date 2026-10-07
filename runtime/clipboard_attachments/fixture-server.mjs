import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {attachmentPrompt} from './store.mjs';
import {attachmentRoutes} from './routes.mjs';
const root=resolve(import.meta.dirname,'../../reports/clipboard_attachments/fixture-files');await mkdir(root,{recursive:true});
const first='147c2fff-ff1a-5d20-b057-cd3ec56745fa',second='a31a2cda-ada2-505b-9eee-8c9153de5a45';
const catalog={primary:first,tasks:[{sessionId:first,primary:true,title:'粘贴附件验收'},{sessionId:second,title:'第二测试对话'}]};
const received=[];
const routes=new Map(attachmentRoutes({root,validateSession:async sessionId=>{if(!catalog.tasks.some(t=>t.sessionId===sessionId))throw new Error('unknown fixture session');},clipboard:async()=>({image:Buffer.from('clipboard fallback fixture').toString('base64')})}).map(([path,,action])=>[path,action]));
const server=createServer(async(req,res)=>{
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');return res.end('<html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;background:#17191e"><div id="app" style="height:100vh"></div><script src="/react.js"></script><script src="/client.js"></script></body></html>');}
    if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
    if(url.pathname==='/react.js'||url.pathname==='/client.js'){res.setHeader('content-type','text/javascript; charset=utf-8');return res.end(await readFile(url.pathname==='/react.js'?resolve(import.meta.dirname,'fixture-react.js'):resolve(import.meta.dirname,'../desktop_persona/client.js')));}
    if(url.pathname==='/api/persona.status')return json({ready:true,busy:false,activeSessionIds:[]});
    if(url.pathname==='/api/persona.tasks')return json(catalog);
    if(url.pathname==='/api/persona.historyState')return json({sessionId:url.searchParams.get('sessionId'),rows:[],eventCount:0,running:false,wakeups:[]});
    if(url.pathname==='/evidence')return json(received);
    const parts=[];for await(const part of req)parts.push(part);const bytes=Buffer.concat(parts);
    if(routes.has(url.pathname)){
      const response=await routes.get(url.pathname)(new Request(url,{method:'POST',headers:req.headers,body:bytes}));
      res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const input=JSON.parse(bytes);
    if(url.pathname==='/api/persona.prompt'){
      received.push({sessionId:input.sessionId,text:await attachmentPrompt(root,input.sessionId,input.text,input.attachmentIds),ids:input.attachmentIds});
      return json({state:'completed'});
    }
    json({error:'fixture route missing'},404);
  }catch(error){json({error:error.message},400);}
});
server.listen(18749,'127.0.0.1',()=>console.log('Isolated clipboard test UI: http://127.0.0.1:18749'));
