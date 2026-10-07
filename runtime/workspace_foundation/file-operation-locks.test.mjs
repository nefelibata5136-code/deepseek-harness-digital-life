import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFileLocks,mountParallelFileVersions,hostOnlyTools} from './file-operation-locks.mjs';
const signal=()=>new AbortController().signal;
const pending=()=>Promise.withResolvers();
test('same file conflict returns holder immediately; different files and later retry work',async()=>{
  const locks=createFileLocks(),a=await locks.acquire('a','persona',signal(),{life_id:'one',call_id:'call-a',tool:'edit'});
  await assert.rejects(locks.acquire('a','newlife',signal()),e=>e.code==='FILE_BUSY'&&e.details.operation_started===false&&e.details.holders[0].session_id==='persona');
  const b=await locks.acquire('b','newlife',signal());b.release();a.release();
  const retry=await locks.acquire('a','newlife',signal());retry.release();assert.deepEqual(locks.owners,[]);locks.dispose();
});
function fixture(){
  const hooks=new Map(),backups=[];
  const ctx={on:(n,fn)=>hooks.set(n,fn),effect(){},get:n=>n==='fs'?{resolve:async p=>p,processPath:p=>p}:undefined};
  const run=(...args)=>{backups.push(args);return {token:'fixture-'+backups.length};};
  const versions=mountParallelFileVersions(ctx,run,new Set());backups.length=0;
  const exec=(name,id='a',path='C:/fixture/a.txt')=>({name,callId:'call-'+id,agent:{session:{id,header:{cwd:'C:/fixture'}}},arguments:{file_path:path},signal:signal()});
  return {execute:hooks.get('tools/execute'),exec,versions,backups};
}
test('Host journal, child submission, status and read tools bypass held workspace operation and backups',async()=>{
  const f=fixture(),gate=pending(),entered=pending();
  const first=f.execute(f.exec('terminal'),async()=>{entered.resolve();await gate.promise;return 'done';});await entered.promise;
  const count=f.backups.length;
  for(const name of [...hostOnlyTools,'read','read_source','cap__dots__check_dots_task'])assert.equal(await f.execute(f.exec(name,'b'),async()=>name),name);
  assert.equal(f.backups.length,count);gate.resolve();await first;
});
test('conflict executes no tool and creates no backup, while lease survives post-write backup',async()=>{
  const f=fixture(),end=pending(),atEnd=pending();
  // Use a real async durability seam to verify the lock covers post-operation persistence.
  const hooks=new Map();const run=()=>({});run.async=async(...args)=>{if(args[0]==='begin-file')return {token:'first'};if(args[0]==='end-file'){atEnd.resolve();await end.promise;}return {};};
  mountParallelFileVersions({on:(n,fn)=>hooks.set(n,fn),effect(){},get:n=>n==='fs'?{resolve:async p=>p,processPath:p=>p}:undefined},run,new Set());
  const execute=hooks.get('tools/execute');let executed=0;
  const first=execute(f.exec('write'),async()=>{executed++;});await atEnd.promise;
  await assert.rejects(execute(f.exec('edit','b'),async()=>executed++),e=>e.code==='FILE_BUSY');
  assert.equal(executed,1);end.resolve();await first;
});
test('already cancelled acquisition creates no lease; failed backup still blocks later writes',async()=>{
  const locks=createFileLocks(),cancel=new AbortController();cancel.abort(Error('cancelled'));
  await assert.rejects(locks.acquire('a','owner',cancel.signal),/cancelled/);assert.deepEqual(locks.owners,[]);
  const hooks=new Map(),run=()=>({});run.async=async()=>{throw Error('backup failed');};
  const v=mountParallelFileVersions({on:(n,fn)=>hooks.set(n,fn),effect(){},get:n=>n==='fs'?{resolve:async p=>p,processPath:p=>p}:undefined},run,new Set());
  const f=fixture();await assert.rejects(hooks.get('tools/execute')(f.exec('write'),async()=>assert.fail('unsafe write')),/backup failed/);
  assert.throws(v.assertHealthy,/backup failed/);
});
