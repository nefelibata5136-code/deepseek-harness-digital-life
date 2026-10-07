import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';

// Only the production bootstrap executes. Native resume, credentials, Room
// mounts and the Host transport are deterministic seams; no Provider exists.
const PRIMARY='80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b';
const LIFE='life-ca23d767-1b53-5adf-b85b-19bb81c72286';
const BAD='dcf36529-73dc-5c42-b5c4-a7ef997c34f9';
const GOOD='0891c0bf-64df-5db7-8b85-a6c3ebdaa63a';
let current;
const url=path=>new URL(path,import.meta.url).href;
mock.module(url('../legacy.mjs'),{namedExports:{inspectLegacy:async()=>({lifeId:LIFE,authoritySessionId:PRIMARY,deployment:{workspace:'test-only-workspace',presetId:'persona'}})}});
mock.module(url('../../capabilities/isolation.mjs'),{namedExports:{credentialOperation:async()=>({value:'fixture-private-control-credential'})}});
mock.module(url('./legacy-worker.mjs'),{namedExports:{
  createWorkerControlTransport:()=>async(operation,input)=>{current.rpc.push({operation,input});if(operation==='timeline'&&current.emitFailures-->0)throw new Error('fixture transport unavailable');return {saved:true};},
  mountLegacyWorker:async()=>{if(current.primaryUnavailable)throw Object.assign(new Error('private resume error body'),{code:'LEGACY_WORKER_PRIMARY_RESOLUTION_FAILED'});return current.bridge(PRIMARY);},
  mountRoomWorker:async(_ctx,{authoritySessionId})=>current.bridge(authoritySessionId),
}});
mock.module(url('./legacy-room-inbox.mjs'),{namedExports:{mountLegacyRoomInbox:async()=>current.receiver(),mountRoomInbox:async()=>current.receiver()}});
mock.module(url('./legacy-human-timeline.mjs'),{namedExports:{mountLegacyHumanTimeline:async()=>({status:()=>({enabled:true}),drain:async()=>{},recordHumanTurn:async()=>{}})}});
const {mountProductionLegacy}=await import('./production-legacy.mjs');

async function fixture(t,{activities=true,primaryUnavailable=false,emitFailures=0}={}) {
  t.mock.timers.enable({apis:['setInterval']});
  const root=mkdtempSync(resolve(tmpdir(),'production-legacy-test-'));
  assert.equal(resolve(root).startsWith(resolve(tmpdir())+'\\')||resolve(root).startsWith(resolve(tmpdir())+'/'),true);
  const control=resolve(process.env.DL_WORLD_ROOT || resolve(root,'.local/world'), '.'),file=resolve(control,'workers',LIFE,'test-sessions.json');
  mkdirSync(resolve(control,'workers',LIFE),{recursive:true});
  writeFileSync(resolve(control,'birth.json'),JSON.stringify({worker_token_ref:'fixture',port:1,human_a_room_id:'fixture-room'}));
  const rows=activities?[{session_id:BAD,title:'Unavailable archive'},{session_id:GOOD,title:'Healthy activity'}]:[];
  writeFileSync(file,JSON.stringify({schema_version:1,life_id:LIFE,sessions:rows}));
  const originalMetadata=readFileSync(file),journal=resolve(root,'unavailable-original.jsonl'),originalJournal=Buffer.from('original private input and tool history\r\n');
  writeFileSync(journal,originalJournal);
  const effects=[],s={rpc:[],resolved:[],mounted:[],disposed:[],primaryUnavailable,emitFailures,badUnavailable:true};
  s.bridge=id=>{s.mounted.push(id);return {status:()=>({ready:true,life_id:LIFE}),recordActivity:async()=>{},dispose:()=>s.disposed.push(id)};};
  s.receiver=()=>({status:()=>({enabled:true}),dispose:()=>{},drain:async()=>{}});
  current=s;
  const main={session:{id:PRIMARY},ctx:{systemPrompt:{section:()=>()=>{}}}},ctx={
    agents:new Map([[PRIMARY,main]]),get:()=>null,provide:()=>{},on:()=>()=>{},effect:fn=>effects.push(fn()),
    personaTasks:{running:()=>[],create:async()=>{}},
    sessionController:{resolveAgent:async id=>{s.resolved.push(id);if(id===BAD&&s.badUnavailable)return {error:new Error('SessionQueryError: private error body')};return {agent:{session:{id}}};}},
  };
  const facade=await mountProductionLegacy(ctx,{authoritySessionId:PRIMARY,migrationRoot:root});
  t.after(async()=>{for(const effect of effects.reverse())await effect();rmSync(root,{recursive:true,force:true});});
  const settle=async()=>{for(let n=0;n<8;n++)await new Promise(resolve=>setImmediate(resolve));};
  return {s,facade,file,originalMetadata,journal,originalJournal,async tick(){t.mock.timers.tick(5000);await settle();}};
}

