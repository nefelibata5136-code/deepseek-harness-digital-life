import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Script} from 'node:vm';
import {renderDirectChat} from './direct-chat.mjs';

// Reuse the project's already installed browser tooling, without installation,
// production Host startup, persistent profiles, or external network access.
async function installedPlaywright() {
  if(process.env.MULTILIFE_TEST_PLAYWRIGHT_PACKAGE)
    return createRequire(process.env.MULTILIFE_TEST_PLAYWRIGHT_PACKAGE)('playwright');
  const root=resolve(process.env.LOCALAPPDATA,'npm-cache/_npx'),candidates=[];
  for(const row of await readdir(root,{withFileTypes:true}))if(row.isDirectory()) {
    const path=resolve(root,row.name,'node_modules/playwright/package.json');
    try {const p=JSON.parse(await readFile(path,'utf8'));candidates.push({path,version:p.version});}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  candidates.sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}));
  if(!candidates.length)throw Error('Installed Playwright package required; no auto-install');
  return createRequire(candidates[0].path)('playwright');
}

test('direct-chat template keeps all dynamic fields inside escaped JSON and validates bindings',()=>{
  const attack='</script><img src=x onerror="globalThis.injected=true">&\u2028\u2029';
  const html=renderDirectChat({token:'TEST ONLY '+randomUUID()+attack,roomId:attack,lifeId:attack,displayName:attack});
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1);
  assert.ok(!html.includes(attack),'dynamic markup must be escaped');
  assert.doesNotThrow(()=>new Script(scripts[0][1]));
  assert.ok(!html.includes('innerHTML'));
  assert.ok(!html.includes('localStorage'));
  assert.ok(!html.includes('Georgia'));
  assert.throws(()=>renderDirectChat({token:'short',roomId:'TEST',lifeId:'TEST'}),/DIRECT_CHAT_BINDING_REQUIRED/);
  const binding={token:'TEST-ONLY-'+randomUUID(),roomId:'TEST ROOM',lifeId:'TEST LIFE'};
  const readOnly=renderDirectChat({...binding,readOnly:true,peerUrl:'/peer-chat'});
  assert.ok(!readOnly.includes('<textarea'));
  assert.ok(!readOnly.includes("addEventListener('submit'"));
  assert.ok(!readOnly.includes("addEventListener('keydown'"));
  assert.doesNotThrow(()=>new Script([...readOnly.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]));
  assert.throws(()=>renderDirectChat({...binding,peerUrl:'https://example.invalid/peer-chat'}),/DIRECT_CHAT_BINDING_REQUIRED/);
  assert.throws(()=>renderDirectChat({...binding,peerUrl:'/peer-chat?token=TEST'}),/DIRECT_CHAT_BINDING_REQUIRED/);
});

