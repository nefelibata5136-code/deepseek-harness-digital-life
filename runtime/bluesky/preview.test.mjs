import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPreview } from './bundle/preview.mjs';
import { createSearch } from './bundle/search.mjs';
test('30 independently supplied topics fetch at most 100 and numbered references survive changed records',async()=>{
  const root=await mkdtemp(join(tmpdir(),'persona-preview-'));let fetched=0;
  const preview=createPreview({root,search:async({query,limit})=>{fetched+=limit;return {posts:Array.from({length:limit},(_,i)=>({uri:`at://did:plc:a/app.bsky.feed.post/${query}-${i}`,cid:'old',text:'完整正文',author:{did:'did:plc:a'}}))};},feed:()=>{},readPost:async uri=>({uri,cid:'changed',text:'更新正文'})});
  try {
    const batch=await preview.batch({directions:Array.from({length:30},(_,i)=>({query:'topic'+i})),max_results:100,per_direction:100});
    assert.equal(fetched,100);assert.equal(batch.total,100);assert.equal(batch.pages.length,30);
    const chosen=batch.candidates[16],opened=await preview.open({batch_id:batch.batch_id,number:17});
    assert.equal(opened.snapshot.uri,chosen.uri);assert.equal(opened.current.uri,chosen.uri);assert.equal(opened.recordChanged,true);
    await assert.rejects(preview.open({batch_id:'../../credentials',number:17}));
    await preview.preferencesUpdate({topics:['自由的新兴趣'],max_results:2,free_directions:['随机看别人怎样安排生活']});
    const next=await preview.batch({use_saved:true});assert.equal(next.total,2);
  }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\')||resolve(root).startsWith(resolve(tmpdir())+'/'));await rm(root,{recursive:true,force:true});}
});
test('V2 structured filters retain their semantics, viewer filters authenticate, images disclose page filter',async()=>{
  const calls=[];const execute=async(m,a,signal)=>{calls.push({m,a});return {posts:[{uri:'a',embed:{images:[{}]}},{uri:'b',embed:{playlist:'video'}}],cursor:'next'};};
  let authenticated=false;
  const search=createSearch({publicRpc:execute,authedRpc:async(m,a,o)=>{authenticated=true;return execute(m,a,o.signal);},normalizePost:p=>p});
  const d=await search({authors:['a.bsky.social','b.bsky.social'],tags:['#cat','#art'],media:'images',following:true,sort:'top',limit:10,
    exclude_mentions:['c.bsky.social'],exclude_domains:['example.org'],exclude_urls:['https://example.org/a'],exclude_quoted_posts:['at://did:plc:a/app.bsky.feed.post/a']});
  assert.equal(authenticated,true);assert.deepEqual(calls[0].a.authors,['a.bsky.social','b.bsky.social']);assert.deepEqual(calls[0].a.hashtags,['cat','art']);
  assert.equal(calls[0].a.hasMedia,true);assert.equal(calls[0].m,'app.bsky.feed.searchPostsV2');assert.equal(d.posts.length,1);assert.equal(d.filtering.excluded,1);
  assert.deepEqual(calls[0].a.excludeMentions,['c.bsky.social']);assert.deepEqual(calls[0].a.excludeDomains,['example.org']);
  assert.deepEqual(calls[0].a.excludeUrls,['https://example.org/a']);assert.deepEqual(calls[0].a.excludeEmbeddedAtUris,['at://did:plc:a/app.bsky.feed.post/a']);
});
