import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectActivity} from './events.mjs';
const out=fileURLToPath(new URL('../../reports/activity_progress',import.meta.url));
const root=fileURLToPath(new URL('../native_dsh/home/sessions',import.meta.url));
const report={observedAt:new Date().toISOString(),productionModel:true,mainSessionMessaged:false,tests:[]};
for(const [config,expected] of [['live-sessions.json',[36,432]],['refined-sessions.json',[45,630]]]){
  const settings=JSON.parse(await readFile(resolve(out,config),'utf8'));const test={kind:config.startsWith('refined')?'fixed-tool-plan':'natural-tool-plan',runs:[]};
  for(const run of settings.runs){let records;
    for(const entry of await readdir(root,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink())continue;try{const raw=await readFile(resolve(root,entry.name,run.sessionId,'session.v4.jsonl'),'utf8');records=raw.slice(0,raw.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(JSON.parse);break;}catch(e){if(e.code!=='ENOENT')throw e;}}
    assert(records);const own=records.slice(1),admission=own.find(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.source?.rpcId===run.requestId));assert(admission);
    const start=own.find(e=>e.seq>admission.seq&&e.type==='turn/start'),end=own.find(e=>e.seq>start?.seq&&e.type==='turn/end');
    const events=own.filter(e=>e.seq>=start?.seq&&e.seq<=(end?.seq??Infinity));
    const messages=events.filter(e=>e.type==='assistant/message'),text=messages.flatMap(e=>e.data.message.content).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    const progress=projectActivity(events).progress.map(p=>({time:p.time,text:p.text,characters:p.text.length}));
    test.runs.push({title:run.title,sessionId:run.sessionId,enabled:run.enabled,completed:end?.data.reason?.kind==='completed',modelRequests:messages.length,tools:events.filter(e=>e.type==='tool/call').map(e=>e.data.name),resultContainsExpected:expected.every(n=>text.includes(String(n))),progress,usage:messages.map(e=>e.data.usage),elapsedMs:end?end.time-start.time:null,finalText:messages.at(-1)?.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')});
  }
  report.tests.push(test);
}
report.passed=report.tests.every(t=>t.runs.every(r=>r.completed&&r.resultContainsExpected));
report.scopeNote='First test saw maintenance skill added during execution; counts are observations, not causal attribution. Refined test fixes two reads and measures communication overhead for that plan. Shared protection queues make elapsed time unsuitable for causal comparison.';
await writeFile(resolve(out,'live-comparison.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,tests:report.tests.map(t=>({kind:t.kind,runs:t.runs.map(({usage,finalText,...r})=>r)}))}));
