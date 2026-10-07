import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {LifeRegistry} from '../registry.mjs';
import {listenLifeHost} from '../platform/http.mjs';
import {credentialOperation} from '../../capabilities/isolation.mjs';
import {createNeutralWorld} from './world.mjs';
import {fail} from '../contracts.mjs';

const migrationRoot=resolve(import.meta.dirname,'../../../..');
const control=resolve(process.env.DL_WORLD_ROOT || resolve(migrationRoot,'.local/world'), '.');
const python=(process.env.DL_PYTHON || 'python');
export const workerReference=id=>'DL_LIFE_COMM_'+id.replaceAll('-','_').toUpperCase();
async function tokenFor(ref) {
  const existing=await credentialOperation(python,'resolve',ref);
  if(existing?.value)return existing.value;
  const token=randomBytes(32).toString('hex');await credentialOperation(python,'set',ref,token);return token;
}
async function save(path,value) {
  const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(tmp,path);
}
export async function serveNeutral() {
  // No prepareBirth fallback: Supervisor cannot create a life or a Core.
  const marker=JSON.parse(await readFile(resolve(control,'birth.json'),'utf8'));
  const registry=new LifeRegistry({root:resolve(control,'registry'),mode:'production'});
  if(registry.list().length<1)fail('EXISTING_REGISTERED_LIVES_REQUIRED');
  await mkdir(resolve(control,'supervisor'),{recursive:true});
  try{await readFile(resolve(control,'supervisor/deployments.json'));}catch(error) {
    if(error.code!=='ENOENT')throw error;
    let modernIndex=0;
    const workers=Object.fromEntries(registry.list().map(m=>[m.lifeId,m.kind==='legacy'?{
      kernel_root:resolve(migrationRoot,'runtime/native_dsh'),session_root:resolve(migrationRoot,'runtime/native_dsh/home/sessions'),kind:'legacy',
    }:{kernel_root:resolve(control,'workers',m.lifeId,'kernel'),
      session_root:m.lifeId===marker.life_id?resolve(control,'kernel/sessions'):resolve(control,'workers',m.lifeId,'sessions'),
      schedule_root:m.lifeId===marker.life_id?resolve(control,'kernel/schedule-storage'):resolve(control,'workers',m.lifeId,'schedule-storage'),port:18844+modernIndex++,kind:'modern'}]));
    await save(resolve(control,'supervisor/deployments.json'),{schema_version:1,source:'explicit-two-life-alpha-store-migration',workers});
  }
  const workerBindings=new Map();
  for(const m of registry.list())workerBindings.set(m.lifeId,{token:await tokenFor(workerReference(m.lifeId)),allowedPresetId:m.deployment.presetId,humanPrincipalId:'human:maintainer'});
  const host=createNeutralWorld({registry,platformRoot:resolve(control,'kernel/platform'),workerBindings});
  const humanToken=await tokenFor(marker.human_token_ref),operatorRef='DL_MULTI_LIFE_DEVELOPER_CHANNEL';
  const operatorToken=await tokenFor(operatorRef);
  const m=registry.life(marker.life_id);
  await listenLifeHost(host,{port:marker.port,token:humanToken,principalId:'human:maintainer',displayName:'用户',operator:false,
    directChat:{roomId:marker.human_room_id,lifeId:m.lifeId,displayName:m.displayName},
    peerChat:{roomId:marker.peer_room_id,lifeId:m.lifeId,displayName:'人格 ↔ '+m.displayName}});
  const operator=await listenLifeHost(host,{port:18843,token:operatorToken,principalId:'human:developer-ultra',displayName:'Host / Developer / Ultra 授权测试来源',operator:true});
  await mkdir(resolve(control,'supervisor'),{recursive:true});
  await save(resolve(control,'supervisor/control.json'),{schema_version:1,pid:process.pid,port:marker.port,operator_port:operator.port,operator_token_ref:operatorRef,
    started_at:new Date().toISOString(),ownership:'neutral-host',registry_root:registry.controlRoot,platform_root:resolve(control,'kernel/platform')});
  console.log(JSON.stringify({ready:true,ownership:'neutral-host',pid:process.pid,port:marker.port,registered_lives:registry.list().map(m=>m.lifeId),model_calls:0}));
  const stop=async()=>{await host.dispose();process.exit(0);};
  process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
  return host;
}
if(process.argv[1]?.endsWith('neutral.mjs'))await serveNeutral();
