// Maintainer-only operations reuse the official Plugin Manager and secret backend.
// No model loop, scheduler, public test post, or automatic registration retry.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {credentialOperation} from '../native_dsh/capabilities/isolation.mjs';
import {worldSnapshot,python} from '../native_dsh/multi-life/supervisor/deployment.mjs';
import {connectWorker} from '../native_dsh/multi-life/supervisor/client.mjs';
import {moltbookCredentialRef} from './bindings.mjs';
import {MoltbookClient} from './bundle/client.mjs';
import {signApproval,approvalFile} from './bundle/approvals.mjs';
import {createMoltbookTransport} from './bundle/network.mjs';
import {approveProfile} from '../native_dsh/capabilities/profiles.mjs';
const [command='status',label='persona',arg1,arg2,...extra]=process.argv.slice(2);
if(label!=='persona')throw Error('NEWLIFE_MOLTBOOK_REGISTRATION_CANCELLED_BY_USER');
const m=Object.values(worldSnapshot().lives).find(m=>m.kind==='legacy');
const root=m.deployment.capabilities,profile=join(root,'moltbook'),stateRoot=join(profile,'state'),ref=moltbookCredentialRef(m.lifeId);
const config={lifeId:m.lifeId,credentialRef:ref,stateRoot};
const registration=join(stateRoot,'registration.json');
const save=value=>writeFile(registration,JSON.stringify(value,null,2)+'\n');
if(!existsSync(join(profile,'capability.json')))throw Error('INSTALL_NATIVE_PROFILE_FIRST');
await mkdir(stateRoot,{recursive:true});
if(command==='approve'){
 console.log(JSON.stringify(await approveProfile(root,'moltbook')));
}else if(command==='enable'||command==='disable'||command==='refresh'){
 const client=await connectWorker(m.lifeId);
 console.log(JSON.stringify(await client('/capabilities',{method:'POST',input:{capability:'moltbook',action:command}})));
}else if(command==='register'){
 if(!/^[A-Za-z0-9_-]{3,50}$/.test(arg1??''))throw Error('EXPLICIT_SELF_CHOSEN_NAME_REQUIRED');
 const credential=await credentialOperation(python,'describe',ref);
 if(credential?.configured){console.log(JSON.stringify({registered_credential_present:true,life_id:m.lifeId,credential_ref:ref,...existsSync(registration)?JSON.parse(await readFile(registration,'utf8')):{}}));}
 else {
  let previous;
  if(existsSync(registration)){
   const old=JSON.parse(await readFile(registration,'utf8'));
   if(!['failed','reconciled_absent'].includes(old.outcome))throw Error('REGISTRATION_UNKNOWN_REQUIRES_EXACT_NAME_RECONCILIATION');
   previous=old;
  }
  const chosen=arg2?JSON.parse(await readFile(resolve(arg2),'utf8')):null;
  if(!chosen||chosen.name!==arg1||chosen.life_id!==m.lifeId||typeof chosen.description!=='string')throw Error('SELF_CHOSEN_PUBLIC_IDENTITY_RECORD_REQUIRED');
  const request={name:arg1,description:chosen.description};
  if(previous?.outcome==='reconciled_absent'&&(previous.name!==arg1||previous.request_hash!==createHash('sha256').update(JSON.stringify(request)).digest('hex')))throw Error('RECONCILED_REGISTRATION_MUST_KEEP_EXACT_NAME_AND_PAYLOAD');
  const intent={life_id:m.lifeId,name:arg1,request_hash:createHash('sha256').update(JSON.stringify(request)).digest('hex'),outcome:'prepared',prepared_at:new Date().toISOString(),...previous?{previous_attempt:previous}:{}};
  await save(intent);
  let response;
  const transport=createMoltbookTransport();
  try{response=await transport.fetch('https://www.moltbook.com/api/v1/agents/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(18000)});}
  catch{await save({...intent,outcome:'unknown'});throw Error('REGISTRATION_TRANSPORT_UNKNOWN_DO_NOT_RESEND');}
  finally{await transport.close();}
  if(!response.ok){const definite=response.status>=400&&response.status<500&&response.status!==408;const receipt={...intent,outcome:definite?'failed':'unknown',http_status:response.status,error_code:response.status===409?'NAME_CONFLICT':response.status===429?'RATE_LIMITED':'REGISTRATION_REJECTED'};await save(receipt);console.log(JSON.stringify(receipt));}
  else {
   let body;try{body=await response.json();}catch{await save({...intent,outcome:'unknown'});throw Error('REGISTRATION_RESPONSE_UNKNOWN');}
   const agent=body.agent,key=agent?.api_key;
   if(typeof key!=='string'||!key){await save({...intent,outcome:'unknown'});throw Error('REGISTRATION_KEY_MISSING');}
   // Save secret first, via existing captured pipes. Never print full response.
   await credentialOperation(python,'set',ref,key);
   const claim=typeof agent.claim_url==='string'?new URL(agent.claim_url):null;
   const receipt={...intent,outcome:'succeeded',credential_ref:ref,credential_source:'windows-credential-manager',registered_at:new Date().toISOString(),
    remote_agent_id:agent.id??null,claim_url:claim?.origin==='https://www.moltbook.com'&&claim.pathname.startsWith('/claim/')?claim.href:null,
    verification_code:typeof agent.verification_code==='string'?agent.verification_code:null,status:'pending_claim'};
   await save(receipt);console.log(JSON.stringify(receipt));
  }
 }
}else if(command==='reconcile-registration'){
 const old=JSON.parse(await readFile(registration,'utf8'));
 if(old.outcome!=='unknown'||Date.now()-Date.parse(old.prepared_at)<120000)throw Error('EXACT_SETTLED_UNKNOWN_REGISTRATION_REQUIRED');
 const configured=await credentialOperation(python,'describe',ref);if(configured.configured)throw Error('CREDENTIAL_PRESENT_USE_STATUS');
 const transport=createMoltbookTransport(),checks=[];
 try{
  for(let i=0;i<2;i++){
   const r=await transport.fetch('https://www.moltbook.com/api/v1/agents/profile?name='+encodeURIComponent(old.name),{signal:AbortSignal.timeout(10000)}),body=await r.json();
   checks.push({http_status:r.status,api_message:body.message??null,observed_at:new Date().toISOString(),path:body.path??null});
   if(r.status!==404||body.message!=='Agent not found')throw Error('REGISTRATION_REMOTE_NOT_CONFIRMED_ABSENT');
  }
  await save({...old,outcome:'reconciled_absent',original_outcome:'unknown',reconciliation:{meaning:'Exact public name lookup twice returned official Agent not found; no credential exists. Keep identical name and body; preserve original timeout.',checks}});
  console.log(JSON.stringify({life_id:m.lifeId,name:old.name,outcome:'reconciled_absent',checks}));
 }finally{await transport.close();}
}else if(command==='approve-dm'){
 if(!extra.includes('--human-consent')||!arg1||!arg2)throw Error('EXPLICIT_HUMAN_CONSENT_CONVERSATION_AND_ACTION_REQUIRED');
 const {value:key}=await credentialOperation(python,'resolve',ref);if(!key)throw Error('CREDENTIAL_REQUIRED');
 const grant={lifeId:m.lifeId,conversationId:arg1,actionId:arg2,humanPrincipal:'human:maintainer',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
 await writeFile(approvalFile(stateRoot,arg1),JSON.stringify({grant,signature:signApproval(grant,key)},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({approved:true,...grant}));
}else if(command==='status'||command==='accept-read'||command==='probe-dm'){
 const credentials={resolve:logical=>{if(logical!==ref)throw Error('OWNER_MISMATCH');return credentialOperation(python,'resolve',ref);}};
 // Maintainer read-only diagnostic; does not enable or expose production DM.
 const client=new MoltbookClient({credentials,config:{...config,dmEnabled:command==='probe-dm'}});
 try{
  const actions=command==='status'?['status','me']:command==='probe-dm'?['dm_check','dm_requests','dm_conversations']:['status','me','feed','search','profile','home','notifications'];
  const rows=[];let otherName='ClawdClawderberg';
  for(const action of actions){
   const args=action==='feed'?{limit:2}:action==='search'?{query:'agent tools',limit:2}:action==='profile'?{name:otherName}:{};
   const r=await client.invoke(action,args);
   if(action==='feed')otherName=r.data?.posts?.find(x=>x.author?.name)?.author.name??otherName;
   const data=r.data;
   rows.push({action,ok:r.ok,outcome:r.outcome,http_status:r.http_status??null,error_code:r.error_code??null,
    name:action==='me'?data?.agent?.name??data?.name??null:action==='profile'?otherName:null,
    claim_status:action==='status'?data?.status??null:null,
    result_count:action==='feed'?(data?.posts??[]).length:action==='search'?(data?.results??[]).length:null,
    trust:r.trust,visibility:r.visibility,observed_at:new Date().toISOString()});
  }
  const evidence={life_id:m.lifeId,name_source:'self chosen in native independent Session',credential_ref:ref,results:rows,public_writes:0};
  await writeFile(join(stateRoot,command==='probe-dm'?'last-dm-probe.json':command==='status'?'last-status.json':'last-read-acceptance.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
 }finally{await client.close();}
}else throw Error('SUPPORTED: enable/disable/refresh/register/status/accept-read/approve-dm');
