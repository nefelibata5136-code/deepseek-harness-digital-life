// A paint-only helper. The existing Persona Agent remains the sole decision maker.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

export async function createDesktopOverlay({reviewCapture=false}={}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(key)));
  const child = spawn('python',
    ['-X','utf8',resolve(import.meta.dirname,'desktop-overlay.py'),...(reviewCapture?['--review']:[])],
    {windowsHide:true, env, stdio:['pipe','pipe','pipe']});
  let current = {ready:false,visible:false};
  let sequence=0, failure='', closed=false;
  const waiting=new Map();
  const lines=createInterface({input:child.stdout});
  const ready=new Promise((yes,no)=>{
    const timer=setTimeout(()=>no(new Error('Desktop indicator startup timed out')),10000);
    lines.on('line',line=>{
      let value;try{value=JSON.parse(line);}catch{return;}
      if(value.error) { failure=value.error; no(new Error(failure)); return; }
      current={...current,...value,pid:child.pid};
      if(value.ready){clearTimeout(timer);yes();}
      const pending=waiting.get(value.id);
      if(pending){waiting.delete(value.id);clearTimeout(pending.timer);pending.yes(current);}
    });
    child.once('error',error=>{clearTimeout(timer);failure=error.message;no(error);});
    child.once('exit',(code)=>{closed=true;current={...current,ready:false,visible:false};clearTimeout(timer);
      no(new Error(failure || 'Desktop indicator exited: '+code));
      for(const pending of waiting.values()){clearTimeout(pending.timer);pending.no(new Error('Desktop indicator closed'));}waiting.clear();});
  });
  child.stderr.on('data',chunk=>{failure=(failure+chunk.toString()).slice(-2000);});
  child.stdin.on('error',()=>{});
  try{await ready;}catch(error){child.kill();throw error;}
  const command=value=>new Promise((yes,no)=>{
    if(closed)return no(new Error('Desktop indicator unavailable'));
    const id=++sequence;
    const timer=setTimeout(()=>{waiting.delete(id);no(new Error('Desktop indicator did not acknowledge'));},3000);
    waiting.set(id,{yes,no,timer});
    child.stdin.write(JSON.stringify({id,...value})+'\n');
  });
  return {status:()=>({...current}), show:()=>command({visible:true}),hide:()=>command({visible:false}),
    // Control-side visual verification only; not exposed as an Agent tool or HTTP route.
    captureForReview:()=>command({excludeCapture:false}),
    restoreCaptureExclusion:()=>command({excludeCapture:true}),
    async dispose(){if(closed)return;await command({visible:false}).catch(()=>{});child.stdin.end(JSON.stringify({exit:true})+'\n');
      await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,1500))]);
      if(!closed)child.kill();lines.close();},
  };
}
