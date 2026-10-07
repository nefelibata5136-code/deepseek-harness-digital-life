import {billingEnvironment} from './environment.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export class ResidentBillingWorker{
 constructor(){this.child=null;this.pending=null;this.buffer='';}
 query(){
  if(this.pending)return this.pending.promise;
  let accept,reject;const promise=new Promise((a,r)=>{accept=a;reject=r;});
  const timer=setTimeout(()=>{this.fail('BILLING_WORKER_TIMEOUT');this.child?.kill();this.child=null;},90000);
  this.pending={promise,accept,reject,timer};
  if(!this.child){
   const env=billingEnvironment();
   const child=this.child=spawn(process.execPath,[fileURLToPath(new URL('./query.mjs',import.meta.url)),'--resident'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
   this.buffer='';child.stderr.resume();child.stdout.setEncoding('utf8');
   child.stdout.on('data',chunk=>{this.buffer+=chunk;if(this.buffer.length>1048576){this.fail('BILLING_WORKER_OUTPUT_INVALID');child.kill();return;}
    let i;while((i=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);if(!this.pending)continue;
     try{const value=JSON.parse(line);if(value.error){this.fail(/^[A-Z_]+$/.test(value.error)?value.error:'OFFICIAL_REFRESH_FAILED');continue;}
      const p=this.pending;this.pending=null;clearTimeout(p.timer);p.accept(value);
     }catch{this.fail('BILLING_WORKER_OUTPUT_INVALID');}
    }
   });
   child.once('error',()=>this.fail('BILLING_WORKER_START_FAILED'));
   child.once('exit',()=>{if(this.child===child){this.child=null;this.fail('BILLING_WORKER_EXITED');}});
  }
  this.child.stdin.write('query\n');return promise;
 }
 fail(code){if(!this.pending)return;const p=this.pending;this.pending=null;clearTimeout(p.timer);p.reject(Error(code));}
 async close(){const child=this.child;if(!child)return;this.child=null;
  await new Promise(done=>{const timer=setTimeout(()=>{child.kill();done();},8000);child.once('exit',()=>{clearTimeout(timer);done();});child.stdin.end();});
 }
}
