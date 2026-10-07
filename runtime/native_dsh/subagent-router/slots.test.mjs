import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const worker=new URL('./slot-worker.mjs',import.meta.url);
test('cross-process cap and dead-worker slot reclamation without stealing live leases',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luna-slots-')),events=[];
 const run=mode=>new Promise((resolve,reject)=>{
  const child=fork(worker,[root,mode],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  child.on('message',event=>events.push(event));child.once('error',reject);child.once('exit',code=>code===(mode==='crash'?9:0)?resolve():reject(new Error('worker exit '+code)));
 });
 try{
  await run('crash');events.length=0;
  await Promise.all(Array.from({length:10},()=>run('normal')));
  const periods=new Map();for(const event of events){const row=periods.get(event.pid)??{};row[event.kind]=event.at;periods.set(event.pid,row);}
  assert.equal(periods.size,10);
  const edges=[...periods.values()].flatMap(p=>[{at:p.acquired,delta:1},{at:p.released,delta:-1}]).sort((a,b)=>a.at-b.at||a.delta-b.delta);
  let active=0,peak=0;for(const e of edges){active+=e.delta;peak=Math.max(peak,active);}assert.equal(peak,2);assert.equal(active,0);
  assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
