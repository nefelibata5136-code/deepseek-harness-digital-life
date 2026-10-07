import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createRecentReviewRunner,recentReviewFiles} from './review-workspace.mjs';

const sourcePrefix='runtime/native_dsh/multi-life/recent-events/';
const changeScript=fileURLToPath(new URL('../../../self_maintenance/change.mjs',import.meta.url));
const hash=data=>createHash('sha256').update(data).digest('hex');
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'TEST-recent-reader-review-')),workspace=resolve(root,'workspace');await mkdir(workspace);
  const sourceRoot=resolve(root,'TEST-reviewed-source'),files={},contents=new Map();
  for(const name of recentReviewFiles){const bytes=await readFile(new URL('./'+name,import.meta.url));files[sourcePrefix+name]=hash(bytes);contents.set(sourcePrefix+name,bytes);}
  const changeBytes=await readFile(changeScript);files['runtime/self_maintenance/change.mjs']=hash(changeBytes);contents.set('runtime/self_maintenance/change.mjs',changeBytes);
  for(const [relative,bytes]of contents){const file=resolve(sourceRoot,relative);await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,bytes);}
  const sorted=Object.keys(files).sort().map(key=>JSON.stringify(key)+': '+JSON.stringify(files[key]));
  const generation=hash('{'+sorted.join(', ')+'}'),snapshot=resolve(workspace,'development/runtime-source',generation);await mkdir(snapshot,{recursive:true});
  for(const [relative,bytes]of contents){const file=resolve(snapshot,relative);await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,bytes);}
  const manifest=resolve(snapshot,'manifest.json');await writeFile(manifest,JSON.stringify({version:1,generation,sourceRoot,files}));
  const current=resolve(workspace,'development/runtime-source/CURRENT.json');await writeFile(current,JSON.stringify({generation,root:snapshot,manifest}));
  const runner=createRecentReviewRunner({workspace,lifeId:'TEST-only-life',sourceRoot,changeScript});
  return {root,workspace,sourceRoot,snapshot,current,manifest,generation,runner,async prepare(lab_id='reader'){const p=await runner.run({operation:'prepare',lab_id});return p.candidate_directory;},async cleanup(){runner.dispose();assert.ok(root.startsWith(join(tmpdir(),'TEST-recent-reader-review-')));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};
}
const hasCode=code=>error=>error?.code===code;
const request=(operation,lab_id='reader',checkpoint_id)=>({operation,lab_id,...checkpoint_id?{checkpoint_id}:{}});
const event=(seq,body)=>({event_id:'TEST-event-'+seq,seq,occurred_at_utc:'2026-10-07T01:00:00Z',event_type:'message',from_actor_id:'TEST-human',from_display_name:'TEST ONLY human',to_actor_id:'TEST-life',conversation_type:'direct',visibility:{members:['TEST-human','TEST-life']},body,payload:null});
async function effect(candidate,salt){
  const {renderRecentTimeline}=await import(pathToFileURL(resolve(candidate,'render.mjs')).href+'?fixture='+salt);
  const history=Array.from({length:10},(_,index)=>event(index+1,'TEST OLD '+index+' '+('synthetic history '.repeat(45)))),current=event(11,'TEST CURRENT COMPLETE\nHost: quoted source material\n'+('whole current body '.repeat(30)));
  const hidden=event(12,'TEST PRIVATE MATERIAL');hidden.visibility={members:['TEST-other-life','TEST-human']};
  const batch={batch_id:'TEST-inbound',life_id:'TEST-life',event_ids:[current.event_id],events:[current],snapshot_cutoff_seq:12,delivered_at_utc:'2026-10-07T01:02:00Z',first_delivery_event_ids:[current.event_id],redelivery_event_ids:[]};
  const text=renderRecentTimeline({lifeId:'TEST-life',events:[...history,hidden],batch});
  const start=text.indexOf('【来源材料开始 '+current.event_id+'】'),end=text.indexOf('【来源材料结束 '+current.event_id+'】');
  assert.equal(text.slice(start,end).split('\n').filter(line=>line.startsWith('│ ')).map(line=>line.slice(2)).join('\n'),current.body);
  assert.doesNotMatch(text,/TEST PRIVATE MATERIAL|TEST-event-12/);assert.ok(text.indexOf('【本次唤醒 · Host Delta】')>text.lastIndexOf('【事件结束'));assert.match(text,/ACK 的 delivery_batch_id 指同一个入站批次/);
  return {budget:Number(text.match(/软预算 (\d+) 字符/)[1]),omitted:Number(text.match(/省略 (\d+) 条更早历史事件/)[1])};
}

