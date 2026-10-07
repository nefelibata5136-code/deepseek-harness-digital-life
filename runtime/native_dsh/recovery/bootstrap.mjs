// Tiny independent process supervisor. It needs only Node builtins, no model/Harness boot.
import {spawn} from 'node:child_process';
import {readFile,open,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.argv[2]==='--fixture'?resolve(process.argv[3]):import.meta.dirname,state=resolve(root,'state');
if(process.argv[2]==='--fixture'&&!root.startsWith(resolve(import.meta.dirname,'../../../reports/self-recovery')+'\\'))throw Error('Expected isolated bootstrap fixture');
await mkdir(state,{recursive:true});
let child,stop=false;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stop=true;child?.kill();});
async function stableVerified(){
  try{const manifest=JSON.parse(await readFile(resolve(root,'stable-manifest.json'),'utf8'));
    for(const [name,hash]of Object.entries(manifest.files))if(createHash('sha256').update(await readFile(resolve(root,name))).digest('hex')!==hash)return false;
    return manifest.entry??'standby.stable.mjs';
  }catch{return false;}
}
let failures=0;
while(!stop){
  const stable=failures>0&&await stableVerified(),fallback=!!stable,entry=resolve(root,stable||'standby.mjs');
  const log=await open(resolve(state,'bootstrap.log'),'a',0o600),started=Date.now();
  child=spawn(process.execPath,[entry,'--run'],{windowsHide:true,stdio:['ignore',log.fd,log.fd]});
  await writeFile(resolve(state,'bootstrap-status.json'),JSON.stringify({pid:process.pid,childPid:child.pid,entry,fallback,observedAt:new Date().toISOString()})+'\n');
  const outcome=await new Promise(yes=>{child.once('exit',(code,signal)=>yes({code,signal}));child.once('error',()=>yes({code:1}));});
  await log.close();child=null;if(stop)break;
  // A stable survivor can repair the active sources; restart selects active again.
  if(Date.now()-started>300000)failures=0;else failures++;
  await new Promise(r=>setTimeout(r,Math.min(60000,5000*2**Math.min(failures,4))));
}
