import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BillingCache,LIFE_IDS,readAgentBilling,readBillingDetails,beijingDate} from './cache.mjs';
import {readSnapshots,difference,deriveSummary,deriveWindows,journalFor} from './snapshots.mjs';

test('exact decimal arithmetic',()=>{
  assert.equal(difference('100.00','90.00'),'10');
  assert.equal(difference('4.9100000000000001','4.76'),'0.1500000000000001');
  assert.equal(difference('1','2'),null);
});
test('official history: failures, previous success, one-hour coverage, reset, rollover, pagination and owner isolation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'official-billing-'));const path=join(root,'cache.json');
  let now=Date.parse('2026-10-07T02:00:00Z'),amount='4.40',failed=false;
  const cache=new BillingCache({path,now:()=>now,query:async()=>{
    if(failed)throw Error('BILLING_RESPONSE_TIMEOUT');
    return {source:'deepseek_platform',date:beijingDate(now),updated_at:new Date(now).toISOString(),
      lives:{[LIFE_IDS[0]]:{today_cost_cny:amount},[LIFE_IDS[1]]:{today_cost_cny:'2.123'}}};
  }});
  const summary=()=>readAgentBilling(LIFE_IDS[0],{path,now});
  try{
    await cache.refresh();assert.equal(summary().latest_billing_delta,null);assert.equal(summary().last_1h_cost,null);
    now+=300000;failed=true;await cache.refresh();assert.equal(summary().data_status,'stale');
    assert.equal(readSnapshots(path).at(-2).latest_billing_delta,null);
    now+=300000;failed=false;amount='4.52';await cache.refresh();assert.equal(summary().latest_billing_delta,'0.12');
    assert.equal(summary().last_10m_delta,'0.12');assert.equal(summary().updated_at,summary().official_updated_at);
    for(let i=0;i<10;i++){now+=300000;await cache.refresh();}
    assert.equal(summary().last_1h_cost,'0.12');
    const details=readBillingDetails(LIFE_IDS[0],{period:'today',limit:2},{path,now});
    assert.deepEqual(details.billing,summary());assert.equal(details.windows.last_1h.cost,summary().last_1h_cost);
    assert.equal(details.windows.last_10m.cost,summary().last_10m_delta);
    assert.equal(details.snapshots.length,2);assert.equal(details.has_more,true);assert(details.next_before);
    assert(!JSON.stringify(details).includes('2.123'));assert(!JSON.stringify(summary()).includes('snapshots'));
    assert.throws(()=>readBillingDetails('life-other',{}, {path,now}));
    now+=300000;amount='1.00';await cache.refresh();assert.equal(summary().latest_billing_delta,null);
    assert.equal(summary().last_1h_cost,null);assert.equal(readSnapshots(path).at(-2).baseline_status,'reset_or_anomaly');
    now+=300000;amount='1.01';await cache.refresh();assert.equal(summary().latest_billing_delta,'0.01');
    now=Date.parse('2026-10-07T16:00:00Z');assert.equal(summary().today_cost,null);
    amount='0.01';await cache.refresh();assert.equal(summary().latest_billing_delta,null);
    assert.equal(readSnapshots(path).at(-2).baseline_status,'rollover');
    assert.equal(summary().last_1h_cost,null);
  }finally{await rm(root,{recursive:true});}
});
test('official sampled windows preserve exact deltas, actual boundaries, missing baselines and key identity',()=>{
  const lifeId=LIFE_IDS[0],date='2026-10-07',origin=Date.parse(date+'T02:00:00Z');
  const sample=(offset,cost,key='key-a',status='continuous')=>({life_id:lifeId,date,fetch_status:'success',timestamp:new Date(origin+offset).toISOString(),
    official_today_cost:cost,key_id:key,baseline_status:status,latest_billing_delta:'0'});
  const rows=[sample(0,'1.0000000000000001'),sample(3000000,'1.1'),sample(3300000,'1.15'),sample(3605000,'1.2000000000000002')];
  assert.equal(deriveSummary(rows,lifeId,date).last_1h_cost,'0.2000000000000001');
  assert.equal(deriveSummary(rows,lifeId,date).last_10m_delta,'0.1000000000000002');
  const windows=deriveWindows(rows,lifeId,date);
  assert.equal(windows.last_10m.actual_interval_ms,605000);assert.equal(windows.last_10m.baseline_at,rows[1].timestamp);
  assert.equal(deriveSummary(rows.slice(1),lifeId,date).last_1h_cost,null);
  assert.equal(deriveSummary(rows.slice(2),lifeId,date).last_10m_delta,'0.0500000000000002');
  assert.equal(deriveWindows(rows.slice(2),lifeId,date).last_10m.interval_deviation_ms,-295000);
  assert.equal(deriveSummary([rows[0],rows[3]],lifeId,date).window_status.last_10m,'baseline_too_recent');
  assert.equal(deriveSummary([...rows.slice(0,3),{...rows[3],key_id:'key-b'}],lifeId,date).window_status.last_10m,'key_changed');
  assert.equal(deriveSummary([...rows.slice(0,3),{...rows[3],baseline_status:'reset_or_anomaly'}],lifeId,date).window_status.last_1h,'reset_or_anomaly');
});
test('nearest real official boundary handles cadence jitter, tie-before and explicit signed intervals',()=>{
  const lifeId=LIFE_IDS[0],date='2026-10-07';
  const sample=(timestamp,cost)=>({life_id:lifeId,date,fetch_status:'success',timestamp,official_today_cost:cost,key_id:'key-a',baseline_status:'continuous'});
  const rows=[sample('2026-10-07T05:16:01.870Z','17.47176024'),sample('2026-10-07T05:24:54.537Z','17.47176024'),sample('2026-10-07T05:34:50.704Z','18.32237284')];
  const window=deriveWindows(rows,lifeId,date).last_10m;
  assert.equal(window.status,'available');assert.equal(window.cost,'0.8506126');
  assert.equal(window.sampling,'nearest_official_snapshot');assert.equal(window.baseline_at,rows[1].timestamp);
  assert.equal(window.nominal_interval_ms,600000);assert.equal(window.tolerance_ms,300000);
  assert.equal(window.actual_interval_ms,596167);assert.equal(window.interval_deviation_ms,-3833);
  const origin=Date.parse('2026-10-07T02:00:00Z'),at=offset=>new Date(origin+offset).toISOString();
  const tied=[sample(at(590000),'1'),sample(at(610000),'2'),sample(at(1200000),'3')];
  const tie=deriveWindows(tied,lifeId,date).last_10m;
  assert.equal(tie.baseline_at,tied[0].timestamp);assert.equal(tie.cost,'2');assert.equal(tie.interval_deviation_ms,10000);
  const hour=[sample(at(600000),'1'),sample(at(3600000),'3')];
  assert.equal(deriveWindows(hour,lifeId,date).last_1h.cost,'2');
  assert.equal(deriveWindows(hour,lifeId,date).last_1h.interval_deviation_ms,-600000);
  const outside=[sample(at(300001),'1'),sample(at(1200000),'3')];
  assert.equal(deriveWindows(outside,lifeId,date).last_10m.status,'available');
  outside[0].timestamp=at(299999);
  assert.equal(deriveWindows(outside,lifeId,date).last_10m.status,'baseline_too_old');
});
test('after-boundary baseline cannot hide a Key transition or reset in the nominal window',()=>{
  const lifeId=LIFE_IDS[0],date='2026-10-07',origin=Date.parse(date+'T02:00:00Z');
  const sample=(offset,cost,key='key-a',status='continuous')=>({life_id:lifeId,date,fetch_status:'success',timestamp:new Date(origin+offset).toISOString(),
    official_today_cost:cost,key_id:key,baseline_status:status});
  const changed=[sample(0,'1'),sample(603833,'2','key-b'),sample(1200000,'3','key-b')];
  const keyWindow=deriveWindows(changed,lifeId,date).last_10m;
  assert.equal(keyWindow.baseline_at,changed[1].timestamp);assert.equal(keyWindow.status,'key_changed');assert.equal(keyWindow.cost,null);
  const reset=[sample(0,'4'),sample(603833,'1','key-a','reset_or_anomaly'),sample(1200000,'2')];
  const resetWindow=deriveWindows(reset,lifeId,date).last_10m;
  assert.equal(resetWindow.baseline_at,reset[1].timestamp);assert.equal(resetWindow.status,'reset_or_anomaly');assert.equal(resetWindow.cost,null);
  // Once the nominal and actual interval both start after the anomaly, it expires.
  const recovered=[...reset,sample(1500000,'3'),sample(1805000,'4')];
  assert.equal(deriveWindows(recovered,lifeId,date).last_10m.cost,'2');
});
test('nearest sampling does not borrow a prior day cumulative amount or claim midnight coverage',()=>{
  const lifeId=LIFE_IDS[0],date='2026-10-08';
  const rows=[{life_id:lifeId,date:'2026-10-07',fetch_status:'success',timestamp:'2026-10-07T15:59:00.000Z',official_today_cost:'99',key_id:'key-a',baseline_status:'continuous'},
    {life_id:lifeId,date,fetch_status:'success',timestamp:'2026-10-07T16:00:30.000Z',official_today_cost:'0.1',key_id:'key-a',baseline_status:'rollover'},
    {life_id:lifeId,date,fetch_status:'success',timestamp:'2026-10-07T16:05:00.000Z',official_today_cost:'0.2',key_id:'key-a',baseline_status:'continuous'}];
  const windows=deriveWindows(rows,lifeId,date);
  assert.equal(windows.last_10m.status,'history_insufficient');assert.equal(windows.last_10m.cost,null);
  assert.equal(windows.last_1h.status,'history_insufficient');assert.equal(windows.last_1h.cost,null);
});
test('summary and details refuse a journal that does not match the confirmed official cache',async()=>{
  const root=await mkdtemp(join(tmpdir(),'official-billing-confirmed-'));const path=join(root,'cache.json');
  const now=Date.parse('2026-10-07T03:00:00Z'),timestamp=new Date(now).toISOString();
  try{
    await writeFile(path,JSON.stringify({last_success:{date:beijingDate(now),updated_at:timestamp,lives:{[LIFE_IDS[0]]:{today_cost_cny:'8.0'}}}}));
    await writeFile(journalFor(path),JSON.stringify({timestamp,date:beijingDate(now),life_id:LIFE_IDS[0],key_id:'key-a',fetch_status:'success',official_today_cost:'7.0',baseline_status:'continuous'})+'\n');
    const billing=readAgentBilling(LIFE_IDS[0],{path,now}),details=readBillingDetails(LIFE_IDS[0],{}, {path,now});
    assert.equal(billing.today_cost,'8.0');assert.equal(billing.last_1h_cost,null);assert.equal(billing.last_10m_delta,null);
    assert.equal(billing.window_status.last_1h,'history_not_confirmed');assert.deepEqual(details.billing,billing);
    assert.equal(details.windows.last_10m.cost,null);assert.equal(details.windows.last_10m.status,'history_not_confirmed');
  }finally{await rm(root,{recursive:true});}
});
