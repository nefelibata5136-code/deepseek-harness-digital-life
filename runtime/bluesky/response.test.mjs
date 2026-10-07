import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bluesky, safeCall } from './bundle/client.mjs';

const own='did:plc:example';
const uri='at://did:plc:fixture/app.bsky.feed.post/fixture';
const credentials={resolve:async()=>({value:'synthetic-password'}),describe:async()=>({configured:true})};
const login=()=>Response.json({did:own,handle:'personao.bsky.social',accessJwt:'synthetic-token',
  didDoc:{service:[{id:'#atproto_pds',serviceEndpoint:'https://fixture.host.bsky.network'}]}});

test('official empty-output writes reach independent state readback and preserve other preferences',async()=>{
  let bookmarked=false,preferences=[{$type:'app.bsky.actor.defs#unknownPref',preserve:'other-value'}];
  const request=async(url,init)=>{
    const method=url.pathname.split('/').at(-1);
    if(method==='com.atproto.server.createSession')return login();
    if(method==='app.bsky.feed.getPosts')return Response.json({posts:[{uri,cid:'fixture-cid',author:{did:'did:plc:fixture'},
      record:{text:'fixture'},viewer:{bookmarked}}]});
    if(method==='app.bsky.bookmark.createBookmark'){bookmarked=true;return new Response(null,{status:200});}
    if(method==='app.bsky.bookmark.deleteBookmark'){bookmarked=false;return new Response(null,{status:204});}
    if(method==='app.bsky.actor.getPreferences')return Response.json({preferences});
    if(method==='app.bsky.actor.putPreferences'){preferences=JSON.parse(init.body).preferences;return new Response(' \n',{status:200});}
    if(method==='app.bsky.notification.updateSeen')return new Response(null,{status:200});
    if(method==='app.bsky.notification.getUnreadCount')return Response.json({count:0});
    throw Error('Unexpected fixture request');
  };
  const client=new Bluesky(credentials,{request});
  try {
    assert.equal((await client.extended.bookmarkAction({action:'create',uri})).verified,true);
    assert.equal((await client.extended.bookmarkAction({action:'delete',uri})).verified,true);
    assert.equal((await client.extended.safetyUpdate({kind:'muted_word',action:'add',word:'fixture-unique'})).verified,true);
    assert.equal(preferences[0].preserve,'other-value');
    assert.equal((await client.extended.safetyUpdate({kind:'muted_word',action:'remove',word:'fixture-unique'})).verified,true);
    assert.equal(preferences[0].preserve,'other-value');
    assert.equal((await client.extended.notificationsSeen({})).unreadCount,0);
  } finally {await client.close();}
});

test('empty JSON reads and failed or nonempty malformed void writes remain errors',async()=>{
  for(const response of [()=>new Response(null,{status:200}),()=>new Response('<html>bad gateway</html>',{status:200})]){
    const client=new Bluesky(credentials,{request:async()=>response()});
    try{assert.equal((await safeCall(()=>client.status())).error,'BLUESKY_NON_JSON_RESPONSE');}
    finally{await client.close();}
  }
  for(const response of [()=>new Response(null,{status:500}),()=>new Response('<html>bad gateway</html>',{status:200})]){
    const client=new Bluesky(credentials,{request:async url=>{
      const method=url.pathname.split('/').at(-1);
      if(method==='com.atproto.server.createSession')return login();
      if(method==='app.bsky.feed.getPosts')return Response.json({posts:[{uri,cid:'fixture-cid',record:{text:'fixture'},author:{did:'did:plc:fixture'}}]});
      return response();
    }});
    try{assert.equal((await safeCall(()=>client.extended.bookmarkAction({action:'create',uri}))).error,'BLUESKY_NON_JSON_RESPONSE');}
    finally{await client.close();}
  }
});
