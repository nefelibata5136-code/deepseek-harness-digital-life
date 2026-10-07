import test from 'node:test';
import assert from 'node:assert/strict';
import {viewForLife,LIFE_IDS} from './cache.mjs';
import {billingError} from './errors.mjs';
import {recoverBilling} from './recovery.mjs';
test('both owners see precise login failure and safe recovery without other cost',()=>{
 const state={last_error:'BILLING_LOGIN_REQUIRED',consecutive_failures:4,last_attempt_at:'2026-10-07T01:40:00Z',last_completed_at:'2026-10-07T01:40:04Z',last_success:{date:'2026-10-07',updated_at:'2026-10-07T01:00:00Z',lives:{[LIFE_IDS[0]]:{today_cost_cny:'5.40'},[LIFE_IDS[1]]:{today_cost_cny:'9.96'}}}};
 for(const [index,id] of LIFE_IDS.entries()){
  const value=viewForLife(state,id,Date.parse('2026-10-07T01:41:00Z'));
  assert.equal(value.stale,true);assert.equal(value.error.code,'BILLING_LOGIN_REQUIRED');assert.equal(value.error.human_required,true);assert.equal(value.error.consecutive_failures,4);
  assert(value.error.recovery.steps.some(s=>s.includes('用户')));assert(!JSON.stringify(value).includes(index===0?'9.96':'5.40'));
 }
});
test('untrusted error text is replaced, not emitted to model',()=>{
 const value=billingError({last_error:'secret-cookie-test-value'});assert.equal(value.code,'OFFICIAL_REFRESH_FAILED');assert(!JSON.stringify(value).includes('secret-cookie'));
});
test('recovery only accepts trusted owner and fixed actions',async()=>{
 await assert.rejects(recoverBilling('unknown','retry'),/OWNER_REQUIRED/);
 await assert.rejects(recoverBilling(LIFE_IDS[0],'execute_arbitrary_code'),/ACTION_REQUIRED/);
 const result=await recoverBilling(LIFE_IDS[0],'status');assert.match(result.maintenance.guide,/[\\/]docs[\\/]optional-services\.md$/);assert(!JSON.stringify(result).includes('9.96096808'));
});
