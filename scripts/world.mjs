import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setupWorld,worldRoot} from './setup-world.mjs';
import {LifeRegistry} from '../runtime/native_dsh/multi-life/registry.mjs';
import {createNeutralWorld} from '../runtime/native_dsh/multi-life/supervisor/world.mjs';
import {listenLifeHost} from '../runtime/native_dsh/multi-life/platform/http.mjs';
import {validateManifest} from '../runtime/native_dsh/multi-life/contracts.mjs';
export async function startWorld(){
  const settings=await setupWorld();
  const registry=new LifeRegistry({root:resolve(worldRoot,'registry'),mode:'production'});
  const bindings=new Map(),workers={};
  for(const l of settings.lives){
    const deployment={presetId:l.lifeId,provider:'deepseek-official',model:'deepseek-flash',maxTokens:8192,workspace:l.workspace,core:l.core,
      state:resolve(l.base,'state'),memory:resolve(l.base,'memory'),vault:resolve(l.base,'vault'),recovery:resolve(l.base,'recovery'),
      capabilities:resolve(l.base,'capabilities'),attachments:resolve(l.base,'attachments'),versions:resolve(l.base,'versions'),skillsRoots:[resolve(l.workspace,'.dsh/skills')],budgetAccountRef:'deepseek-life:'+l.lifeId};
    const manifest=validateManifest({schemaVersion:1,lifeId:l.lifeId,kind:'independent',displayName:l.name,revision:1,authoritySessionId:l.authoritySessionId,deployment},'production');
    if(!registry.list().some(m=>m.lifeId===l.lifeId))registry.register(manifest);
    registry.reserve({lifeId:l.lifeId,sessionId:l.authoritySessionId,role:'authority'});
    bindings.set(l.lifeId,{token:settings.tokens.workers[l.lifeId],allowedPresetId:l.lifeId,humanPrincipalId:settings.human.id});
    workers[l.lifeId]={kind:'modern',kernel_root:resolve(worldRoot,'workers',l.lifeId,'kernel'),session_root:resolve(worldRoot,'workers',l.lifeId,'sessions'),schedule_root:resolve(worldRoot,'workers',l.lifeId,'schedules'),port:settings.workerPortBase+settings.lives.indexOf(l),execution_disabled:true};
  }
  await mkdir(resolve(worldRoot,'supervisor'),{recursive:true});
  try{await readFile(resolve(worldRoot,'supervisor/deployments.json'));}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(resolve(worldRoot,'supervisor/deployments.json'),JSON.stringify({schema_version:1,workers},null,2)+'\n',{flag:'wx'});}
  const host=createNeutralWorld({registry,platformRoot:resolve(worldRoot,'kernel/platform'),workerBindings:bindings});
  host.rooms.registerHuman({sender_id:settings.human.id,display_name:settings.human.name});
  for(const l of settings.lives){
    if(!host.rooms.listForPrincipal(l.lifeId).some(r=>r.room_id===l.humanRoomId))host.rooms.defineRoom({room_id:l.humanRoomId,participants:[settings.human.id,l.lifeId],room_type:'direct'});
    host.rooms.bindReceiver({lifeId:l.lifeId,room_id:l.humanRoomId,sessionId:l.authoritySessionId});
  }
  if(settings.lives.length>1){
    if(!host.rooms.listForPrincipal(settings.lives[0].lifeId).some(r=>r.room_id===settings.peerRoomId))host.rooms.defineRoom({room_id:settings.peerRoomId,participants:settings.lives.map(l=>l.lifeId),room_type:settings.lives.length===2?'direct':'group'});
    host.rooms.grantInitialObserver({room_id:settings.peerRoomId,principalId:settings.human.id});
    for(const l of settings.lives)host.rooms.bindReceiver({lifeId:l.lifeId,room_id:settings.peerRoomId,sessionId:l.authoritySessionId});
  }
  const fallback=settings.lives[0];
  const view=id=>{const l=settings.lives.find(l=>l.lifeId===id)||fallback;return {roomId:l.humanRoomId,lifeId:l.lifeId,displayName:l.name};};
  const human=await listenLifeHost(host,{port:settings.port,token:settings.tokens.human,principalId:settings.human.id,displayName:settings.human.name,directChat:view,
    peerChat:settings.lives.length>1?{roomId:settings.peerRoomId,lifeId:fallback.lifeId,displayName:'生命之间的聊天'}:undefined});
  const operator=await listenLifeHost(host,{port:settings.operatorPort,token:settings.tokens.operator,principalId:'human:operator',displayName:'Maintainer control',operator:true});
  await writeFile(resolve(worldRoot,'birth.json'),JSON.stringify({port:human.port,life_id:fallback.lifeId,human_room_id:fallback.humanRoomId,peer_room_id:settings.peerRoomId,human_token_ref:'DL_WORLD_HUMAN',human_a_room_id:fallback.humanRoomId})+'\n');
  await writeFile(resolve(worldRoot,'supervisor/control.json'),JSON.stringify({schema_version:1,pid:process.pid,port:human.port,operator_port:operator.port,operator_token_ref:'DL_WORLD_OPERATOR',ownership:'neutral-host'})+'\n');
  console.log(JSON.stringify({ready:true,port:human.port,model_calls:0,lives:settings.lives.map(l=>({slot:l.slot,life_id:l.lifeId,chat:'http://127.0.0.1:'+human.port+'/chat?life_id='+l.lifeId}))}));
  const stop=async()=>{await host.dispose();process.exit(0);};process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
  return host;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await startWorld();
