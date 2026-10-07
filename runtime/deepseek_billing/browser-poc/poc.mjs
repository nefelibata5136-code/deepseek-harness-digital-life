// Host-only PoC. Never read cookies, localStorage, headers or provider secrets.
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=createRequire(new URL('../../native_dsh/package.json',import.meta.url))('playwright');
const python=process.env.DL_PYTHON||'python';
const controller=fileURLToPath(new URL('./control.py',import.meta.url));
const action=process.argv[2]??'open';
const environment=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC'].includes(k.toUpperCase())));
function lifecycle(action){const r=spawnSync(python,['-B',controller,action],{env:environment,windowsHide:true,encoding:'utf8'});if(r.status!==0)throw Error('BROWSER_LIFECYCLE_FAILED');return JSON.parse(r.stdout);}
function shape(v,d=0){if(d>10)return 'depth_limit';if(Array.isArray(v))return {type:'array',length:v.length,items:v.slice(0,2).map(x=>shape(x,d+1))};if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>/^[a-zA-Z0-9_-]{1,64}$/.test(k)).map(([k,x])=>[k,shape(x,d+1)]));return v===null?'null':typeof v;}
const started=Date.now();let browser;
try {
  const state=lifecycle(action==='stop'?'stop':action==='status'?'status':'open');
  if(['stop','status'].includes(action)){console.log(JSON.stringify(state));process.exit(0);}
  browser=await chromium.connectOverCDP('http://127.0.0.1:18746');
  const context=browser.contexts()[0];
  const page=context.pages().find(p=>p.url().startsWith('https://platform.deepseek.com/'))??await context.newPage();
  if(action==='open'){
    await page.goto('https://platform.deepseek.com',{waitUntil:'domcontentloaded',timeout:30000});
    console.log(JSON.stringify({stage:'manual_login',profile:state.profile,path:new URL(page.url()).pathname,elapsed_ms:Date.now()-started,secrets_exported:false}));
  } else if(action==='probe'){
    const now=Math.floor(Date.now()/1000),start=Math.floor((now+28800)/86400)*86400-28800;
    const endpoint='/api/v0/usage/by_api_key/cost?'+new URLSearchParams({start:String(start),end:String(now),tz:'28800'});
    // Page fetch uses browser credentials only. No Authorization extraction.
    const direct=await page.evaluate(async endpoint=>{try{const r=await fetch(endpoint,{credentials:'include'});const body=await r.text();return {status:r.status,body};}catch{return {error:'CONTEXT_FETCH_FAILED'};}},endpoint);
    let directValue;try{directValue=JSON.parse(direct.body);}catch{}
    console.log(JSON.stringify({stage:'context_fetch',status:direct.status??null,error:direct.error??null,shape:shape(directValue),business_code:Number.isInteger(directValue?.code)?directValue.code:null}));
    // Official frontend performs its own authentication; only response body is read.
    const evidence=[];
    const listener=async response=>{
      const u=new URL(response.url());
      if(u.origin!=='https://platform.deepseek.com'||u.pathname!=='/api/v0/usage/by_api_key/cost')return;
      try{const body=await response.json();evidence.push({status:response.status(),query:Object.fromEntries([...u.searchParams].filter(([k])=>['start','end','tz'].includes(k))),shape:shape(body),business_code:Number.isInteger(body?.code)?body.code:null});}
      catch{evidence.push({status:response.status(),error:'RESPONSE_BODY_UNREADABLE'});}
    };
    page.on('response',listener);
    await page.goto('https://platform.deepseek.com/usage',{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(10000);
    page.off('response',listener);
    console.log(JSON.stringify({stage:'official_usage_listener',path:new URL(page.url()).pathname,responses:evidence,elapsed_ms:Date.now()-started,secrets_exported:false}));
  }else throw Error('INVALID_ACTION');
}catch{console.log(JSON.stringify({error:'BILLING_BROWSER_POC_FAILED',elapsed_ms:Date.now()-started}));process.exitCode=1;}
finally{if(browser)await browser.close();} // CDP disconnect; owned Chrome stays open.