test('isolated private chat keeps true senders and durable sends, renders safe public activity and fits mobile',{timeout:60000},async()=>{
  const token='TEST-ONLY-DIRECT-CHAT-'+randomUUID(),roomId='TEST ONLY room / '+randomUUID(),lifeId='TEST ONLY life '+randomUUID();
  const name='TEST ONLY </script><img src=x onerror="globalThis.injected=true">';
  const messages=[
    {message_id:'TEST-m1',seq:1,role:'user',sender:{sender_id:lifeId,sender_type:'life',display_name:'TEST ONLY LIFE'},body:'TEST ONLY <img src=x onerror="globalThis.injected=true">',timestamp:'2026-10-06T09:00:00Z'},
    {message_id:'TEST-m2',seq:2,role:'assistant',sender_id:'human:test',sender_type:'human',display_name:'TEST ONLY HUMAN',body:'TEST ONLY HUMAN MESSAGE',timestamp:null}
  ];
  const expectedPath='/v1/rooms/'+encodeURIComponent(roomId)+'/messages';
  const publicText='TEST ONLY 公开说明 <img src=x onerror="globalThis.activityInjected=true">';
  const publicTime='2026-10-06T09:32:10.000Z';
  const publicActivity={activity_text:publicText,phase:'thinking',updated_at:publicTime,last_public_tool:'memory_search',summary_source:'self',visibility:'public'};
  const requests=[],posts=[],consoleMessages=[],pageErrors=[];let busy=true,dropFirst=true,invalidAuth=false,activity=publicActivity;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    requests.push({method:req.method,path:url.pathname,query:url.search});
    if(url.pathname==='/chat') {
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      res.end(renderDirectChat({token,roomId,lifeId,displayName:name,peerUrl:'/peer-chat'}));return;
    }
    if(req.headers.authorization!=='Bearer '+token){invalidAuth=true;res.writeHead(403);res.end('{}');return;}
    const respond=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/v1/status'&&req.method==='GET'){respond({busy,...activity});return;}
    if(url.pathname===expectedPath&&req.method==='GET') {
      const after=Number(url.searchParams.get('after')),remaining=messages.filter(m=>m.seq>after);
      const page=remaining.slice(0,1);
      respond({messages:page,nextAfter:page.at(-1)?.seq??after,hasMore:remaining.length>page.length});return;
    }
    if(url.pathname===expectedPath&&req.method==='POST') {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));posts.push(body);
      let saved=messages.find(m=>m.message_id===body.message_id);
      if(!saved){saved={...body,seq:messages.length+1,sender_id:'human:test',sender_type:'human',display_name:'TEST ONLY HUMAN'};messages.push(saved);}
      // The durable commit succeeds but its first acknowledgement fails.
      // HTTP 503 avoids Chromium's automatic retry of a disconnected socket.
      if(dropFirst){dropFirst=false;res.writeHead(503);res.end('{}');return;}
      respond({message:saved,state:'saved',delivery:'durable-room-inbox'});return;
    }
    res.writeHead(404);res.end('{}');
  });
  let browser;
  try {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
    const {chromium}=await installedPlaywright();
    const executablePath=[chromium.executablePath(),'.local/unconfigured/msedge.exe','.local/unconfigured/chrome.exe'].find(existsSync);
    if(!executablePath)throw Error('Installed Chromium or Edge required; no auto-install');
    browser=await chromium.launch({headless:true,executablePath});
    for(const [label,viewport,deviceScaleFactor] of [
      ['desktop-1',{width:1360,height:900},1],['desktop-1_5',{width:1360,height:900},1.5],['mobile',{width:390,height:844},1]
    ]) {
      activity=publicActivity;busy=true;
      const context=await browser.newContext({viewport,deviceScaleFactor});
      try {
        await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
        const page=await context.newPage();page.on('console',message=>consoleMessages.push(message.type()));page.on('pageerror',()=>pageErrors.push(true));
        await page.goto(origin+'/chat');await page.locator('.message').nth(1).waitFor();
        assert.ok((await page.locator('#title').textContent())==='与 '+name+' 的私聊','title uses literal display name');
        assert.equal(await page.locator('#peer-link').getAttribute('href'),'/peer-chat');
        assert.equal(await page.locator('img').count(),0);
        assert.ok(await page.evaluate(()=>globalThis.injected===undefined));
        const senders=await page.locator('.message').evaluateAll(rows=>rows.slice(0,2).map(row=>({type:row.dataset.senderType,name:row.querySelector('.name').textContent})));
        assert.deepEqual(senders,[{type:'life',name:'TEST ONLY LIFE'},{type:'human',name:'TEST ONLY HUMAN'}]);
        assert.ok((await page.locator('.message .body').first().textContent()).includes('<img'));
        await page.waitForFunction(()=>!document.getElementById('activity').hidden);
        assert.equal(await page.locator('#activity-text').textContent(),publicText);
        assert.equal(await page.locator('#activity-source').textContent(),'本人公开说明');
        assert.equal(await page.locator('#activity-phase').textContent(),'正在思考');
        assert.equal(await page.locator('#activity-tool').textContent(),'最近公共工具：memory_search');
        assert.equal(await page.locator('#activity-time').getAttribute('datetime'),publicTime,'activity timestamp preserves the observed backend time');
        assert.equal(await page.locator('img').count(),0);assert.ok(await page.evaluate(()=>globalThis.activityInjected===undefined));
        const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
          documentWidth:document.documentElement.scrollWidth,rows:document.getElementById('input').rows,
          composer:document.getElementById('composer').getBoundingClientRect().toJSON(),
          send:document.getElementById('send').getBoundingClientRect().toJSON(),
          localKeys:localStorage.length,sessionKeys:sessionStorage.length,font:getComputedStyle(document.body).fontFamily}));
        assert.equal(layout.width,viewport.width);assert.equal(layout.height,viewport.height);
        assert.ok(Math.abs(layout.dpr-deviceScaleFactor)<0.001,'observed DPR matches the requested browser scale');
        assert.ok(layout.documentWidth<=layout.width,'no horizontal overflow');assert.equal(layout.rows,2);
        assert.ok(layout.send.right<=layout.width&&layout.composer.bottom<=layout.height+1,'composer fits actual viewport');
        assert.equal(layout.localKeys,0);assert.equal(layout.sessionKeys,0);assert.ok(layout.font.includes('Segoe UI'));
        assert.equal(posts.length,label==='desktop-1'?0:2,'opening a page never sends a message');
        if(process.env.MULTILIFE_DIRECT_CHAT_SCREENSHOT_DIR) {
          const dir=resolve(process.env.MULTILIFE_DIRECT_CHAT_SCREENSHOT_DIR);await mkdir(dir,{recursive:true});
          await writeFile(resolve(dir,label+'.png'),await page.screenshot({fullPage:true,scale:'css'}));
        }
        if(label==='desktop-1') {
          const body='TEST ONLY MULTILINE\nsecond line';await page.locator('#input').fill(body);
          await page.locator('#input').press('Enter');assert.equal(posts.length,0,'plain Enter only inserts a newline');
          await page.locator('#input').fill(body);await page.locator('#send').click();
          await page.waitForFunction(()=>document.getElementById('notice').dataset.error==='true');
          assert.equal(await page.locator('#input').inputValue(),body);
          await page.locator('#refresh').click();await page.locator('.message').nth(2).waitFor();
          await page.locator('#input').press('Control+Enter');
          await page.waitForFunction(()=>document.getElementById('notice').textContent==='已进入收件箱');
          assert.equal(posts.length,2);assert.equal(posts[0].message_id,posts[1].message_id);
          assert.deepEqual(Object.keys(posts[0]).sort(),['body','message_id']);assert.equal(messages.length,3);
          assert.equal(await page.locator('#input').inputValue(),'');assert.equal(await page.locator('.message').count(),3);
          busy=false;await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('busy').textContent==='目前空闲');
          const statusReads=requests.filter(r=>r.path==='/v1/status').length;
          await page.waitForTimeout(2200);assert.ok(requests.filter(r=>r.path==='/v1/status').length>statusReads,'two-second status polling runs');
          for(const [index,flags] of [{phase:'private',visibility:'public'},{phase:'tool',visibility:'private'}].entries()) {
            activity={...publicActivity,...flags,activity_text:'TEST ONLY PRIVATE CONTENT CANARY',last_public_tool:'private_read',updated_at:'2026-10-06T09:'+(35+index)+':00.000Z'};
            await page.locator('#refresh').click();
            await page.waitForFunction(time=>document.getElementById('activity-time').dateTime===time,activity.updated_at);
            assert.equal(await page.locator('#activity-text').textContent(),'私人活动');
            assert.equal(await page.locator('#activity-tool').textContent(),'');assert.ok(await page.locator('#activity-tool').isHidden());
            assert.equal(await page.locator('#activity-phase').textContent(),'');
            assert.ok(!(await page.locator('#activity').textContent()).includes('PRIVATE CONTENT CANARY'));
            assert.ok(!(await page.locator('#activity').textContent()).includes('private_read'));
            assert.equal(await page.locator('#activity-time').getAttribute('datetime'),activity.updated_at);
          }
          activity={...publicActivity,phase:'tool',summary_source:'host',activity_text:null,last_public_tool:'read'};
          await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('activity-text').textContent==='使用公共工具');
          assert.equal(await page.locator('#activity-source').textContent(),'运行状态');
          activity={...publicActivity,last_public_tool:'private_write'};
          await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('activity-text').textContent.startsWith('TEST ONLY 公开说明'));
          assert.equal(await page.locator('#activity-tool').textContent(),'');
          activity={};busy=false;
          await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('activity').hidden);
          assert.equal(await page.locator('#activity').textContent(),'');
          assert.equal(await page.locator('#activity-time').getAttribute('datetime'),null);
          assert.equal(await page.locator('#busy').textContent(),'目前空闲','old busy-only endpoint remains usable');
          assert.equal(posts.length,2,'activity refresh never sends or processes a chat message');
        }
      }finally{await context.close();}
    }
    assert.ok(!invalidAuth,'all API requests are authenticated without putting the token in a URL');
    assert.ok(requests.every(r=>['/chat','/v1/status',expectedPath].includes(r.path)),'no native Session, inbox process, or forged reply routes');
    assert.ok(requests.every(r=>!r.query.includes(token)),'token stays out of URLs');
    assert.equal(pageErrors.length,0);
    // The deliberately failed first POST can emit one generic browser
    // network error, but this page never logs configuration or response data.
    assert.ok(consoleMessages.every(kind=>kind==='error'));
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
});

