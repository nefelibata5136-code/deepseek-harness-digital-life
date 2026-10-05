import assert from 'node:assert/strict';
import test from 'node:test';
import {mountParallelFileVersions} from './file-operation-locks.mjs';
test('audited XHS browsing avoids workspace snapshots; opaque and write operations keep protection',async()=>{
  let handler;const versions=[];
  const ctx={on:(name,fn)=>{if(name==='tools/execute')handler=fn;},effect:()=>{},get:()=>undefined,emit:()=>{}};
  const run=(...args)=>{versions.push(args);return {token:'test-token'};};
  run.async=async(...args)=>run(...args);
  mountParallelFileVersions(ctx,run,new Set());versions.length=0;
  const exec=name=>({name,arguments:{},signal:new AbortController().signal,agent:{session:{id:'fixture'}}});
  let bodies=0;
  await handler(exec('cap__xiaohongshu__xhs_search_feeds'),async()=>{bodies++;});
  await handler(exec('cap__xiaohongshu__xhs_read_images'),async()=>{bodies++;});
  await handler(exec('read_image'),async()=>{bodies++;});
  await handler(exec('cap__xiaohongshu__xhs_diandian_chat'),async()=>{bodies++;});
  await handler(exec('cap__xiaohongshu__xhs_export_note'),async()=>{bodies++;});
  await handler(exec('cap__xiaohongshu__xhs_read_export'),async()=>{bodies++;});
  assert.equal(bodies,6);assert.equal(versions.length,0);
  for(const name of ['cap__xiaohongshu__xhs_post_comment','cap__xiaohongshu__xhs_publish_content','cap__other__xhs_search_feeds','terminal']){
    versions.length=0;await handler(exec(name),async()=>{bodies++;});
    assert.equal(versions[0][0],'begin-file');assert.equal(versions[1][0],'end-file');
  }
});
