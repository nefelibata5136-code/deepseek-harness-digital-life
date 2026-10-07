import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {mountParallelFileVersions} from './file-operation-locks.mjs';
const deferred = () => Promise.withResolvers();
const begin = deferred(), end = deferred();
let first = true, toolA = false, toolB = false, beginEntered = deferred(), endEntered = deferred();
const hooks = new Map(), effects = [];
const ctx = {on:(name,fn)=>hooks.set(name,fn),effect:fn=>effects.push(fn()),
  get:()=>({resolve:async path=>path,processPath:path=>path})};
const run = () => ({});
run.async = async (...args) => {
  if(args[0] === 'begin-file') {
    if(first) {first=false;beginEntered.resolve();await begin.promise;return {token:'a'};}
    return {token:'b'};
  }
  if(args[0] === 'end-file' && args[2] === 'a') {endEntered.resolve();await end.promise;}
  return {};
};
const versions = mountParallelFileVersions(ctx,run,new Set());
const server = createServer((_req,res)=>res.end('ready'));
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const url = 'http://127.0.0.1:'+server.address().port;
const exec = id => ({name:'write',agent:{session:{id,header:{cwd:process.cwd()}}},
  arguments:{file_path:resolve('same-file.txt')},signal:new AbortController().signal});
try {
  const a = hooks.get('tools/execute')(exec('a'),async()=>{toolA=true;});
  await beginEntered.promise;
  await assert.rejects(hooks.get('tools/execute')(exec('b'),async()=>{toolB=true;}),e=>e.code==='FILE_BUSY');
  assert.equal(await (await fetch(url,{signal:AbortSignal.timeout(1000)})).text(),'ready');
  assert(!toolA&&!toolB,'Pre-tool backup must finish before either writer executes');
  begin.resolve(); await endEntered.promise;
  assert(toolA&&!toolB,'Same-file lock must survive post-tool backup');
  assert.equal(await (await fetch(url,{signal:AbortSignal.timeout(1000)})).text(),'ready');
  end.resolve(); await a;
  await hooks.get('tools/execute')(exec('b'),async()=>{toolB=true;});assert(toolB); assert.equal(versions.active.size,0);
  await effects[0]();
  const failingHooks = new Map(); let called = false;
  const bad = () => ({}); bad.async = async()=>{throw new Error('backup failed');};
  const failing = mountParallelFileVersions({on:(name,fn)=>failingHooks.set(name,fn),effect:()=>{},get:ctx.get},bad,new Set());
  await assert.rejects(failingHooks.get('tools/execute')(exec('c'),async()=>{called=true;}),/backup failed/);
  await assert.rejects(failingHooks.get('tools/execute')(exec('d'),async()=>{called=true;}),/backup failed/);
  assert(!called); assert.throws(failing.assertHealthy,/backup failed/);
  const root = resolve('reports/digital-life/reconnect-20261005');
  const sourceSha256 = {};
  for(const path of ['runtime/workspace_foundation/lifecycle.mjs','runtime/workspace_foundation/file-operation-locks.mjs'])
    sourceSha256[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  const result = {passed:true,observedAt:new Date().toISOString(),modelCalls:0,sourceSha256,
    checks:['HTTP remains responsive during pre/post backup','tool waits for pre-backup','same-file lock covers post-backup','backup failure blocks further tools','async disposal awaited']};
  await writeFile(resolve(root,'async-snapshot-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {begin.resolve();end.resolve();server.close();}
