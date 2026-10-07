import {readFileSync} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {billingError} from './errors.mjs';
import {readSnapshots,appendSnapshots,successRow,deriveSummary,deriveWindows,detailsFor} from './snapshots.mjs?official-v1=4';
export const INTERVAL_MS=300000;
const publicRoot=resolve(process.env.DL_WORLD_ROOT || '.local/world');
let configured;try{configured=JSON.parse(readFileSync(resolve(publicRoot,'settings.json'),'utf8'));}catch{}
let identities;try{identities=JSON.parse(readFileSync(resolve(publicRoot,'billing-identities.json'),'utf8'));}catch{identities={};}
export const LIFE_IDS=configured?.lives.map(l=>l.lifeId) ?? (process.env.NODE_TEST_CONTEXT?['life-test-owner-a','life-test-owner-b']:[]);
export const cachePath=resolve(publicRoot,'supervisor/deepseek-billing/cache.json');
export const beijingDate=ms=>new Date(ms+28800000).toISOString().slice(0,10);
const cost=value=>typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)&&value.length<100;
export function viewForLife(state,lifeId,now=Date.now()) {
  if(!LIFE_IDS.includes(lifeId))throw Error('BILLING_OWNER_REQUIRED');
  const base={source:'deepseek_platform',date:beijingDate(now),today_cost_cny:null,updated_at:null,stale:true,refresh_interval_ms:INTERVAL_MS,official_delay_seconds:300,error:billingError(state),last_attempt_at:state?.last_attempt_at??null};
  if(!state?.last_success||state.last_success.date!==base.date)return {...base,unavailable_reason:state?.last_success?'awaiting_new_day':'official_billing_unavailable'};
  const success=state.last_success,row=success.lives?.[lifeId],time=Date.parse(success.updated_at);
  if(!cost(row?.today_cost_cny)||!Number.isFinite(time)||time>now+1000)return {...base,unavailable_reason:'invalid_official_snapshot'};
  const failed=!!state.last_error&&Date.parse(state.last_attempt_at)>=time;
  return {...base,today_cost_cny:row.today_cost_cny,updated_at:success.updated_at,stale:failed||now-time>INTERVAL_MS,
    unavailable_reason:failed?'official_refresh_failed':now-time>INTERVAL_MS?'cache_overdue':null};
}
export function readBilling(lifeId,{path=cachePath,now=Date.now()}={}) {
  let state;try{state=JSON.parse(readFileSync(path,'utf8'));}catch{}
  return viewForLife(state,lifeId,now);
}
export function readAgentBilling(lifeId,{path=cachePath,now=Date.now()}={}){
  const legacy=readBilling(lifeId,{path,now});let derived={sampling:'nearest_official_snapshot',last_1h_cost:null,last_10m_delta:null,latest_billing_delta:null,
    window_status:{last_1h:'history_unavailable',last_10m:'history_unavailable'}};
  try{if(legacy.today_cost_cny!==null){
    const rows=readSnapshots(path).filter(row=>Date.parse(row.timestamp)<=Date.parse(legacy.updated_at));
    const confirmed=rows.findLast(row=>row.life_id===lifeId&&row.fetch_status==='success');
    // Atomic cache publication follows journal append. Do not mix an older journal
    // baseline with a different currently confirmed amount during a concurrent read.
    if(confirmed?.timestamp===legacy.updated_at&&confirmed.official_today_cost===legacy.today_cost_cny)
      derived=deriveSummary(rows,lifeId,legacy.date);
    else derived.window_status={last_1h:'history_not_confirmed',last_10m:'history_not_confirmed'};
  }}catch{}
  return {source:'deepseek_official',today_cost:legacy.today_cost_cny,currency:'CNY',...derived,
    updated_at:legacy.updated_at,official_updated_at:legacy.updated_at,expected_lag_minutes:'5-10',data_status:legacy.today_cost_cny===null?'missing':legacy.stale?'stale':'fresh',
    ...(legacy.error?{last_fetch_failed_at:legacy.last_attempt_at}:{})};
}
export function readBillingDetails(lifeId,args={},options={}){
  if(!LIFE_IDS.includes(lifeId))throw Error('BILLING_OWNER_REQUIRED');
  const {path=cachePath,now=Date.now()}=options;
  const billing=readAgentBilling(lifeId,{path,now});
  const rows=readSnapshots(path);
  const confirmed=rows.filter(row=>Date.parse(row.timestamp)<=Date.parse(billing.updated_at));
  const windows=deriveWindows(confirmed,lifeId,beijingDate(now));
  for(const name of ['last_1h','last_10m'])if(billing.window_status[name].startsWith('history_')&&billing.window_status[name]!=='history_insufficient')
    windows[name]={...windows[name],cost:null,status:billing.window_status[name]};
  return {...detailsFor(rows,lifeId,{...args,now,date:beijingDate(now)}),billing,
    windows};
}
export class BillingCache {
  constructor({path=cachePath,query,now=Date.now}={}){this.path=path;this.query=query;this.now=now;this.pending=null;this.state={version:1,refresh_count:0};try{this.state=JSON.parse(readFileSync(path,'utf8'));}catch{}}
  read(lifeId){return viewForLife(this.state,lifeId,this.now());}
  async refresh(){
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      const started=this.now();this.state.last_attempt_at=new Date(started).toISOString();
      try {
        const result=await this.query();
        if(result.source!=='deepseek_platform'||result.date!==beijingDate(started)||result.date!==beijingDate(this.now())||LIFE_IDS.some(id=>!cost(result.lives?.[id]?.today_cost_cny)))throw Error('BILLING_SNAPSHOT_INVALID');
        const timestamp=Date.parse(result.updated_at);
        if(!Number.isFinite(timestamp)||timestamp<started-1000||timestamp>this.now()+1000)throw Error('BILLING_SNAPSHOT_INVALID');
        const history=readSnapshots(this.path);
        // Preserve the last pre-upgrade confirmed snapshot as a baseline; do not invent earlier history.
        if(!history.length&&this.state.last_success){
          const prior=this.state.last_success;
          const seeds=LIFE_IDS.filter(id=>cost(prior.lives?.[id]?.today_cost_cny)).map(id=>successRow({timestamp:prior.updated_at,date:prior.date,lifeId:id,keyId:identities[id]?.tracking_id??null,cost:prior.lives[id].today_cost_cny}));
          await appendSnapshots(this.path,seeds);history.push(...seeds);
        }
        const rows=LIFE_IDS.map(id=>successRow({timestamp:result.updated_at,date:result.date,lifeId:id,keyId:identities[id]?.tracking_id??null,cost:result.lives[id].today_cost_cny,
          previous:history.findLast(row=>row.life_id===id&&row.fetch_status==='success')}));
        await appendSnapshots(this.path,rows);
        // Only safe derived status is persisted. Platform Key metadata stays in worker memory.
        this.state.last_success={source:result.source,date:result.date,updated_at:result.updated_at,elapsed_ms:result.elapsed_ms,
          lives:Object.fromEntries(LIFE_IDS.map(id=>[id,{today_cost_cny:result.lives[id].today_cost_cny}]))};
        this.state.last_error=null;this.state.consecutive_failures=0;
      }catch(error){this.state.last_error=/^[A-Z_]+$/.test(error.message)?error.message:'OFFICIAL_REFRESH_FAILED';this.state.consecutive_failures=(this.state.consecutive_failures??0)+1;
        await appendSnapshots(this.path,LIFE_IDS.map(id=>({timestamp:new Date(started).toISOString(),date:beijingDate(started),life_id:id,key_id:identities[id]?.tracking_id??null,
          official_today_cost:null,currency:'CNY',fetch_status:'failed',error:this.state.last_error,latest_billing_delta:null})));}
      this.state.refresh_count=(this.state.refresh_count??0)+1;
      this.state.last_completed_at=new Date(this.now()).toISOString();this.state.refresh_interval_ms=INTERVAL_MS;
      await mkdir(dirname(this.path),{recursive:true});const temp=this.path+'.'+randomUUID()+'.tmp';
      await writeFile(temp,JSON.stringify(this.state,null,2)+'\n',{flag:'wx'});await rename(temp,this.path);
      return {refresh_count:this.state.refresh_count,last_error:this.state.last_error};
    })().finally(()=>{this.pending=null;});return this.pending;
  }
}