test('an unavailable archive preserves its bytes and cannot take the primary or later activities offline',async t=>{
  const f=await fixture(t);
  assert.equal(f.facade.status().ready,true);
  assert.deepEqual(f.s.mounted,[PRIMARY,GOOD]);
  assert.equal(f.s.disposed.length,0);
  assert.deepEqual(f.facade.status().unavailable_activity_sessions,[{session_id:BAD,error_code:'LEGACY_ACTIVITY_SESSION_UNAVAILABLE',restoration_state:'unavailable',recovery:'explicit_session_restore_required'}]);
  assert.deepEqual(readFileSync(f.file),f.originalMetadata);assert.deepEqual(readFileSync(f.journal),f.originalJournal);
  const notice=f.s.rpc.find(row=>row.operation==='timeline');
  assert.equal(notice.input.recent.sessionId,PRIMARY);assert.equal(notice.input.recent.event.payload.unavailable_session_id,BAD);
  assert.equal(JSON.stringify(notice).includes('private error body'),false);
  await f.tick();await f.tick();
  assert.equal(f.s.resolved.filter(id=>id===BAD).length,1);
  assert.deepEqual(f.s.rpc.findLast(row=>row.operation==='heartbeat').input.session_ids,[PRIMARY,GOOD]);
  // Recovery is an explicit request for the original Session, never a new ID.
  f.s.badUnavailable=false;await f.facade.createTestSession({session_id:BAD,title:'Unavailable archive'});
  assert.deepEqual(f.facade.status().unavailable_activity_sessions,[]);
  assert.deepEqual(readFileSync(f.journal),f.originalJournal);
});

test('primary resume failure publishes the same stable sanitized notice on each local retry',async t=>{
  const f=await fixture(t,{activities:false,primaryUnavailable:true});
  assert.equal(f.facade.status().ready,false);assert.equal(f.facade.status().error_code,'LEGACY_WORKER_PRIMARY_RESOLUTION_FAILED');
  await f.tick();
  const notices=f.s.rpc.filter(row=>row.operation==='timeline');assert.equal(notices.length,2);assert.deepEqual(notices[0],notices[1]);
  assert.equal(notices[0].input.recent.event.occurred_at_utc,null);
  assert.equal(JSON.stringify(notices).includes('private resume error body'),false);
  assert.deepEqual(f.s.resolved,[]);
  f.s.primaryUnavailable=false;await f.tick();assert.equal(f.facade.status().ready,true);assert.equal(f.facade.status().error_code,undefined);
});

test('an unavailable notice transport cannot fail bootstrap and is retried without resuming the bad archive',async t=>{
  const f=await fixture(t,{emitFailures:1});
  assert.equal(f.facade.status().ready,true);assert.equal(f.facade.status().health_notices_pending.length,1);
  await f.tick();assert.deepEqual(f.facade.status().health_notices_pending,[]);
  assert.equal(f.s.resolved.filter(id=>id===BAD).length,1);
  assert.deepEqual(f.s.rpc.filter(row=>row.operation==='timeline').map(row=>row.input.recent.event),[
    f.s.rpc.find(row=>row.operation==='timeline').input.recent.event,f.s.rpc.find(row=>row.operation==='timeline').input.recent.event,
  ]);
});
