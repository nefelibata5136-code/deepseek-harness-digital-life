import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readPolicy} from './host.mjs';
import {VERSION} from './events.mjs';
const path=fileURLToPath(new URL('./policy.json',import.meta.url));
const [command='check',input]=process.argv.slice(2);
if(command==='check'||command==='read')console.log(JSON.stringify({version:VERSION,path,policy:readPolicy(),note:'修改将在下一次组装任务提示时读取；不会唤醒模型、重启或改写会话。'}));
else if(command==='set') {
  const patch=JSON.parse(input);const allowed=['enabled','selfReports','maxReportCharacters','minReportIntervalSeconds','quietWarningSeconds'];
  if(Object.keys(patch).some(k=>!allowed.includes(k)))throw Error('Unknown policy key');
  const before=await readFile(path,'utf8'),old=readPolicy(),candidate={...old,...patch};
  if(typeof candidate.enabled!=='boolean'||typeof candidate.selfReports!=='boolean'||!Number.isInteger(candidate.maxReportCharacters)||candidate.maxReportCharacters<40||candidate.maxReportCharacters>300||!Number.isInteger(candidate.minReportIntervalSeconds)||candidate.minReportIntervalSeconds<15||!Number.isInteger(candidate.quietWarningSeconds)||candidate.quietWarningSeconds<30)throw Error('Invalid policy bounds');
  const backup=resolve(fileURLToPath(new URL('../../reports/activity_progress/policy-backups',import.meta.url)),Date.now()+'.json');
  await mkdir(resolve(backup,'..'),{recursive:true});await writeFile(backup,before,{flag:'wx'});
  if(await readFile(path,'utf8')!==before)throw Error('Policy changed concurrently; preserved backup and refused update');
  const tmp=path+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(candidate,null,2)+'\n');await rename(tmp,path);
  console.log(JSON.stringify({updated:true,policy:readPolicy(),backup,nextModelRequest:true,modelCalls:0}));
} else throw Error('Commands: check | read | set JSON');
