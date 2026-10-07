import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BillingCache,viewForLife,LIFE_IDS,INTERVAL_MS,beijingDate} from './cache.mjs';
const moment=Date.parse('2026-10-07T04:00:00Z');
function success(now=moment){return {source:'deepseek_platform',date:beijingDate(now),updated_at:new Date(now).toISOString(),lives:{[LIFE_IDS[0]]:{today_cost_cny:'1.234567'},[LIFE_IDS[1]]:{today_cost_cny:'0.008'}}};}
test('conversations share cached reads without query; per-life isolation and exact decimals',async()=>{
 const root=await mkdtemp(join(tmpdir(),'billing-'));let calls=0;const c=new BillingCache({path:join(root,'cache.json'),now:()=>moment,query:async()=>{calls++;return success();}});
 try{await c.refresh();for(let i=0;i<100;i++){assert.equal(c.read(LIFE_IDS[0]).today_cost_cny,'1.234567');assert.equal(c.read(LIFE_IDS[1]).today_cost_cny,'0.008');}assert.equal(calls,1);assert(!JSON.stringify(c.read(LIFE_IDS[0])).includes('0.008'));}finally{await rm(root,{recursive:true});}
});
test('single-flight concurrent refresh and failure retains official value marked stale',async()=>{
 const root=await mkdtemp(join(tmpdir(),'billing-'));let now=moment,calls=0,fail=false;const c=new BillingCache({path:join(root,'cache.json'),now:()=>now,query:async()=>{calls++;if(fail)throw Error('BILLING_LOGIN_REQUIRED');await new Promise(r=>setTimeout(r,10));return success();}});
 try{await Promise.all([c.refresh(),c.refresh(),c.refresh()]);assert.equal(calls,1);now+=INTERVAL_MS;fail=true;await c.refresh();assert.equal(c.read(LIFE_IDS[0]).today_cost_cny,'1.234567');assert.equal(c.read(LIFE_IDS[0]).stale,true);}finally{await rm(root,{recursive:true});}
});
test('Beijing midnight hides yesterday; stale age and forged future timestamp',()=>{
 const state={last_success:success()};assert.equal(viewForLife(state,LIFE_IDS[0],moment+INTERVAL_MS+1).stale,true);
 const midnight=Date.parse('2026-10-07T16:00:00Z');assert.equal(viewForLife(state,LIFE_IDS[0],midnight).today_cost_cny,null);assert.equal(viewForLife(state,LIFE_IDS[0],midnight).date,'2026-10-08');
 assert.equal(viewForLife({last_success:success(moment+100000)},LIFE_IDS[0],moment).today_cost_cny,null);
 assert.throws(()=>viewForLife(state,'life-other',moment));
});
