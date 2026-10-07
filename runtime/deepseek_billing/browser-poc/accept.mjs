// Official frontend authenticates. Host captures only the fixed billing response.
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=createRequire(new URL('../../native_dsh/package.json',import.meta.url))('playwright');
const started=Date.now();let browser;let stage='connect';
const path='/api/v0/usage/by_api_key/cost';
const observedNow=Math.floor(Date.now()/1000),start=Math.floor((observedNow+28800)/86400)*86400-28800;
const end=Math.ceil(observedNow/3600)*3600;
const report=fileURLToPath(new URL('../../../reports/deepseek-billing-browser-poc-20261007/',import.meta.url));
try {
  browser=process.argv.includes('--headless')?await chromium.launchPersistentContext(process.env.LOCALAPPDATA+'/PersonaHost/DeepSeekBillingBrowser/deepseek-billing-profile',{channel:'chrome',headless:true}):await chromium.connectOverCDP('http://127.0.0.1:18746');
  let page=(process.argv.includes('--headless')?browser:browser.contexts()[0]).pages().find(p=>p.url().startsWith('https://platform.deepseek.com/'));
  if(!page&&process.argv.includes('--headless'))page=browser.pages()[0]??await browser.newPage();if(!page)throw Error('DEDICATED_PAGE_REQUIRED');
  await page.route('**/api/v0/usage/by_api_key/cost*',route=>{
    const u=new URL(route.request().url());
    if(u.origin!=='https://platform.deepseek.com'||u.pathname!==path)return route.continue();
    u.searchParams.set('start',String(start));u.searchParams.set('end',String(end));u.searchParams.set('tz','28800');
    return route.continue({url:u.href}); // Never read or construct authentication headers.
  });
  stage='capture';
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname===path,{timeout:30000});
  await page.goto('https://platform.deepseek.com/usage',{waitUntil:'domcontentloaded',timeout:30000});
  const response=await pending;const envelope=await response.json();
  const data=envelope.data?.biz_data;
  console.log(JSON.stringify({stage:'envelope',http_status:response.status(),code:envelope.code,biz_code:envelope.data?.biz_code,parameter_error:envelope.data?.biz_code?String(envelope.data?.biz_msg??'').replace(/[a-zA-Z0-9_-]{16,}/g,'[REDACTED]').slice(0,180):null,requested:{start,end},returned:{start:data?.start,end:data?.end,bucket:data?.bucket}}));
  if(response.status()!==200||envelope.code!==0||envelope.data?.biz_code!==0||!Array.isArray(data?.data)||data.start!==start||data.end!==end)throw Error('OFFICIAL_BILLING_FAILED');
  if(data.data.length!==1||data.data[0].currency!=='CNY')throw Error('CNY_REQUIRED');
  const queryMs=Date.now()-started;
  const series=data.data[0].series.map(s=>({api_key:{tracking_id:s.api_key.tracking_id,name:s.api_key.name,sensitive_id:s.api_key.sensitive_id},model:s.model,buckets:s.buckets.map(b=>({time:b.time,cost:b.cost}))}));
  const python=(process.env.DL_PYTHON || 'python');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'].includes(k.toUpperCase())));
  stage='mapping';
  const verified=spawnSync(python,['-B',fileURLToPath(new URL('./verify_cost.py',import.meta.url))],{input:JSON.stringify({series,start,end}),env,windowsHide:true,encoding:'utf8'});
  if(verified.status!==0)throw Error('MAPPING_OR_DECIMAL_FAILED');
  const result=JSON.parse(verified.stdout);
  // Use the site's actual date and per-Key controls; no account-total comparison.
  stage='ui-date';
  const dateControl=page.getByRole('button',{name:/时间维度/});
  if(!(await dateControl.innerText()).includes('今天')){
    await dateControl.click();
    await page.getByText('今天',{exact:true}).last().click();
  }
  await page.waitForTimeout(1500);
  const ui=[];
  for(const life of result.lives){
    stage='ui-key-'+life.api_key_identity.name;
    const clear=page.getByRole('button',{name:'清除筛选条件',exact:true});
    if(await clear.isVisible()){await clear.click();await page.waitForTimeout(300);}
    await page.getByRole('button',{name:/API Key/}).click();
    await page.getByText(life.api_key_identity.name,{exact:true}).last().click();
    const other=life.api_key_identity.name==='persona'?'new digital life':'persona';
    if(await page.getByText(other,{exact:true}).last().isVisible().catch(()=>false))await page.getByRole('button',{name:/API Key/}).click();
    await page.waitForTimeout(1000);
    const selectedKey=await page.getByRole('button',{name:/API Key/}).innerText();
    const observation=await page.evaluate(()=>{
      const text=document.body.innerText;
      const m=text.match(/导出\s*消费金额\s*¥([\d,.]+)\s*CNY/);
      return {displayed_cost_cny:m?m[1].replaceAll(',',''):null};
    });
    const onlyOwnKey=selectedKey.replace(/API Key\s*/,'').trim()===life.api_key_identity.name;
    ui.push({life_id:life.life_id,key_name:life.api_key_identity.name,only_own_key_selected:onlyOwnKey,...observation,expected_display_cny:life.official_ui_display_cny,display_policy:'observed official UI truncation to 2 decimals',matches:onlyOwnKey&&observation.displayed_cost_cny===life.official_ui_display_cny});
  }
  const safe={...result,fetched_at:new Date(started+queryMs).toISOString(),report_generated_at:new Date().toISOString(),query_observed_at:new Date(observedNow*1000).toISOString(),requested_exact_end:observedNow,exact_second_end_supported:false,end_alignment:'next whole hour; official API rejected exact current second with INVALID_PARAM',official_delay_notice:'Usage page states data may lag 5 minutes',query_elapsed_ms:queryMs,total_elapsed_ms:Date.now()-started,official_response_schema:'code -> data.{biz_code,biz_msg,biz_data.{start,end,bucket,models,data:[{currency,series:[{api_key:{tracking_id,name,sensitive_id,valid,key_type},model,buckets:[{time,cost:string}]}]}]}}',bucket_seconds:data.bucket,ui_reconciliation:ui,ui_all_match:ui.every(x=>x.matches),browser_path:new URL(page.url()).pathname};
  await mkdir(report,{recursive:true});await writeFile(report+'billing-evidence.json',JSON.stringify(safe,null,2));
  console.log(JSON.stringify({...safe,lives:safe.lives.map(({buckets,...rest})=>rest)}));
}catch(error){console.log(JSON.stringify({error:/^[A-Z_]+$/.test(error.message)?error.message:'BILLING_ACCEPTANCE_FAILED',strict_locator:error.message.includes('strict mode violation'),timeout:error.name==='TimeoutError',stage,elapsed_ms:Date.now()-started}));process.exitCode=1;}
finally{if(browser)await browser.close();}