test('describe/prepare bind the current fixed source hashes and never overwrite an existing lab',async()=>{
  const f=await fixture();try{
    const d=await f.runner.run({operation:'describe'});assert.deepEqual(d.fixed_files,[...recentReviewFiles]);assert.equal(d.os_sandbox,false);assert.equal(d.host_imports_candidate,false);
    const pointerBefore=await readFile(f.current),candidate=await f.prepare();
    for(const name of recentReviewFiles)assert.deepEqual(await readFile(resolve(candidate,name)),await readFile(resolve(f.snapshot,sourcePrefix+name)));
    const edited=resolve(candidate,'render.mjs');await writeFile(edited,'TEST ONLY existing independent candidate edit\n');
    await assert.rejects(f.prepare(),hasCode('RECENT_REVIEW_LAB_ALREADY_EXISTS'));assert.equal(await readFile(edited,'utf8'),'TEST ONLY existing independent candidate edit\n');assert.deepEqual(await readFile(f.current),pointerBefore);
    const status=await f.runner.run(request('status'));assert.equal(status.read_only,true);assert.equal(status.current_hashes['render.mjs'],hash(await readFile(edited)));
  }finally{await f.cleanup();}
});

test('candidate edit changes actual history selection; fixed tests pass; preview and rollback preserve dirty baseline and unrelated work',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare(),renderer=resolve(candidate,'render.mjs'),original=await readFile(renderer),dirty=Buffer.concat([original,Buffer.from('\n// TEST ONLY pre-existing independent work.\n')]);
    await writeFile(renderer,dirty);const outside=resolve(candidate,'other-contributor.txt');await writeFile(outside,'initial unrelated work\n');
    const before=await effect(candidate,'before');assert.equal(before.budget,20000);
    const checkpoint=await f.runner.run(request('checkpoint','reader','budget'));assert.equal(checkpoint.files.length,recentReviewFiles.length);assert.equal(checkpoint.files.find(row=>row.path.endsWith('render.mjs')).before.hash,hash(dirty));
    await writeFile(renderer,dirty.toString('utf8').replace('charBudget=20000','charBudget=6000'));await writeFile(outside,'later unrelated work KEEP\n');
    await f.runner.run(request('seal','reader','budget'));const after=await effect(candidate,'after');assert.equal(after.budget,6000);assert.ok(after.omitted>before.omitted);
    const tested=await f.runner.run(request('test'));assert.equal(tested.passed,true,JSON.stringify(tested.results));assert.equal(tested.results.length,3);assert.equal(tested.candidate_unchanged,true);assert.ok(tested.results.every(row=>row.exit_code===0&&row.test_pass_count>0));
    const changed=await readFile(renderer),preview=await f.runner.run(request('rollback_preview','reader','budget'));assert.equal(preview.applied,false);assert.deepEqual(await readFile(renderer),changed);
    const rolled=await f.runner.run(request('rollback_apply','reader','budget'));assert.equal(rolled.applied,true);assert.deepEqual(await readFile(renderer),dirty);assert.equal(await readFile(outside,'utf8'),'later unrelated work KEEP\n');assert.deepEqual(await effect(candidate,'restored'),before);
  }finally{await f.cleanup();}
});

