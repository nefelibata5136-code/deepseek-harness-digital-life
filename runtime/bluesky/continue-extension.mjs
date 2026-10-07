// One-shot completion of this explicitly authorized acceptance only.
// No resident schedule, interest policy or day-to-day Bluesky workflow.
import {spawn} from 'node:child_process';
import {readFile,access,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=import.meta.dirname,reports=resolve(root,'../../reports/bluesky');
const stopped=async()=>{try{await access(resolve(reports,'extension-resume-stop'));throw new Error('USER_PAUSED_ACCEPTANCE');}catch(e){if(e.code!=='ENOENT')throw e;}};
let child;
async function run(args){
  await stopped();
  await new Promise((accept,reject)=>{
    child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.resume();child.stderr.resume();
    child.once('error',reject);child.once('exit',code=>{child=null;code===0?accept():reject(new Error('ACCEPTANCE_HELPER_FAILED'));});
  });
}
async function response(mode){
  const data=JSON.parse(await readFile(resolve(reports,`extension-${mode}-response.json`),'utf8'));
  if(data.status!==200||data.value?.state!=='completed')throw new Error('INSPECT_INTERRUPTED_'+mode);
}
async function stage(mode){
  await stopped();
  try {await access(resolve(reports,`extension-${mode}-response.json`));await response(mode);}
  catch(e){if(e.code!=='ENOENT')throw e;await run([resolve(root,'live-extension.mjs'),mode,'--use-authorized-main']);await response(mode);}
  console.log(JSON.stringify({stage:mode,completed:true,time:new Date().toISOString()}));
}
async function inspect(){
  await stopped();
  await new Promise((accept,reject)=>{
    const p=spawn('python',['-X','utf8',resolve(root,'inspect-extension.py')],{windowsHide:true,stdio:'ignore'});
    p.once('error',reject);p.once('exit',code=>code===0?accept():reject(new Error('AUDIT_FAILED')));
  });
  return JSON.parse(await readFile(resolve(reports,'extension-acceptance.json'),'utf8'));
}
try {
  console.log(JSON.stringify({pid:process.pid,oneShot:true,startedAt:new Date().toISOString()}));
  // This request is already in flight. Never submit another while it runs.
  while(true){await stopped();try{await access(resolve(reports,'extension-resume_social-response.json'));break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,1000));}
  await response('resume_social');
  const social=await inspect();
  if(!social.checks.N_mutedWordAddedVerifiedAndRemoved)throw new Error('INSPECT_SAFETY_CLEANUP_BEFORE_PUBLICATION');
  await stage('resume_publish');
  const publication=await inspect();
  const posts=publication.published.filter(p=>p.draft_id==='persona-bluesky-extension-post-20261005');
  if(posts.length!==1||!publication.checks.J_selfThreadReplyVerified)throw new Error('INSPECT_PUBLICATION_BEFORE_CONTROLLED_NOTIFICATION');
  await run([resolve(root,'test-peer.mjs'),'notify',posts[0].uri]);
  console.log(JSON.stringify({stage:'controlled-notification',sent:true}));
  await stage('resume_dm');
  await run([resolve(root,'test-peer.mjs'),'read']);
  await stage('resume_finish');
  const acceptance=await inspect();
  await writeFile(resolve(reports,'extension-continuation-result.json'),JSON.stringify({observedAt:new Date().toISOString(),passed:acceptance.passed,checks:acceptance.checks},null,2)+'\n');
  console.log(JSON.stringify({completed:acceptance.passed,checks:acceptance.checks}));
  if(!acceptance.passed)process.exitCode=1;
}catch(e){
  await writeFile(resolve(reports,'extension-continuation-result.json'),JSON.stringify({observedAt:new Date().toISOString(),passed:false,error:e.message},null,2)+'\n');
  console.error(e.message);process.exitCode=1;
}
