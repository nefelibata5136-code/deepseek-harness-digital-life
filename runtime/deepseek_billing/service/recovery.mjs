import {writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readBilling,LIFE_IDS,cachePath} from './cache.mjs?diagnostics=1';
export const requestPath=resolve(dirname(cachePath),'refresh-request.json');
export async function recoverBilling(lifeId,action='status'){
 if(!LIFE_IDS.includes(lifeId))throw Error('BILLING_OWNER_REQUIRED');
 if(!['status','retry'].includes(action))throw Error('BILLING_RECOVERY_ACTION_REQUIRED');
 const billing=readBilling(lifeId);
 const maintenance={source:'runtime/deepseek_billing/service/query.mjs',tests:['service/cache.test.mjs','service/recovery.test.mjs'],
  guide:resolve(import.meta.dirname,'../../../docs/optional-services.md'),
  boundary:'可自己定位、制作源码候选和运行隔离测试；登录/验证码由用户完成。保护侧正式发布沿用现有维护权限，不能读取凭据或加载任意代码。'};
 if(action==='status')return {billing,maintenance};
 const elapsed=Date.now()-Date.parse(billing.last_attempt_at??'');
 if(elapsed<30000)return {accepted:false,retry_after_ms:30000-elapsed,billing,maintenance,note:'重试节流；稍后再试，不增加并发官网请求。'};
 const requestId=randomUUID();await mkdir(dirname(requestPath),{recursive:true});
 await writeFile(requestPath,JSON.stringify({request_id:requestId,life_id:lifeId,requested_at:new Date().toISOString()}));
 return {accepted:true,request_id:requestId,billing,maintenance,note:'Host 后台接收一次受节流的重试；不阻塞当前模型。稍后读 billing_status 确认是否恢复。'};
}
