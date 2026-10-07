import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {readBilling} from './cache.mjs?diagnostics=1';
export const inject=['connection'];
const root=resolve(import.meta.dirname,'../../multi_life_supervisor');
function lifeForSession(id){
  const registry=JSON.parse(readFileSync(resolve(root,'registry/registry.json'),'utf8'));
  let row=registry.sessions?.[id];if(row)return row.lifeId;
  for(const life of Object.values(registry.lives)){
    try{const mirror=JSON.parse(readFileSync(resolve(root,'workers',life.lifeId,'registry/registry.json'),'utf8'));row=mirror.sessions?.[id];if(row?.lifeId===life.lifeId)return row.lifeId;}catch{}
  }
  throw Error('BILLING_SESSION_OWNER_UNKNOWN');
}
const json=(value,options={})=>new Response(JSON.stringify(value),{...options,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
export function apply(ctx){ctx.effect(()=>ctx.connection.fetch.register({path:'/api/persona.billing',methods:['GET'],requestBody:'buffered',fetch:async request=>{
  try{const id=new URL(request.url).searchParams.get('sessionId');if(!/^[a-f0-9-]{36}$/i.test(id??''))throw Error('BILLING_SESSION_REQUIRED');
    return json({billing:readBilling(lifeForSession(id))},{headers:{'cache-control':'no-store'}});
  }catch{return json({error:'BILLING_SESSION_OWNER_UNKNOWN'},{status:403,headers:{'cache-control':'no-store'}});}
}}));}