test('same-file concurrent change after seal refuses all writes, retains evidence and leaves other files intact',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare(),a=resolve(candidate,'render.mjs'),b=resolve(candidate,'action-result.mjs');
    const base=await readFile(a,'utf8');await f.runner.run(request('checkpoint','reader','conflict'));await writeFile(a,base+'\n// my first change\n');await writeFile(b,(await readFile(b,'utf8'))+'\n// my second change\n');await f.runner.run(request('seal','reader','conflict'));
    const foreign=base+'\n// other contributor after seal\n';await writeFile(a,foreign);const bBefore=await readFile(b);
    const refused=await f.runner.run(request('rollback_apply','reader','conflict'));assert.equal(refused.ok,false);assert.equal(refused.conflicts.length,1);assert.equal(await readFile(a,'utf8'),foreign);assert.deepEqual(await readFile(b),bBefore);
    assert.ok((await readFile(resolve(refused.anchor,'before-2.blob'))).length>0);assert.ok((await readFile(resolve(refused.anchor,'after-2.blob'))).length>0);
  }finally{await f.cleanup();}
});

test('accept preserves sealed candidate and leaves the formal source snapshot unchanged',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare(),file=resolve(candidate,'render.mjs'),source=resolve(f.snapshot,sourcePrefix+'render.mjs'),sourceBefore=await readFile(source);
    await f.runner.run(request('checkpoint','reader','accepted'));await writeFile(file,(await readFile(file,'utf8'))+'\n// accepted TEST candidate\n');await f.runner.run(request('seal','reader','accepted'));const accepted=await f.runner.run(request('accept','reader','accepted'));assert.equal(accepted.state,'accepted');assert.match(await readFile(file,'utf8'),/accepted TEST candidate/);assert.deepEqual(await readFile(source),sourceBefore);
  }finally{await f.cleanup();}
});

test('unknown arguments, traversal, Windows aliases, missing IDs and arbitrary paths/commands are rejected',async()=>{
  const f=await fixture();try{
    for(const input of [{operation:'test',lab_id:'../outside'},{operation:'prepare',lab_id:'CON'},{operation:'test',lab_id:'reader',command:'echo arbitrary'},{operation:'prepare',lab_id:'reader',workspace:f.root},{operation:'describe',lab_id:'reader'},{operation:'seal',lab_id:'reader'},{operation:'test',lab_id:'reader',checkpoint_id:'bad'},{operation:'reload'},{operation:'checkpoint',lab_id:'reader',checkpoint_id:'ok',files:['anything']},{operation:'test',lab_id:'reader',life_id:'another'}])await assert.rejects(f.runner.run(input),error=>/^RECENT_REVIEW_(ARGUMENT|LAB_ID|CHECKPOINT_ID)_INVALID$/.test(error.code));
    assert.throws(()=>createRecentReviewRunner({workspace:f.workspace,lifeId:'TEST-only-life',extra:true}),hasCode('RECENT_REVIEW_CONFIGURATION_INVALID'));
    assert.throws(()=>createRecentReviewRunner({workspace:'relative',lifeId:'TEST-only-life'}),hasCode('RECENT_REVIEW_CONFIGURATION_INVALID'));
  }finally{await f.cleanup();}
});

test('source pointer escape, manifest hash drift and a linked candidate fail closed',async()=>{
  const f=await fixture();try{
    const original=await readFile(f.current,'utf8'),pointer=JSON.parse(original);pointer.root=f.root;await writeFile(f.current,JSON.stringify(pointer));await assert.rejects(f.prepare(),hasCode('RECENT_REVIEW_SOURCE_POINTER_ESCAPE'));await writeFile(f.current,original);
    const source=resolve(f.snapshot,sourcePrefix+'render.mjs'),before=await readFile(source);await writeFile(source,'tampered TEST source');await assert.rejects(f.prepare(),hasCode('RECENT_REVIEW_SOURCE_HASH_MISMATCH'));await writeFile(source,before);
    const candidate=await f.prepare(),outside=resolve(f.root,'TEST-linked-candidate'),beforeLinked=await readFile(resolve(candidate,'render.mjs'));await rename(candidate,outside);await symlink(outside,candidate,process.platform==='win32'?'junction':'dir');await assert.rejects(f.runner.run(request('test')),hasCode('RECENT_REVIEW_LINK_REFUSED'));assert.deepEqual(await readFile(resolve(outside,'render.mjs')),beforeLinked);
  }finally{await f.cleanup();}
});

