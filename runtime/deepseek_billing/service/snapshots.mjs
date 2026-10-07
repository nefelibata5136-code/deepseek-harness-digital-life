import {readFileSync} from 'node:fs';
import {appendFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';

// Decimal subtraction without converting official amounts to floating point.
export function difference(a,b){
  const scale=Math.max((a.split('.')[1]??'').length,(b.split('.')[1]??'').length);
  const integer=s=>{const [whole,fraction='']=s.split('.');return BigInt(whole+fraction.padEnd(scale,'0'));};
  const value=integer(a)-integer(b);if(value<0n)return null;
  if(!scale)return String(value);
  const digits=String(value).padStart(scale+1,'0');
  return (digits.slice(0,-scale)+'.'+digits.slice(-scale)).replace(/\.?0+$/,'')||'0';
}
export const journalFor=path=>join(dirname(path),'snapshots.jsonl');
export function readSnapshots(path){
  try{return readFileSync(journalFor(path),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
  catch(error){if(error.code==='ENOENT')return [];throw Error('BILLING_HISTORY_UNAVAILABLE');}
}
export async function appendSnapshots(path,rows){
  await mkdir(dirname(path),{recursive:true});
  await appendFile(journalFor(path),rows.map(row=>JSON.stringify(row)+'\n').join(''));
}
export function successRow({timestamp,date,lifeId,keyId,cost,previous}){
  const sameDay=previous?.date===date;
  const delta=sameDay?difference(cost,previous.official_today_cost):null;
  return {timestamp,date,life_id:lifeId,key_id:keyId,official_today_cost:cost,currency:'CNY',fetch_status:'success',
    latest_billing_delta:delta,baseline_status:!previous?'baseline':!sameDay?'rollover':delta===null?'reset_or_anomaly':'continuous'};
}
// Windows measure official posted cumulative deltas as of the confirmed snapshot,
// not model-request occurrence time. Keep the real sampled boundary inspectable.
export function deriveWindows(rows,lifeId,date){
  const successful=rows.filter(row=>row.life_id===lifeId&&row.fetch_status==='success'&&row.date===date)
    .sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  const latest=successful.at(-1);
  function window(duration,tolerance){
    const target=latest?Date.parse(latest.timestamp)-duration:null;
    const base={as_of:latest?.timestamp??null,requested_start_at:target===null?null:new Date(target).toISOString(),
      sampling:'nearest_official_snapshot',nominal_interval_ms:duration,tolerance_ms:tolerance,
      baseline_at:null,actual_interval_ms:null,interval_deviation_ms:null,cost:null,status:'history_insufficient'};
    if(!latest)return base;
    // A daily cumulative amount cannot cover a nominal window crossing midnight.
    if(new Date(target+28800000).toISOString().slice(0,10)!==date)return base;
    // Use two real snapshots. Choose the closest boundary in either direction;
    // an equal distance prefers the earlier sample. Never interpolate amounts.
    const baseline=successful.reduce((chosen,row)=>{
      const time=Date.parse(row.timestamp),distance=Math.abs(time-target);
      const previous=Date.parse(chosen.timestamp),previousDistance=Math.abs(previous-target);
      return distance<previousDistance||(distance===previousDistance&&time<previous)?row:chosen;
    });
    const baselineTime=Date.parse(baseline.timestamp),actualInterval=Date.parse(latest.timestamp)-baselineTime;
    const sampled={...base,baseline_at:baseline.timestamp,actual_interval_ms:actualInterval,interval_deviation_ms:actualInterval-duration};
    if(Math.abs(target-baselineTime)>tolerance)return {...sampled,status:baselineTime<target?'baseline_too_old':'baseline_too_recent'};
    // A later baseline shortens the observed interval, but must not hide a Key
    // transition or reset between the nominal boundary and that chosen sample.
    const guardStart=Math.min(target,baselineTime);
    const guarded=successful.filter(row=>Date.parse(row.timestamp)>guardStart);
    if(guarded.some(row=>row.key_id!==baseline.key_id)||successful.some((row,index)=>
      index>0&&Date.parse(row.timestamp)>guardStart&&row.key_id!==successful[index-1].key_id))return {...sampled,status:'key_changed'};
    if(guarded.some(row=>row.baseline_status==='reset_or_anomaly'||row.baseline_status==='rollover'))return {...sampled,status:'reset_or_anomaly'};
    const segment=successful.slice(successful.indexOf(baseline)+1);
    if(segment.some(row=>row.baseline_status!=='continuous'))return {...sampled,status:'reset_or_anomaly'};
    const amount=difference(latest.official_today_cost,baseline.official_today_cost);
    return {...sampled,cost:amount,status:amount===null?'reset_or_anomaly':'available'};
  }
  return {last_1h:window(3600000,600000),last_10m:window(600000,300000),latest_billing_delta:latest?.latest_billing_delta??null};
}
export function deriveSummary(rows,lifeId,date){
  const windows=deriveWindows(rows,lifeId,date);
  return {sampling:'nearest_official_snapshot',last_1h_cost:windows.last_1h.cost,last_10m_delta:windows.last_10m.cost,latest_billing_delta:windows.latest_billing_delta,
    window_status:{last_1h:windows.last_1h.status,last_10m:windows.last_10m.status}};
}
export function detailsFor(rows,lifeId,{period='today',limit=100,before=null,now=Date.now(),date}={}){
  if(!['today','last_1h','snapshots'].includes(period))throw Error('BILLING_PERIOD_INVALID');
  if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('BILLING_LIMIT_INVALID');
  if(before!==null&&!Number.isFinite(Date.parse(before)))throw Error('BILLING_CURSOR_INVALID');
  const own=rows.filter(row=>row.life_id===lifeId&&(period==='snapshots'||row.date===date)&&
    (period!=='last_1h'||Date.parse(row.timestamp)>=now-3600000)&&(before===null||Date.parse(row.timestamp)<Date.parse(before)));
  const selected=own.slice(-limit);
  return {source:'deepseek_official',currency:'CNY',expected_lag_minutes:'5-10',period,snapshots:selected.map(({life_id,key_id,...row})=>row),
    has_more:own.length>selected.length,next_before:own.length>selected.length?selected[0].timestamp:null};
}
