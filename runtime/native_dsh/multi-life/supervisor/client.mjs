import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {publicCredentialOperation as credentialOperation} from './public-deployment.mjs';
import {worldRoot,migrationRoot,python,workerLayout,worldSnapshot} from './public-deployment.mjs';
import {workerReference} from './neutral.mjs';
import {fail} from '../contracts.mjs';
export async function hostRequest({base,path,token,method='GET',input}) {
  const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,...input===undefined?{}:{'content-type':'application/json'}},
    ...input===undefined?{}:{body:JSON.stringify(input)},signal:AbortSignal.timeout(30000)});
  const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error??'HOST_COMMAND_FAILED'),{code:value.error??'HOST_COMMAND_FAILED'});return value;
}
export async function worldRequest(path,{operator=false,method='GET',input}={}) {
  const client=await connectWorld({operator});return client(path,{method,input});
}
// One private credential resolution for a bounded Host batch. The function
// retains its channel binding; credentials are never returned to callers.
export async function connectWorld({operator=false}={}) {
  const marker=JSON.parse(await readFile(resolve(worldRoot,'birth.json'),'utf8'));
  const ref=operator?'DL_MULTI_LIFE_DEVELOPER_CHANNEL':marker.human_token_ref;
  const {value:token}=await credentialOperation(python,'resolve',ref);if(!token)fail('HOST_CHANNEL_NOT_CONFIGURED');
  const port=operator?JSON.parse(await readFile(resolve(worldRoot,'supervisor/control.json'),'utf8')).operator_port:marker.port;
  return (path,{method='GET',input}={})=>hostRequest({base:'http://127.0.0.1:'+port,path,token,method,input});
}
export async function workerRequest(lifeId,path,{method='GET',input}={}) {
  const client=await connectWorker(lifeId);return client(path,{method,input});
}
export async function connectWorker(lifeId) {
  const manifest=worldSnapshot().lives[lifeId];if(!manifest)fail('UNKNOWN_LIFE');
  let port,token;
  if(manifest.kind==='legacy') {
    const c=JSON.parse(await readFile(resolve(migrationRoot,'runtime/native_dsh/host-state/.host-control.json'),'utf8'));port=c.port;token=c.token;
  }else {port=workerLayout(lifeId).port;({value:token}=await credentialOperation(python,'resolve',workerReference(lifeId)));}
  return (path,{method='GET',input}={})=>hostRequest({base:'http://127.0.0.1:'+port,path,token,method,input});
}
if(process.argv[1]?.endsWith('client.mjs')) {
  const state=worldSnapshot(),lives=Object.values(state.lives),rows=[];
  for(const m of lives)try {
    const status=await workerRequest(m.lifeId,'/status');rows.push(m.kind==='legacy'?{life_id:m.lifeId,ready:status.ready,pid:status.pid,busy:status.busy,
      owner_boundary:status.ownerBoundary,metrics:status.multiLifeMetrics,communication:status.lifeCommunication}:{life_id:m.lifeId,...status});
  }catch(error){rows.push({life_id:m.lifeId,ready:false,error_code:error.code??error.name});}
  console.log(JSON.stringify({world:await worldRequest('/v1/supervisor'),workers:rows},null,2));
}