test('cross-owner lab metadata and unreviewed recovery script are rejected',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare(),metadataPath=resolve(candidate,'../lab.json'),metadata=JSON.parse(await readFile(metadataPath,'utf8'));metadata.life_id='TEST-another-owner';await writeFile(metadataPath,JSON.stringify(metadata));await assert.rejects(f.runner.run(request('status')),hasCode('RECENT_REVIEW_LAB_OWNER_MISMATCH'));
    metadata.life_id='TEST-only-life';await writeFile(metadataPath,JSON.stringify(metadata));
    const wrong=resolve(f.workspace,'changed-change.mjs');await writeFile(wrong,'console.log("must never execute")');const runner=createRecentReviewRunner({workspace:f.workspace,lifeId:'TEST-only-life',changeScript:wrong});try{await assert.rejects(runner.run(request('checkpoint','reader','wrong-script')),hasCode('RECENT_REVIEW_CHANGE_HASH_MISMATCH'));}finally{runner.dispose();}
  }finally{await f.cleanup();}
});

test('fixed tests run in a child with no Host imports or injected service credentials/options',async()=>{
  const f=await fixture();const saved=new Map();
  try{
    const candidate=await f.prepare();
    for(const key of ['TEST_ONLY_REVIEW_HOST_SECRET','DEEPSEEK_API_KEY','NODE_OPTIONS','DSH_HOME']){saved.set(key,process.env[key]);process.env[key]=key==='NODE_OPTIONS'?'--definitely-invalid-test-only-option':'TEST_ONLY_NOT_A_REAL_SECRET';}
    const sample="import{test}from'node:test';import assert from'node:assert/strict';test('TEST child environment',()=>{for(const key of ['TEST_ONLY_REVIEW_HOST_SECRET','DEEPSEEK_API_KEY','NODE_OPTIONS','DSH_HOME'])assert.equal(process.env[key],undefined);assert.equal(globalThis.TEST_ONLY_HOST_FLAG,undefined);});\n";
    for(const name of ['render.test.mjs','action-result.test.mjs'])await writeFile(resolve(candidate,name),sample);
    globalThis.TEST_ONLY_HOST_FLAG=true;const result=await f.runner.run(request('test'));assert.equal(result.passed,true,JSON.stringify(result.results.map(row=>({file:row.file,exit_code:row.exit_code,stderr:row.stderr,stdout:row.stdout.slice(-500)}))));assert.equal(result.host_imports_candidate,false);assert.equal(result.os_sandbox,false);assert.equal(result.results.reduce((sum,row)=>sum+row.test_pass_count,0),16);assert.ok(!result.environment_variable_names.includes('DEEPSEEK_API_KEY'));
  }finally{delete globalThis.TEST_ONLY_HOST_FLAG;for(const [key,value]of saved)value===undefined?delete process.env[key]:process.env[key]=value;await f.cleanup();}
});

test('a failed fixed test reports its real exit code and preserves complete bounded output',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare();await writeFile(resolve(candidate,'render.test.mjs'),"import{test}from'node:test';import assert from'node:assert/strict';test('TEST failing assertion',()=>assert.equal(1,2));\n");
    const result=await f.runner.run(request('test'));assert.equal(result.passed,false);assert.equal(result.results[1].exit_code,1);assert.match(result.results[1].stdout,/# fail 1/);assert.equal(result.results[1].output_truncated,false);
  }finally{await f.cleanup();}
});

