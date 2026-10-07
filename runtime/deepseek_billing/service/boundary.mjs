import {resolve} from 'node:path';
import {canonical,contains} from '../../native_dsh/multi-life/contracts.mjs';
export function mountBillingBoundary(ctx){
 if(ctx.get('deepseekBillingBoundary'))return;
 const root=canonical(resolve(process.env.LOCALAPPDATA,'PersonaHost/DeepSeekBillingBrowser'));
 const deny=()=>{const e=Error('TRUSTED_CONTROL_RESOURCE');e.code='TRUSTED_CONTROL_RESOURCE';throw e;};
 const check=path=>{if(contains(root,canonical(path)))deny();};
 const policy=ctx.get('normalInterfaceOwnership');
 if(policy){const original=policy.pathFor;policy.pathFor=function(owner,path,...rest){check(path);return original.call(this,owner,path,...rest);};ctx.effect(()=>()=>{policy.pathFor=original;});}
 ctx.on('tools/execute',async(exec,next)=>{
  // Extend the existing Host control fence to this dedicated credential profile.
  // Opaque terminals retain the existing Windows-user sandbox limitation.
  if(/deepseekbillingbrowser|deepseek-billing-profile/i.test(JSON.stringify(exec.arguments??{})))deny();
  return next();
 },{prepend:true});
 ctx.provide('deepseekBillingBoundary',{check});
}