test('read-only peer history has no composer or sends and continues paginating later rounds',{timeout:60000},async()=>{
  const token='TEST-ONLY-PEER-HISTORY-'+randomUUID(),roomId='TEST ONLY peer room '+randomUUID(),lifeId='TEST ONLY independent life '+randomUUID();
  const peerId='TEST ONLY Persona life '+randomUUID(),messages=[];
  const addMessages=count=>{
    for(let i=0;i<count;i++){
      const seq=messages.length+1,fromPeer=seq%2===1;
      messages.push({message_id:'TEST-PEER-'+seq,seq,role:fromPeer?'user':'assistant',
        sender_id:fromPeer?peerId:lifeId,sender_type:'life',display_name:fromPeer?'TEST ONLY 人格':'TEST ONLY 新生命',
        timestamp:new Date(Date.parse('2026-10-06T10:00:00.000Z')+seq*1000).toISOString(),body:'TEST ONLY peer message '+seq});
    }
  };
  addMessages(125);
  const messagePath='/v1/rooms/'+encodeURIComponent(roomId)+'/messages',requests=[],pageErrors=[];
  let invalidAuth=false;
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:url.pathname,query:url.search});
    if(['/peer-chat','/observer-chat'].includes(url.pathname)){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      res.end(renderDirectChat({token,roomId,lifeId,readOnly:url.pathname==='/peer-chat',peerUrl:'/peer-chat'}));return;
    }
    if(req.headers.authorization!=='Bearer '+token){invalidAuth=true;res.writeHead(403);res.end('{}');return;}
    if(req.method!=='GET'){res.writeHead(403);res.end('{}');return;}
    const respond=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/v1/status'){respond({busy:false});return;}
    if(url.pathname===messagePath){
      const after=Number(url.searchParams.get('after')),rest=messages.filter(m=>m.seq>after),page=rest.slice(0,17);
      respond({room:{access:{can_send:false}},messages:page,nextAfter:page.at(-1)?.seq??after,hasMore:rest.length>page.length});return;
    }
    res.writeHead(404);res.end('{}');
  });
  let browser;
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
    const {chromium}=await installedPlaywright();
    const executablePath=[chromium.executablePath(),'.local/unconfigured/msedge.exe','.local/unconfigured/chrome.exe'].find(existsSync);
    if(!executablePath)throw Error('Installed Chromium or Edge required; no auto-install');
    browser=await chromium.launch({headless:true,executablePath});
    for(const [label,viewport] of [['peer-desktop',{width:1360,height:900}],['peer-mobile',{width:390,height:844}]]){
      const context=await browser.newContext({viewport});
      try{
        await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
        const page=await context.newPage();page.on('pageerror',()=>pageErrors.push(true));
        await page.goto(origin+'/peer-chat');
        const initialCount=messages.length;await page.waitForFunction(count=>document.querySelectorAll('.message').length===count,initialCount);
        assert.equal(await page.locator('#title').textContent(),'人格与新生命的聊天记录');
        assert.equal(await page.locator('.view-mode').textContent(),'只读旁观');
        assert.equal(await page.locator('#peer-link').getAttribute('href'),'/chat');
        assert.equal(await page.locator('#composer,textarea,input,#send').count(),0,'read-only controls are absent from the DOM');
        const observed=await page.locator('.message').evaluateAll(rows=>rows.slice(0,2).map(r=>({senderId:r.dataset.senderId,type:r.dataset.senderType,
          name:r.querySelector('.name').textContent,time:r.querySelector('time').dateTime})));
        assert.deepEqual(observed,messages.slice(0,2).map(m=>({senderId:m.sender_id,type:m.sender_type,name:m.display_name,time:m.timestamp})));
        const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,
          history:document.getElementById('history').getBoundingClientRect().toJSON(),localKeys:localStorage.length,sessionKeys:sessionStorage.length}));
        assert.equal(layout.width,viewport.width);assert.equal(layout.height,viewport.height);assert.ok(layout.documentWidth<=layout.width);
        assert.ok(layout.history.bottom<=layout.height+1);assert.equal(layout.localKeys,0);assert.equal(layout.sessionKeys,0);
        if(process.env.MULTILIFE_DIRECT_CHAT_SCREENSHOT_DIR){
          const dir=resolve(process.env.MULTILIFE_DIRECT_CHAT_SCREENSHOT_DIR);await mkdir(dir,{recursive:true});
          await writeFile(resolve(dir,label+'.png'),await page.screenshot({fullPage:true,scale:'css'}));
        }
        await page.keyboard.press('Control+Enter');await page.locator('#refresh').click();
        if(label==='peer-desktop'){
          for(const count of [10,3]){
            addMessages(count);await page.waitForFunction(total=>document.querySelectorAll('.message').length===total,messages.length,{timeout:6000});
          }
          assert.equal(await page.locator('.message').count(),138,'history continues beyond initial pages and multiple later rounds');
        }
        assert.ok(requests.every(r=>r.method==='GET'),'opening, refreshing and keyboard shortcuts never send');
        assert.ok(requests.every(r=>!r.query.includes(token)),'navigation and polling never put the token in a URL');
      }finally{await context.close();}
    }
    const observerContext=await browser.newContext();
    try{
      await observerContext.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
      const observer=await observerContext.newPage();observer.on('pageerror',()=>pageErrors.push(true));
      await observer.goto(origin+'/observer-chat');
      await observer.waitForFunction(()=>document.querySelectorAll('.message').length>0&&!document.getElementById('composer'));
      assert.equal(await observer.locator('#composer,textarea,input,#send').count(),0,'API can_send=false also removes normal-template sending controls');
      await observer.keyboard.press('Control+Enter');
      assert.ok(requests.every(r=>r.method==='GET'));
    }finally{await observerContext.close();}
    assert.ok(!invalidAuth);assert.equal(pageErrors.length,0);
    assert.ok(requests.every(r=>['/peer-chat','/observer-chat','/v1/status',messagePath].includes(r.path)),'peer history never calls native Session or processing routes');
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