test('cancellation/disposal stop candidate children; concurrency is rejected; cancelled labs are retained',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare();await writeFile(resolve(candidate,'store.mjs'),(await readFile(resolve(candidate,'store.mjs'),'utf8'))+'\n// TEST ONLY modified store is not executed.\n');await writeFile(resolve(candidate,'render.test.mjs'),"setInterval(()=>{},1000);\n");
    const controller=new AbortController(),pending=f.runner.run(request('test'),{signal:controller.signal});
    await new Promise(accept=>setTimeout(accept,120));await assert.rejects(f.runner.run(request('status')),hasCode('RECENT_REVIEW_RUNNER_BUSY'));controller.abort();await assert.rejects(pending,hasCode('RECENT_REVIEW_CANCELLED'));
    assert.equal((await f.runner.run(request('status'))).lab_id,'reader');
    const cancelled=new AbortController();cancelled.abort();await assert.rejects(f.runner.run(request('test'),{signal:cancelled.signal}),hasCode('RECENT_REVIEW_CANCELLED'));
    const pendingDispose=f.runner.run(request('test'));await new Promise(accept=>setTimeout(accept,120));f.runner.dispose();await assert.rejects(pendingDispose,hasCode('RECENT_REVIEW_CANCELLED'));await assert.rejects(f.runner.run({operation:'describe'}),hasCode('RECENT_REVIEW_RUNNER_DISPOSED'));
  }finally{await f.cleanup();}
});

test('stdout overflow refuses silent truncation and test timeout stops an inert child',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare();await writeFile(resolve(candidate,'store.mjs'),(await readFile(resolve(candidate,'store.mjs'),'utf8'))+'\n// TEST ONLY modified store is not executed.\n');await writeFile(resolve(candidate,'render.test.mjs'),"process.stdout.write('TEST '.repeat(20000));setInterval(()=>{},1000);\n");await assert.rejects(f.runner.run(request('test')),hasCode('RECENT_REVIEW_CHILD_OUTPUT_LIMIT'));
    await writeFile(resolve(candidate,'render.test.mjs'),"setInterval(()=>{},1000);\n");await assert.rejects(f.runner.run(request('test')),hasCode('RECENT_REVIEW_CHILD_TIMEOUT'));
  }finally{await f.cleanup();}
});

test('Node permission candidate denies outside canary read/write, candidate writes and child_process while allowing only lab temp writes',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare(),outside=resolve(f.root,'TEST-outside-canary.txt');await writeFile(outside,'TEST ONLY outside must remain unseen and unchanged\n');
    const sample=`import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync,writeFileSync,mkdtempSync,rmSync}from'node:fs';import{spawnSync}from'node:child_process';import{tmpdir}from'node:os';import{join}from'node:path';test('TEST permission boundaries',()=>{assert.equal(process.permission.has('child'),false);const denied=fn=>assert.throws(fn,error=>error.code==='ERR_ACCESS_DENIED');denied(()=>readFileSync(${JSON.stringify(outside)}));denied(()=>writeFileSync(${JSON.stringify(outside)},'forbidden'));denied(()=>writeFileSync(new URL('./render.mjs',import.meta.url),'forbidden'));denied(()=>spawnSync(process.execPath,['-e','process.exit(0)']));const temp=mkdtempSync(join(tmpdir(),'TEST-allowed-'));writeFileSync(join(temp,'ok.txt'),'allowed');assert.equal(readFileSync(join(temp,'ok.txt'),'utf8'),'allowed');rmSync(temp,{recursive:true});});\n`;
    for(const name of ['render.test.mjs','action-result.test.mjs'])await writeFile(resolve(candidate,name),sample);
    const result=await f.runner.run(request('test'));assert.equal(result.passed,true,JSON.stringify(result.results.map(row=>({file:row.file,exit_code:row.exit_code,stdout:row.stdout.slice(-1500),stderr:row.stderr}))));assert.equal(result.node_permission_model,true);assert.equal(result.child_process_allowed,false);assert.equal(result.candidate_read_only,true);assert.ok(result.test_temp_directory.startsWith(resolve(candidate,'../test-temp')));assert.equal(await readFile(outside,'utf8'),'TEST ONLY outside must remain unseen and unchanged\n');
  }finally{await f.cleanup();}
});

