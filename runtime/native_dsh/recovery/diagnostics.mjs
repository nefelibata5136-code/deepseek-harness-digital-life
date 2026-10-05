// Shared by main and standby; no Harness, account files or model dependencies.
import {mkdir, writeFile, readdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
export const stateRoot = resolve(process.env.DL_DATA || '.local', 'recovery');
export const sha = value => createHash('sha256').update(value).digest('hex');
export function clean(value, secrets = [process.env.DEEPSEEK_API_KEY]) {
  let text=String(value ?? '');
  for(const secret of secrets.filter(Boolean)) text=text.replaceAll(secret,'[redacted]');
  return text.replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g,'[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi,'$1[redacted]').slice(0,4000);
}
export function errorChain(error) {
  const result=[], seen=new Set();
  for(let e=error;e&&!seen.has(e)&&result.length<8;e=e.cause) {
    seen.add(e); result.push({name:clean(e.name??'Error'),message:clean(e.message??e),
      ...(e.code!==undefined?{code:clean(e.code)}:{}),
      ...(e.status!==undefined?{status:e.status}:{})});
  }
  return result;
}
export function isContextWindowExceeded(detail) {
  const text=JSON.stringify(detail).toLowerCase();
  return /context_window_exceeded|maximum context length|context.{0,80}(?:exceed|limit|too long)|too many tokens|prompt.{0,80}too long|requested.{0,40}tokens.{0,100}(?:maximum|limit)/.test(text);
}
export function classify(detail) {
  const text=JSON.stringify(detail).toLowerCase(), status=detail.httpStatus;
  if(status===401||status===403)return 'authentication';
  if(status===402)return 'provider_balance';
  if(status===429)return 'rate_limit';
  if(status===413||isContextWindowExceeded(detail))return 'context_size';
  if(status===400||status===422)return 'request_rejected';
  if(status>=500)return 'provider_unavailable';
  if(/econn|enotfound|und_err|fetch failed|timeout|socket|network/.test(text))return 'network';
  if(/budget_stop/.test(text))return 'budget_or_accounting';
  return 'unclassified';
}
export async function recordIncident(detail, root=process.env.DL_DIAGNOSTIC_ROOT??stateRoot) {
  const record={id:randomUUID(),observedAt:new Date().toISOString(),...detail};
  record.category=classify(record);
  if(isContextWindowExceeded(record))record.errorCode='CONTEXT_WINDOW_EXCEEDED';
  await mkdir(resolve(root,'incidents'),{recursive:true});
  await writeFile(resolve(root,'incidents',record.id+'.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  return record;
}
export async function incidents({sessionId,limit=20,root=process.env.DL_DIAGNOSTIC_ROOT??stateRoot}={}) {
  let names;try{names=await readdir(resolve(root,'incidents'));}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const items=[];
  for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))) {
    const r=JSON.parse(await readFile(resolve(root,'incidents',name),'utf8'));
    if(!sessionId||r.sessionId===sessionId)items.push(r);
  }
  return items.sort((a,b)=>b.observedAt.localeCompare(a.observedAt)).slice(0,Math.min(limit,100));
}
export function formatIncident(d) {
  return ['故障编号：'+d.id, '时间：'+d.observedAt, '分类：'+d.category,
    '阶段：'+d.stage, d.errorCode?'错误代码：'+d.errorCode:null, d.httpStatus?'HTTP：'+d.httpStatus:null,
    d.providerRequestId?'供应商请求编号：'+d.providerRequestId:null,
    d.providerError?'供应商错误：'+JSON.stringify(d.providerError):null,
    d.causes?.length?'原因链：'+d.causes.map(e=>[e.name,e.code,e.message].filter(Boolean).join(' · ')).join(' ← '):null,
    d.requestBytes?'请求大小：'+d.requestBytes+' 字节；消息数：'+d.messageCount:null,
    'Session：'+d.sessionId, '请求编号：'+d.requestId,
    '未知用量保留预算预留；不会重放已执行工具。'].filter(Boolean).join('\n');
}
export async function recentFailures(root=stateRoot){
 return (await incidents({root,limit:100})).filter(r=>/^(?:session-)?[a-f0-9-]{36}$/i.test(r.sessionId??'')&&
  !['tool-protocol-normalized','wire-preview'].includes(r.stage)).slice(0,10)
  .map(r=>({...r,log:formatIncident(r),localFile:resolve(root,'incidents',r.id+'.json')}));
}
