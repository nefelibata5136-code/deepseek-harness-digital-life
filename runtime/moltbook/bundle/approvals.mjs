// A local text assertion cannot approve a DM. Verify the maintainer's signed
// exact-owner/exact-conversation grant using the hidden account credential.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
export const approvalFile=(stateRoot,conversationId)=>resolve(stateRoot,'approval-'+createHash('sha256').update(conversationId).digest('hex')+'.json');
export function signApproval(grant,key){return createHmac('sha256',key).update(JSON.stringify(grant)).digest('hex');}
export function readApproved({lifeId,actionId,conversationId},stateRoot,key){
 try{
  if(typeof key!=='string'||!key)return false;
  const {grant,signature}=JSON.parse(readFileSync(approvalFile(stateRoot,conversationId),'utf8'));
  if(grant?.lifeId!==lifeId||grant?.actionId!==actionId||grant?.conversationId!==conversationId||grant?.humanPrincipal!=='human:maintainer'||Date.parse(grant.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(grant.expiresAt)))return false;
  if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))return false;
  return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(signApproval(grant,key),'hex'));
 }catch{return false;}
}