test('a self-consistent edited snapshot plus manifest cannot replace the trusted formal source',async()=>{
  const f=await fixture();try{
    const data=JSON.parse(await readFile(f.manifest,'utf8')),file=resolve(f.snapshot,sourcePrefix+'render.mjs');await writeFile(file,(await readFile(file,'utf8'))+'\n// TEST owner forged source snapshot\n');data.files[sourcePrefix+'render.mjs']=hash(await readFile(file));
    const sorted=Object.keys(data.files).sort().map(key=>JSON.stringify(key)+': '+JSON.stringify(data.files[key])),generation=hash('{'+sorted.join(', ')+'}'),snapshot=resolve(f.workspace,'development/runtime-source',generation);await rename(f.snapshot,snapshot);data.generation=generation;const manifest=resolve(snapshot,'manifest.json');await writeFile(manifest,JSON.stringify(data));await writeFile(f.current,JSON.stringify({generation,root:snapshot,manifest}));
    await assert.rejects(f.prepare(),hasCode('RECENT_REVIEW_TRUSTED_SOURCE_HASH_MISMATCH'));
  }finally{await f.cleanup();}
});

test('unchanged store executes only trusted formal equivalents; edited store/test is never raw executed and makes overall result false',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare(),result=await f.runner.run(request('test'));assert.equal(result.passed,true);assert.equal(result.results[0].execution,'trusted_formal_equivalent');assert.equal(result.results[0].trusted_formal_equivalent,true);assert.equal(result.results[0].candidate_executed,false);assert.equal(result.results[0].test_pass_count,14);
    const sentinel=resolve(f.root,'must-not-execute.txt');await writeFile(resolve(candidate,'store.test.mjs'),`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'forbidden');\n`);
    const changed=await f.runner.run(request('test'));assert.equal(changed.passed,false);assert.equal(changed.results[0].not_run,true);assert.equal(changed.results[0].constraint,'NODE_PERMISSION_MODEL_FSYNC_UNAVAILABLE_FOR_EDITED_STORE');assert.ok(changed.results.slice(1).every(row=>row.passed));await assert.rejects(readFile(sentinel),error=>error.code==='ENOENT');
  }finally{await f.cleanup();}
});

test('edited checkpoint/seal target paths cannot make the trusted recovery tool overwrite other workspace files',async()=>{
  const f=await fixture();try{
    const candidate=await f.prepare(),outside=resolve(f.workspace,'unrelated.txt');await writeFile(outside,'TEST ONLY preserve unrelated work\n');
    const checkpoint=await f.runner.run(request('checkpoint','reader','guarded')),metadataPath=resolve(checkpoint.anchor,'checkpoint.json'),original=await readFile(metadataPath,'utf8'),metadata=JSON.parse(original);metadata.files[0].path='unrelated.txt';await writeFile(metadataPath,JSON.stringify(metadata));
    await assert.rejects(f.runner.run(request('seal','reader','guarded')),hasCode('RECENT_REVIEW_CHECKPOINT_SCOPE_INVALID'));assert.equal(await readFile(outside,'utf8'),'TEST ONLY preserve unrelated work\n');await writeFile(metadataPath,original);
    await f.runner.run(request('seal','reader','guarded'));const sealPath=resolve(checkpoint.anchor,'seal.json'),seal=JSON.parse(await readFile(sealPath,'utf8'));seal.files[0].path='unrelated.txt';await writeFile(sealPath,JSON.stringify(seal));
    for(const operation of ['accept','rollback_preview','rollback_apply'])await assert.rejects(f.runner.run(request(operation,'reader','guarded')),hasCode('RECENT_REVIEW_CHECKPOINT_SCOPE_INVALID'));assert.equal(await readFile(outside,'utf8'),'TEST ONLY preserve unrelated work\n');
  }finally{await f.cleanup();}
});

test('Node without the reviewed permission model fails closed before executing candidates',async()=>{
  const f=await fixture(),descriptor=Object.getOwnPropertyDescriptor(process.versions,'node');try{
    await f.prepare();Object.defineProperty(process.versions,'node',{...descriptor,value:'23.0.0'});await assert.rejects(f.runner.run(request('test')),hasCode('RECENT_REVIEW_NODE_PERMISSIONS_UNSUPPORTED'));
  }finally{Object.defineProperty(process.versions,'node',descriptor);await f.cleanup();}
});
