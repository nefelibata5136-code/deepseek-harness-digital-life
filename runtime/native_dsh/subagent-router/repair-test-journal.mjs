// One-time repair of our exact disposable acceptance Session, never a primary.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadSettings} from './router.mjs';
const report=resolve(import.meta.dirname,'../../../reports/luna-default-20261006');
const evidence=JSON.parse(await readFile(join(report,'newlife-events.json'),'utf8'));
if(evidence.session_id!=='f9beb689-8733-569a-8f63-04b41aabefa0'||!evidence.path.includes(evidence.session_id))throw new Error('EXACT_TEST_REQUIRED');
const before=await readFile(evidence.path,'utf8'),rows=before.trim().split('\n').map(JSON.parse);
const changed=rows.filter(r=>['subagent/route','subagent/route-result'].includes(r.type)&&!r.ignorable);
if(!changed.length){console.log('already repaired');process.exit(0);}
await writeFile(join(report,'newlife-journal-before-repair.jsonl'),before,{flag:'wx'});
const settings=await loadSettings(),directory=join(settings.protectedRoot,'subagent-audit',createHash('sha256').update(evidence.life_id+'\0'+evidence.session_id).digest('hex'));
await mkdir(directory,{recursive:true});
const latest=new Map();for(const r of rows)if(['subagent/route','subagent/route-result'].includes(r.type))latest.set(r.data.child_id,r.data);
for(const [id,row]of latest)await writeFile(join(directory,id+'.json'),JSON.stringify(row),{flag:'wx',mode:0o600});
// Add an envelope flag only, retaining all original data and event sequence.
const after=before.split('\n').map(line=>{
 if(!line.trim())return line;const r=JSON.parse(line);
 return ['subagent/route','subagent/route-result'].includes(r.type)&&!r.ignorable?line.replace(/}\s*$/,' ,"ignorable":true}'):line;
}).join('\n');
await writeFile(evidence.path,after);
await writeFile(join(report,'journal-repair.json'),JSON.stringify({session_id:evidence.session_id,changed_events:changed.length,original_sha256:createHash('sha256').update(before).digest('hex'),repaired_sha256:createHash('sha256').update(after).digest('hex'),operation:'add ignorable envelope flag to our custom test events; preserve data and seq'},null,2));
console.log(JSON.stringify({session_id:evidence.session_id,repaired_events:changed.length}));
