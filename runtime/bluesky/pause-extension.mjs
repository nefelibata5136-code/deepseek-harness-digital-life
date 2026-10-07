// User-requested pause: cancel only this acceptance's admitted turns, including
// its HTTP admission queue. No Host restart or shared computer switch.
import {readFile, readdir, access, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {hostRequest} from '../desktop_persona/index.mjs';
const base=resolve(import.meta.dirname,'../..'), reports=resolve(base,'reports/bluesky');
const sid='80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b';
const modes=['social','publish','dm'];
const own=new Set(await Promise.all(modes.map(async mode=>JSON.parse(await readFile(resolve(reports,`extension-${mode}-submitted.json`),'utf8')).requestId)));
const root=resolve(base,'runtime/native_dsh/home/sessions');
let log;
for(const entry of await readdir(root,{withFileTypes:true})) {
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;
  const candidate=resolve(root,entry.name,sid,'session.v4.jsonl');
  try{await access(candidate);log=candidate;break;}catch(e){if(e.code!=='ENOENT')throw e;}
}
if(!log)throw new Error('Acceptance Session history missing');
const startedAt=new Date().toISOString(), cancellations=[];
const deadline=Date.now()+90000;
let finished=false, last;
while(Date.now()<deadline) {
  const raw=await readFile(log,'utf8');
  const events=raw.slice(0,raw.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(JSON.parse);
  const latestInput=events.findLast(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.role==='user'&&m.source?.rpcId));
  const requestId=latestInput?.data.inserted.findLast(m=>m.role==='user'&&m.source?.rpcId)?.source.rpcId;
  const turn=events.findLast(e=>e.type==='turn/start'||e.type==='turn/end');
  const running=turn?.type==='turn/start';
  const pending=new Map();
  for(const e of events){if(e.type==='tool/call')pending.set(e.data.callId,{seq:e.seq,name:e.data.name});if(e.type==='tool/result')pending.delete(e.data.message?.toolCallId);}
  const completed=await Promise.all(modes.map(async mode=>{try{await access(resolve(reports,`extension-${mode}-response.json`));return mode;}catch(e){if(e.code!=='ENOENT')throw e;return null;}}));
  last={latestSeq:events.at(-1)?.seq,requestId,running,pending:[...pending.values()],responses:completed.filter(Boolean)};
  if(running&&!own.has(requestId))throw new Error('Another request now owns the primary Session; refusing to cancel');
  if(running&&own.has(requestId)) {
    const result=await hostRequest('POST','/cancel',{sessionId:sid},AbortSignal.timeout(10000));
    cancellations.push({at:new Date().toISOString(),requestId,latestSeq:last.latestSeq,status:result.status});
    if(result.status!==200)throw new Error('Native cancel refused');
  }
  if(!running&&last.responses.length===modes.length){finished=true;break;}
  await new Promise(accept=>setTimeout(accept,100));
}
const status=(await hostRequest('GET','/status')).value;
const result={startedAt,observedAt:new Date().toISOString(),userRequestedPause:true,sessionId:sid,finished,
  hostPid:status.pid,computerEnabled:status.computer?.enabled,cancellations,last,
  untouched:'Other activities, Host lifecycle, browser processes, credentials and shared computer enablement'};
await writeFile(resolve(reports,'extension-pause.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
if(!finished)process.exitCode=1;
