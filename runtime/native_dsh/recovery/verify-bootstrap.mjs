import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=resolve(import.meta.dirname,'../../../reports/self-recovery/bootstrap-fixture-'+randomUUID());
await mkdir(root,{recursive:true});
await writeFile(resolve(root,'standby.mjs'),'this is invalid JavaScript !!!!');
const stable="import {writeFile} from 'node:fs/promises';await writeFile(new URL('fallback-started',import.meta.url),'verified fallback ran');setInterval(()=>{},1000);";
await writeFile(resolve(root,'standby.stable.mjs'),stable);
await writeFile(resolve(root,'stable-manifest.json'),JSON.stringify({files:{'standby.stable.mjs':createHash('sha256').update(stable).digest('hex')}}));
const child=spawn(process.execPath,[resolve(import.meta.dirname,'bootstrap.mjs'),'--fixture',root],{windowsHide:true,stdio:'ignore'});
let report;
try{for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,500));try{await readFile(resolve(root,'fallback-started'));report={passed:true,actualProcessFallback:true,activeEntrySyntaxBroken:true,stableHashesChecked:true};break;}catch{}}
  if(!report)throw Error('Bootstrap fallback did not start');
}finally{
  const exited=new Promise(r=>child.once('exit',r));
  if(process.platform==='win32')await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
  else child.kill();
  await exited;
}
await writeFile(resolve(import.meta.dirname,'../../../reports/self-recovery/bootstrap-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
