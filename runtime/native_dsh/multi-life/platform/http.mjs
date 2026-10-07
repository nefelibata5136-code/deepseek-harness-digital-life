import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fail} from '../contracts.mjs';
import {renderDirectChat} from './direct-chat.mjs';

// Token is bound at channel creation to an explicit human identity. Operator
// control is a separate permission; it never authorizes forging life speech.
export async function listenLifeHost(host,{port=0,token=randomBytes(32).toString('hex'),principalId,displayName,operator=false,directChat,peerChat}={}) {
  if(typeof token!=='string'||token.length<32||typeof principalId!=='string'||!principalId.startsWith('human:'))fail('EXPLICIT_HUMAN_CHANNEL_REQUIRED');
  const principal=host.rooms.registerHuman({sender_id:principalId,display_name:displayName}),registry=host.contexts.registry;
  const server=createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    const view=path==='/chat'?(typeof directChat==='function'?directChat(new URL(req.url,'http://127.0.0.1').searchParams.get('life_id')):directChat):path==='/peer-chat'?peerChat:null;
    if(view&&req.method==='GET') {
      if(req.headers.host!=='127.0.0.1:'+server.address().port)return send(403,{error:'LOCAL_CHAT_HOST_REQUIRED'});
      try{host.rooms.assertReader(view.roomId,principalId);}catch(error){return send(403,{error:/^[A-Z_]+$/.test(error.code??'')?error.code:'ROOM_ACCESS_DENIED'});}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer'});
      return res.end(renderDirectChat({...view,token,readOnly:path==='/peer-chat',peerUrl:peerChat?'/peer-chat':null}));
    }
    if(host.workerGateway&&req.method==='POST'&&path.startsWith('/internal/worker/')) {
      try {
        const handle=host.workerGateway.authenticate({lifeId:req.headers['x-life-id'],token:(req.headers.authorization??'').replace(/^Bearer /,'')});
        const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)fail('INPUT_BODY_LIMIT');chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8')),operation=path.slice('/internal/worker/'.length);
        if(operation==='heartbeat'&&host.supervisor)return send(200,{value:host.supervisor.heartbeat(req.headers['x-life-id'],input)});
        if(['resourceAcquire','resourceRelease'].includes(operation)&&host.sharedResources) {
          const lifeId=req.headers['x-life-id'];registry.assertTarget(lifeId,input.sessionId);
          const allowed=operation==='resourceAcquire'?['sessionId','key']:['sessionId','lease_id'];
          if(Object.keys(input).some(k=>!allowed.includes(k)))fail('RESOURCE_INPUT_INVALID');
          if(operation==='resourceRelease')return send(200,{value:host.sharedResources.release({lifeId,...input})});
          const controller=new AbortController();
          const cancel=()=>{if(!res.writableEnded)controller.abort(new Error('RESOURCE_CLIENT_DISCONNECTED'));};
          req.once('aborted',cancel);res.once('close',cancel);
          let lease;
          try {
            lease=await host.sharedResources.acquire({lifeId,...input,pid:host.supervisor.workerPid(lifeId),signal:controller.signal});
            if(lease.conflict)return send(200,{value:lease});
            if(controller.signal.aborted||res.destroyed) {
              host.sharedResources.release({lifeId,sessionId:input.sessionId,lease_id:lease.lease_id});
              return;
            }
            // A TCP close before the grant is flushed must not retain an unknown lease.
            const releaseUndelivered=()=>{if(!res.writableFinished)host.sharedResources.release({lifeId,sessionId:input.sessionId,lease_id:lease.lease_id});};
            res.once('close',releaseUndelivered);
            return send(200,{value:lease});
          }finally{req.off('aborted',cancel);res.off('close',cancel);}
        }
        if(!['registerSession','post','inbox','decide','list','read','timeline','observe','activity','activityEvent','humanMessage','selectDelivery','authorizeDelivery','acknowledgeDelivery','failDelivery','selectBatch','authorizeBatch','acknowledgeBatch','reconcileDelivery'].includes(operation))fail('UNKNOWN_WORKER_ROUTE');
        const value=await (operation==='list'?host.workerGateway.list(handle):host.workerGateway[operation](handle,input));
        return send(200,{value});
      }catch(error){return send(403,{error:/^[A-Z_]+$/.test(error.code??'')?error.code:'WORKER_CHANNEL_FAILED'});}
    }
    const auth=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);
    if(auth.length!==expected.length||!timingSafeEqual(auth,expected))return send(403,{error:'HOST_AUTHENTICATION_REQUIRED'});
    try {
      const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
      const page={after:Number(url.searchParams.get('after')??0),limit:Number(url.searchParams.get('limit')??50)};
      const lifeView=m=>({life_id:m.lifeId,display_name:m.displayName,authority_session_id:m.authoritySessionId,kind:m.kind,lifeId:m.lifeId,displayName:m.displayName,authoritySessionId:m.authoritySessionId});
      const requireOperator=()=>{if(!operator)fail('HOST_OPERATOR_REQUIRED');};
      if(req.method==='GET') {
        if(['/lives','/v1/lives'].includes(path))return send(200,{contract_version:1,lives:registry.list().map(lifeView),privacy:'logical-owner-routing',osStrongIsolation:false});
        if(path==='/v1/self')return send(200,{principal,permissions:{operator}});
        if(path==='/v1/supervisor'&&host.supervisor)return send(200,host.supervisor.snapshot());
        if(path==='/v1/rooms')return send(200,{rooms:host.rooms.listForPrincipal(principalId)});
        if(path==='/v1/timeline')return send(200,host.rooms.timelineForPrincipal(principalId,page));
        if(path==='/v1/activity')return send(200,host.activity.read(url.searchParams.get('life_id')));
        const room=path.match(/^\/v1\/rooms\/([^/]+)\/messages$/);
        if(room)return send(200,host.rooms.readForPrincipal(principalId,{room_id:decodeURIComponent(room[1]),...page}));
        if(path==='/v1/resources'){requireOperator();return send(200,host.sharedResources?.snapshot()??host.fair.snapshot());}
        if(path==='/v1/inbox'){requireOperator();return send(200,host.rooms.inboxForLife({lifeId:url.searchParams.get('life_id'),...page,includeTerminal:url.searchParams.get('include_terminal')==='true'}));}
        if(path==='/life/events'){requireOperator();return send(200,{events:await host.runtime.events({lifeId:url.searchParams.get('lifeId'),sessionId:url.searchParams.get('sessionId')})});}
        if(path==='/life/sessions'){requireOperator();return send(200,{sessions:registry.sessions(url.searchParams.get('lifeId'))});}
        if(path==='/v1/status') {
          const lifeId=url.searchParams.get('life_id');registry.life(lifeId);
          const activity=host.activity?.read(lifeId),local=host.runtime.workerLifeIds?.has(lifeId)??true;
          const visibleRooms=new Set(host.rooms.listForPrincipal(principalId).map(r=>r.room_id));
          let pending=0,cursor=0;for(;;){const inbox=host.rooms.inboxForLife({lifeId,after:cursor,limit:100});pending+=inbox.items.filter(i=>visibleRooms.has(i.room_id)).length;if(!inbox.hasMore)break;cursor=inbox.nextAfter;}
          const nonDelegateBusy=local?host.runtime.isLifeBusy(lifeId):null;
          const worker=host.supervisor?.snapshot().workers.find(w=>w.life_id===lifeId);
          return send(200,{...activity,life_id:lifeId,busy:local?(activity?.busy??false)||nonDelegateBusy:activity?.busy??null,non_delegate_busy:nonDelegateBusy,room_inbox_pending:pending,
            room_inbox_pending_scope:'authorized-human-rooms',observation_scope:local?'registered-native-sessions':'bound-authority-session',
            source:'host-owner-state',interruptibility:'explicit-inbox-choice',...worker?{worker_healthy:worker.healthy,worker_state:worker.state,
              observation_stale:!worker.healthy,...!worker.healthy?{busy:null,phase:'offline'}:{}}:{}});
        }
      }
      if(req.method!=='POST')return send(404,{error:'UNKNOWN_LIFE_ROUTE'});
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)fail('INPUT_BODY_LIMIT');chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const visibilityRoute=path.match(/^\/v1\/rooms\/([^/]+)\/visibility$/);
      if(visibilityRoute){requireOperator();if(Object.keys(input).some(k=>!['visibility','expected_revision'].includes(k)))fail('ROOM_VISIBILITY_UPDATE_INVALID');
        return send(200,{room:host.rooms.setRoomVisibility({room_id:decodeURIComponent(visibilityRoute[1]),...input})});}
      if(path==='/v1/rooms') {
        if(!operator&&!input.participants?.includes(principalId))fail('HUMAN_ROOM_MEMBERSHIP_REQUIRED');
        if(input.observers!==undefined){
          requireOperator();
          if(!Array.isArray(input.observers)||input.observers.some(id=>host.rooms.principal(id).sender_type!=='human'))fail('EXPLICIT_ROOM_OBSERVER_REQUIRED');
        }
        let defined=host.rooms.defineRoom(input);
        if(operator&&input.observers!==undefined){
          for(const id of input.observers)defined=host.rooms.grantInitialObserver({room_id:defined.room_id,principalId:id});
        }
        return send(200,{room:defined});
      }
      const room=path.match(/^\/v1\/rooms\/([^/]+)\/messages$/);
      if(room||path==='/room/message') {
        const message=host.rooms.postHuman(principalId,{...input,...room?{room_id:decodeURIComponent(room[1])}:{}});
        return send(200,{message,state:'saved',deliveryIsSeparate:true,delivery:'durable-room-inbox'});
      }
      requireOperator();
      if(path==='/v1/inbox/bind') {
        registry.assertTarget(input.life_id,input.session_id);
        host.rooms.bindReceiver({lifeId:input.life_id,room_id:input.room_id,sessionId:input.session_id});
        return send(200,{bound:true,life_id:input.life_id,room_id:input.room_id,session_id:input.session_id});
      }
      if(path==='/life/prompt')return send(200,await host.runtime.prompt({lifeId:input.lifeId,sessionId:input.sessionId,requestId:input.requestId,sender:principal,content:[{type:'text',text:input.text}]}));
      if(path==='/life/cancel'){host.runtime.cancel({lifeId:input.lifeId,sessionId:input.sessionId});return send(200,{cancelled:true,lifeId:input.lifeId,sessionId:input.sessionId});}
      if(path==='/life/activity'){const agent=await host.runtime.create({lifeId:input.lifeId,sessionId:input.sessionId,role:'activity'});return send(200,{lifeId:input.lifeId,sessionId:agent.session.id});}
      if(path==='/v1/inbox/process') {
        let item,after=0;
        do {
          const page=host.rooms.inboxForLife({lifeId:input.life_id,after,limit:100,includeTerminal:true});
          item=page.items.find(i=>i.inbox_id===input.inbox_id);if(item||!page.hasMore)break;after=page.nextAfter;
        }while(true);
        if(!item)fail('INBOX_NOT_VISIBLE');
        if(!item.requested)host.rooms.decideForLife({lifeId:input.life_id,inbox_id:input.inbox_id,expectedRevision:input.expected_revision,action:'process'});
        return send(200,{accepted:true,inbox_id:input.inbox_id,state:'pending',requested:true,delivery:'native-durable-inbox',deliveryIsSeparate:true});
      }
      return send(404,{error:'UNKNOWN_LIFE_ROUTE'});
    }catch(error){return send(error.code==='HOST_OPERATOR_REQUIRED'?403:['UNKNOWN_LIFE','UNKNOWN_SESSION_OWNER','SESSION_OWNER_MISMATCH'].includes(error.code)?404:400,
      {error:/^[A-Z_]+$/.test(error.code??'')?error.code:'LIFE_CHANNEL_INPUT_OR_OPERATION_FAILED'});}
  });
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});
  const close=()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});
  host.ctx.effect(()=>close,'authenticated N-way channel');
  return {server,port:server.address().port,token,principalId,principal,close};
}
