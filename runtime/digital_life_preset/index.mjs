/** Bind authenticated composer receipts; authoritative life stays in the protected Host. */
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {mountHumanInput,inject as humanInputInject} from './human-input.mjs';

export const inject=humanInputInject;
export function apply(ctx,config={}) {
  const root=config.root??resolve(homedir(),'.dsh','state','digital-life-human-input');
  const receipts=mountHumanInput(ctx,{root});
  // Non-secret local diagnostics prove which desktop process mounted the seam.
  const activation=resolve(root,'activation.json'),instance=randomUUID(),temporary=activation+'.'+instance+'.tmp';
  ctx.effect(()=>()=>{
    receipts.dispose();
    try{if(JSON.parse(readFileSync(activation,'utf8')).instance===instance)unlinkSync(activation);}catch(error){if(error.code!=='ENOENT')throw error;}
  },'authenticated Digital Life composer receipts');
  ctx.provide('digitalLifeHumanInput',receipts);
  writeFileSync(temporary,JSON.stringify({schema_version:1,instance,pid:process.pid,module_url:import.meta.url,
    implementation_revision:'2026-10-07-human-ingress-v1',loaded_at_utc:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
  renameSync(temporary,activation);
}
