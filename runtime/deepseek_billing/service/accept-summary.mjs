// Authorized live acceptance, only explicit new test Sessions. Never targets an authority Session.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {credentialOperation} from '../../native_dsh/capabilities/isolation.mjs';
import {worldSnapshot,workerLayout,assertLifeExecutionEnabled,python,migrationRoot} from '../../native_dsh/multi-life/supervisor/deployment.mjs';
import {LIFE_IDS} from './cache.mjs';
const index=Number(process.argv[2]);if(![0,1].includes(index))throw Error('EXPLICIT_BILLING_TEST_OWNER_REQUIRED');
const lifeId=LIFE_IDS[index],manifest=worldSnapshot().lives[lifeId];assertLifeExecutionEnabled(lifeId);
const folder=resolve(migrationRoot,'reports/official-billing-summary-20261007');await mkdir(folder,{recursive:true});
let control,token;
if(index===0){control=JSON.parse(await readFile(resolve(migrationRoot,'runtime/native_dsh/host-state/.host-control.json'),'utf8'));token=control.token;}
else{control=JSON.parse(await readFile(resolve(process.env.DL_WORLD_ROOT || resolve(migrationRoot,'.local/world'), 'workers',lifeId,'control.json'),'utf8'));
  token=(await credentialOperation(python,'resolve',control.token_ref)).value;}
if(!token)throw Error('BILLING_TEST_HOST_CREDENTIAL_UNAVAILABLE');
async function request(path,body){
  const response=await fetch('http://127.0.0.1:'+control.port+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const value=await response.json();if(!response.ok)throw Error('BILLING_TEST_HTTP_'+response.status);return value;
}
const status=await request('/status');if(status.ready===false)throw Error('BILLING_TEST_HOST_NOT_READY');
const sessionId=randomUUID(),requestId=randomUUID(),title=(index===0?'人格':'新生命')+'官方消费摘要与明细验收';
if(sessionId===manifest.authoritySessionId)throw Error('BILLING_TEST_AUTHORITY_FORBIDDEN');
const created=await request(index===0?'/life/test-session':'/test-session',{session_id:sessionId,title});
if(created.session_id!==sessionId||created.life_id!==lifeId)throw Error('BILLING_TEST_SESSION_RECEIPT_MISMATCH');
const evidence={life_id:lifeId,title,session_id:sessionId,request_id:requestId,created,started_at:new Date().toISOString(),session_root:workerLayout(lifeId).session_root};
await writeFile(resolve(folder,'accept-'+index+'.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({phase:'test_session_created',life_id:lifeId,session_id:sessionId,title}));
const text='这是控制侧按用户要求开展的官方消费功能验收，本次是新建独立测试对话。只读取，不改文件、Core、配置，不发送消息，不安排唤醒或其他活动。先看当前运行状态里的简短 billing 摘要；然后实际调用 billing_details(period="today",limit=3)、billing_status、budget_status 和 cache_status。确认默认摘要属于你自己的 Key，金额只来自 DeepSeek 官方账单，工具结果没有本地估算金额或预算；last_1h_cost 为 null 时照实说明历史不足。请用不超过200字报告默认摘要的字段、当前官方累计与最近账单增量、明细读取是否成功、是否看见本地估算金额。结束本轮即可。';
const receipt=await request('/prompt',index===0?{sessionId,requestId,text}:{session_id:sessionId,request_id:requestId,text});
evidence.receipt=index===0?{state:receipt.state,session_id:receipt.sessionId,text:receipt.text,errors:receipt.errors,diagnostics:receipt.diagnostics}:receipt;
evidence.received_at=new Date().toISOString();
await writeFile(resolve(folder,'accept-'+index+'.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({phase:'prompt_receipt',life_id:lifeId,session_id:sessionId,receipt:evidence.receipt}));
