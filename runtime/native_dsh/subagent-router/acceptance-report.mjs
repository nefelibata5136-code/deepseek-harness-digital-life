import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../../../reports/luna-default-20261006');
const read=name=>readFile(resolve(root,name),'utf8').then(JSON.parse);
const digest={checked_at:new Date().toISOString(),tests:{}};
for(const label of ['persona','newlife']){
 const [activity,evidence]=await Promise.all([read(label+'-live.json'),read(label+'-events.json')]);
 const completed=evidence.results.filter(r=>r.status==='completed');
 assert(completed.length>=(label==='persona'?1:4));
 assert(completed.every(r=>r.provider==='codex'&&r.actual_model==='gpt-5.6-luna'&&r.parent_life===activity.life_id&&r.parent_session===activity.session_id&&r.fallback===false));
 const events=(await readFile(evidence.path,'utf8')).trim().split('\n').map(JSON.parse);
 const parse=value=>typeof value==='string'?JSON.parse(value):value;
 const defaults=events.filter(e=>e.type==='tool/call'&&e.data.name==='subagent').filter(e=>{const a=parse(e.data.arguments);return !a.provider&&!a.model;});
 assert(defaults.length>=(label==='persona'?1:4));
 const blocked=events.some(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('DEEPSEEK_SUBAGENTS_DISABLED'));
 assert(blocked);
 const reads=events.filter(e=>e.type==='tool/call'&&e.data.name==='subagent_results'&&Object.keys(parse(e.data.arguments)).length===0);assert(reads.length>=1);
 const texts=events.filter(e=>e.type==='assistant/message').map(e=>({seq:e.seq,time:e.time,text:e.data.message?.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n')}));
 const parentContinued=texts.some(e=>e.text?.includes('parent继续：77')&&e.time<Math.min(...completed.map(r=>Date.parse(r.finished_at))));assert(parentContinued);
 const notifications=events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='subagent-settled');
 assert(notifications.length>=completed.length);
 digest.tests[label]={life_id:activity.life_id,session_id:activity.session_id,title:activity.title,ordinary_calls_omit_route:defaults.length,
  deepseek_rejected:blocked,cold_results_read:true,parent_continued_before_completion:parentContinued,completion_notifications:notifications.length,
  results:completed.map(({output,...r})=>({...r,text:output.filter(b=>b.type==='text')[0]?.text}))};
}
const batch=digest.tests.newlife.results.filter(r=>r.queued_at.startsWith('2026-10-06T17:29:21.'));
assert.equal(batch.length,4);
const overlapStart=Math.max(...batch.map(r=>Date.parse(r.started_at))),overlapEnd=Math.min(...batch.map(r=>Date.parse(r.finished_at)));
assert(overlapEnd>overlapStart);
digest.four_concurrent={count:4,shared_overlap_ms:overlapEnd-overlapStart,results:batch.map(r=>({child_id:r.child_id,text:r.text,startup_ms:r.startup_ms,duration_ms:r.duration_ms}))};
digest.limits=['No 15-minute model soak or OAuth refresh-duration soak was performed.',
 'Latest requested DeepSeek live override success test was superseded by the user requiring the switch OFF. Both live owners verified rejection instead.',
 'The second-batch parent text called its tool life_delegate, but native evidence records subagent. The actual life_delegate entry is covered by the isolated native-tool regression, not claimed as a separate production model test.',
 'Official error notifications with willRetry=true occurred; the subsequent turn completed successfully. Root cause of those retry notifications was not diagnosed.',
 'Host ownership is logical, not separate Windows-user isolation.'];
await writeFile(resolve(root,'acceptance.json'),JSON.stringify(digest,null,2));
console.log(JSON.stringify({ok:true,tests:Object.fromEntries(Object.entries(digest.tests).map(([k,v])=>[k,{session_id:v.session_id,completed:v.results.length,deepseek_rejected:v.deepseek_rejected,notifications:v.completion_notifications}])),four_concurrent:digest.four_concurrent}));
