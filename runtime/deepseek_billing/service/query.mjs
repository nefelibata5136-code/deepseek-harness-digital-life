import {billingEnvironment} from './environment.mjs';
// Host-only official-page response reader. Resident mode retains browser/session.
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {waitForBillingResponse} from './auth.mjs';
const {chromium}=createRequire(new URL('../../native_dsh/package.json',import.meta.url))('playwright');
const endpoint='/api/v0/usage/by_api_key/cost';
let context;
async function query(){
 const observed=Date.now(),now=Math.floor(observed/1000),start=Math.floor((now+28800)/86400)*86400-28800,end=Math.ceil(now/3600)*3600;
 let stage='launch',page,routeHandler;
 try {
  if(!context)context=await chromium.launchPersistentContext(join(process.env.LOCALAPPDATA,'PersonaHost/DeepSeekBillingBrowser/deepseek-billing-profile'),{channel:'chrome',headless:true,viewport:{width:1200,height:800}});
  page=context.pages().find(p=>!p.isClosed())??await context.newPage();stage='navigation';
  routeHandler=route=>{
   const url=new URL(route.request().url());if(url.origin!=='https://platform.deepseek.com'||url.pathname!==endpoint)return route.continue();
   url.searchParams.set('start',String(start));url.searchParams.set('end',String(end));url.searchParams.set('tz','28800');return route.continue({url:url.href});
  };
  await page.route('**/api/v0/usage/by_api_key/cost*',routeHandler);
  const received=page.waitForResponse(r=>new URL(r.url()).origin==='https://platform.deepseek.com'&&new URL(r.url()).pathname===endpoint,{timeout:25000});received.catch(()=>{});
  const responsePromise=waitForBillingResponse(page,received);responsePromise.catch(()=>{});
  await page.goto('https://platform.deepseek.com/usage',{waitUntil:'domcontentloaded',timeout:25000});stage='response';
  const response=await responsePromise,value=await response.json(),data=value.data?.biz_data;stage='verification';
  if(response.status()!==200||value.code!==0||value.data?.biz_code!==0||data?.start!==start||data?.end!==end)throw Error('OFFICIAL_BILLING_UNAVAILABLE');
  if(data.data.length!==1||data.data[0].currency!=='CNY')throw Error('BILLING_CURRENCY_UNSUPPORTED');
  const series=data.data[0].series.map(s=>({api_key:{tracking_id:s.api_key.tracking_id,name:s.api_key.name,sensitive_id:s.api_key.sensitive_id},model:s.model,buckets:s.buckets.map(b=>({time:b.time,cost:b.cost}))}));
  const env=billingEnvironment();
  const verification=spawnSync(process.env.DL_PYTHON||'python',['-B',fileURLToPath(new URL('../browser-poc/verify_cost.py',import.meta.url))],{input:JSON.stringify({series,start,end}),env,windowsHide:true,encoding:'utf8',timeout:10000});
  if(verification.status!==0)throw Error('BILLING_KEY_MAPPING_UNAVAILABLE');const result=JSON.parse(verification.stdout);
  return {source:'deepseek_platform',date:new Date((start+28800)*1000).toISOString().slice(0,10),updated_at:new Date().toISOString(),query_started_at:new Date(observed).toISOString(),elapsed_ms:Date.now()-observed,start,end,bucket_seconds:data.bucket,
   lives:Object.fromEntries(result.lives.map(l=>[l.life_id,{today_cost_cny:l.today_cost_cny,identity:l.api_key_identity,models:l.models}]))};
 }catch(error){
  if(page&&!page.isClosed()){
   if(/^\/(?:sign[_-]?in|login)(?:\/|$)/i.test(new URL(page.url()).pathname))error=Error('BILLING_LOGIN_REQUIRED');
   else if(error.name==='TimeoutError'){
    const verification=await page.evaluate(()=>/captcha|人机验证|checking your browser/i.test(document.body.innerText)).catch(()=>false);
    if(verification)error=Error('BILLING_VERIFICATION_REQUIRED');
   }
  }
  const code=/^[A-Z_]+$/.test(error.message)?error.message:/ProcessSingleton|profile.*in use|SingletonLock/i.test(error.message)?'BILLING_PROFILE_IN_USE':error.name==='TimeoutError'?'BILLING_'+stage.toUpperCase()+'_TIMEOUT':'BILLING_'+stage.toUpperCase()+'_FAILED';
  return {error:code};
 }finally{if(page&&!page.isClosed()&&routeHandler)await page.unroute('**/api/v0/usage/by_api_key/cost*',routeHandler).catch(()=>{});}
}
try{
 if(process.argv.includes('--resident')){
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
   if(line.trim()!=='query')continue;
   console.log(JSON.stringify(await query()));
  }
 }else{const value=await query();console.log(JSON.stringify(value));if(value.error)process.exitCode=1;}
}finally{await context?.close().catch(()=>{});}
