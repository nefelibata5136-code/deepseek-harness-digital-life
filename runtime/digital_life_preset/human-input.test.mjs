import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {IncomingMessage,ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {mountHumanInput} from './human-input.mjs';
import {createEntrance} from './entrance.mjs';

const require=createRequire(new URL('../native_dsh/package.json',import.meta.url));
const load=async name=>import(pathToFileURL(require.resolve(name)).href);
const {Context,Service}=await load('@deepseek-ai/cordis');
const {bindTypertRemote}=await load('@deepseek-ai/dsh-typert-protocol');
const {createUserMessage}=await load('@deepseek-ai/dsh-llm');
const wait=()=>{let resolve;const promise=new Promise(accept=>{resolve=accept;});return {promise,resolve};};

async function setup() {
  const root=await mkdtemp(resolve(tmpdir(),'digital-life-TEST-ONLY-human-input-')),ctx=new Context();
  const live=new Map(),operator={id:randomUUID()},events=[],messages=[],calls=[];
  const t={root,ctx,live,operator,events,messages,calls,now:Date.parse('2026-10-07T03:04:05.678Z')};
  const agent={id:randomUUID(),ctx:{preset:'persona'},inbox:{nextTurn:[],nextStep:[]}};
  agent.session={id:agent.id,header:{version:4,id:agent.id,createdAt:123,cwd:resolve(root,'TEST-ONLY-workspace'),agentPreset:'persona',isSeeded:false},
    ownEvents:()=>events.values(),snapshotEvents:()=>events.slice()};live.set(agent.id,agent);t.agent=agent;
  ctx.provide('connection',{operator});ctx.provide('agents',{get:id=>live.get(id)});
  ctx.provide('agentPresets',{composedPreset:agentCtx=>agentCtx.preset});
  class PublicController extends Service {
    constructor(ctx){super(ctx,'sessionController');this.typertRemote=bindTypertRemote(this,'sessionController',{namespace:'session'});}
    async resolveAgent(id){if(t.resolveBarrier)await t.resolveBarrier;return {agent:live.get(id)};}
    async prompt(request,signal) {
      calls.push({receiver:this,invocation:this.ctx.invocation,request:structuredClone(request)});signal?.throwIfAborted();
      if(t.nativeError)throw t.nativeError;if(t.nativeRefusal)return {accepted:false};
      const owner=live.get(request.sessionId);if(!owner)throw Error('TEST ONLY NATIVE NO SESSION');
      const already=[...owner.inbox.nextTurn,...owner.inbox.nextStep,...events.filter(event=>event.type==='user/message').map(event=>event.data)]
        .some(message=>message.source?.kind==='user'&&message.source.rpcId===request.requestId);
      if(!already){const message=createUserMessage({content:request.content,source:{kind:'user',rpcId:request.requestId}});messages.push(message);owner.inbox.nextTurn.push(message);
        ctx.emit('session/event',owner.session,{type:'agent/inbox/spliced',data:{inserted:[message]}});ctx.emit('agent/inbox/inserted',{agent:owner,message});await t.onMessage?.(owner,message);}
      return {accepted:true};
    }
  }
  await ctx.plugin(PublicController).await();
  t.mount=()=>{t.input=mountHumanInput(ctx,{root,now:()=>t.now});return t.input;};t.mount();
  t.request=(body='TEST ONLY BODY '+randomUUID(),extra={})=>({sessionId:agent.id,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:body}],clientTimeZone:'Asia/Shanghai',...extra});
  t.invoke=(request,{peer=operator,namespace='session',method='prompt',service='sessionController',frameRequest=request,signal=new AbortController().signal}={})=>{
    const invocation={service,peer,signal,request:{namespace,method,args:{request:frameRequest}}};
    return ctx.extend({invocation}).sessionController.prompt(request,signal);
  };
  t.physical=async(next,{method='POST',url='/api/session/prompt'}={})=>{
    const request=new IncomingMessage(new Socket());request.method=method;request.url=url;
    request[Symbol.asyncIterator]=()=>{throw Error('TEST ONLY BODY MUST NOT BE READ BY PROOF HOOK');};
    const response=new ServerResponse(request);try{return await ctx.waterfall('connection/request',request,response,next);}finally{request.socket.destroy();}
  };
  t.http=(request,options={},route)=>t.physical(()=>t.invoke(request,options),route);
  t.nativeMessage=request=>{const admitted=messages.find(message=>message.source.rpcId===request.requestId);return admitted?{...admitted,content:structuredClone(request.content)}:createUserMessage({content:request.content,source:{kind:'user',rpcId:request.requestId}});};
  t.rows=async()=>{try{return Object.values(JSON.parse(await readFile(resolve(root,'human-input-receipts.json'),'utf8')).receipts);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  t.close=async()=>{t.input.dispose();await ctx.fiber.dispose();await rm(root,{recursive:true,force:false,maxRetries:5,retryDelay:50});};return t;
}

test('installed Cordis Service/proxy keeps scoped invocation and authenticated exact message reaches entrance with the original Host time',async()=>{
  const t=await setup();try {
    const forwarded=[],receiptTime=new Date(t.now).toISOString();
    const entrance=createEntrance({identity:async()=>randomUUID(),receiptFor:t.input.receiptFor,hostRequest:async(method,path,body)=>{forwarded.push({method,path,body});return {status:200};}});
    t.onMessage=(agent,message)=>entrance({agent,messages:[message]},async()=>({kind:'enter',messages:[message]}));
    const request=t.request('TEST ONLY PRIVATE-FREE HUMAN ORIGINAL\n第二行保持完整');await t.http(request);
    assert.equal(t.calls[0].invocation.service,'sessionController');assert.equal(t.calls[0].invocation.request.namespace,'session');assert.equal(t.calls[0].invocation.peer,t.operator);
    assert.deepEqual(t.input.receiptFor(t.agent,t.messages[0]),{humanPrincipalId:'human:maintainer',occurredAt:receiptTime});
    assert.equal(forwarded.length,1);assert.equal(forwarded[0].body.requestId,request.requestId);assert.equal(forwarded[0].body.humanPrincipalId,'human:maintainer');assert.equal(forwarded[0].body.humanOccurredAt,receiptTime);assert.equal(forwarded[0].body.text,request.content[0].text);
    const bytes=await readFile(resolve(t.root,'human-input-receipts.json'),'utf8');assert(!bytes.includes(request.content[0].text));assert(!bytes.includes('第二行'));assert(!bytes.includes(t.operator.id));assert(!bytes.includes(t.agent.session.header.cwd));
    const internal=t.request('TEST ONLY INTERNAL USER');await t.invoke(internal);
    assert.equal(forwarded.length,2);assert(!Object.hasOwn(forwarded[1].body,'humanPrincipalId'));assert(!Object.hasOwn(forwarded[1].body,'humanOccurredAt'));assert.equal(t.input.receiptFor(t.agent,t.messages[1]),null);
  }finally{await t.close();}
});

test('internal and in-process calls, fake peers, other namespaces, and non-exact HTTP routes keep native semantics without human receipts',async()=>{
  const t=await setup();try {
    await t.ctx.sessionController.prompt(t.request(),new AbortController().signal);
    await t.invoke(t.request());
    await t.http(t.request(),{peer:{id:t.operator.id}});
    await t.http(t.request(),{namespace:'other'});
    await t.http(t.request(),{service:'otherController'});
    await t.http(t.request(),{method:'other'});
    await t.http(t.request(),{}, {method:'GET'});
    await t.http(t.request(),{}, {url:'/api/session/prompt?alias=1'});
    await t.http(t.request(),{}, {url:'/api/session/prompt/'});
    assert.equal(t.calls.length,9);assert.equal((await t.rows()).length,0);assert(t.messages.every(message=>t.input.receiptFor(t.agent,message)===null));
  }finally{await t.close();}
});

test('request arguments must match the scoped invocation exactly before proof, including split text content',async()=>{
  const t=await setup();try {
    const request=t.request('TEST ONLY two lines');
    await t.http(request,{frameRequest:{...request,requestId:randomUUID()}});
    await t.http(t.request(),{frameRequest:{...request,sessionId:randomUUID()}});
    await t.http(t.request('TEST ONLY a\nb'),{frameRequest:{...request,content:[{type:'text',text:'TEST ONLY a'},{type:'text',text:'b'}]}});
    assert.equal((await t.rows()).length,0);
    const good=t.request('TEST ONLY exact');await t.http(good,{frameRequest:structuredClone(good)});assert.equal((await t.rows()).length,1);
  }finally{await t.close();}
});

test('different preset and delegate consume their physical request before awaiting and cannot lend it to a later owner prompt',async()=>{
  const t=await setup();try {
    const other={...t.agent,id:randomUUID(),ctx:{preset:'standard'},inbox:{nextTurn:[],nextStep:[]}};
    other.session={...t.agent.session,id:other.id,header:{...t.agent.session.header,id:other.id,agentPreset:'standard'}};t.live.set(other.id,other);
    const ownerRequest=t.request();await t.physical(async()=>{
      await t.invoke(t.request('TEST ONLY wrong preset',{sessionId:other.id}));await t.invoke(ownerRequest);
    });assert.equal(t.input.receiptFor(t.agent,t.nativeMessage(ownerRequest)),null);
    t.agent.session.header={...t.agent.session.header,origin:'subagent',delegationDepth:1};const delegated=t.request();await t.http(delegated);assert.equal((await t.rows()).length,0);
  }finally{await t.close();}
});

test('one HTTP request has one claim and inactive async aliases never create receipts after response settlement or failure',async()=>{
  const t=await setup();try {
    const first=t.request(),second=t.request();await t.physical(async()=>{await t.invoke(first);await t.invoke(second);});assert.equal((await t.rows()).length,1);assert.equal(t.input.receiptFor(t.agent,t.nativeMessage(second)),null);
    let alias;const late=t.request();await t.physical(async()=>{alias=()=>t.invoke(late);});await alias();assert.equal(t.input.receiptFor(t.agent,t.nativeMessage(late)),null);
    const error=Error('TEST ONLY ORIGINAL CONTROLLER ERROR');t.nativeError=error;const rejected=t.request();
    await assert.rejects(t.http(rejected),actual=>actual===error);assert(!t.messages.some(message=>message.source.rpcId===rejected.requestId));
    t.nativeError=null;await t.invoke(rejected);assert.equal(t.input.receiptFor(t.agent,t.nativeMessage(rejected)),null,'an unbound rejected attempt never attributes a later internal message');
    await assert.rejects(t.http(rejected),{code:'HUMAN_INPUT_NATIVE_ID_UNPROVEN'});
    const afterError=t.request();await t.invoke(afterError);assert.equal(t.input.receiptFor(t.agent,t.nativeMessage(afterError)),null);
    // A recorded real HTTP attempt does not create a native message by itself.
    assert.equal((await t.rows()).length,2);
  }finally{await t.close();}
});

test('a suspended resolver cannot create proof after physical next settles or after mutable arguments change',async()=>{
  const t=await setup();try {
    let work;const gate=wait();t.resolveBarrier=gate.promise;const request=t.request();
    await t.physical(async()=>{work=t.invoke(request);});gate.resolve();await work;assert.equal((await t.rows()).length,0);
    const secondGate=wait();t.resolveBarrier=secondGate.promise;const mutable=t.request();
    const sending=t.http(mutable);await Promise.resolve();mutable.content[0].text='TEST ONLY changed through later alias';secondGate.resolve();await sending;assert.equal((await t.rows()).length,0);
  }finally{await t.close();}
});

test('same native request keeps its first time across cold mounting, while changed hash and incarnation fail before admission',async()=>{
  const t=await setup();try {
    const request=t.request(),firstAt=new Date(t.now).toISOString();await t.http(request);t.now+=60000;await t.http(structuredClone(request));
    assert.equal((await t.rows()).length,1);assert.equal(t.input.receiptFor(t.agent,t.nativeMessage(request)).occurredAt,firstAt);
    t.input.dispose();t.mount();assert.equal(t.input.receiptFor(t.agent,t.nativeMessage(request)).occurredAt,firstAt);
    const before=t.calls.length;await assert.rejects(t.http({...request,content:[{type:'text',text:'TEST ONLY mismatched retry'}]}),{code:'HUMAN_INPUT_BODY_CONFLICT'});assert.equal(t.calls.length,before);
    t.agent.session.header={...t.agent.session.header,createdAt:124};assert.equal(t.input.receiptFor(t.agent,t.nativeMessage(request)),null);
    await assert.rejects(t.http(request),{code:'HUMAN_INPUT_SESSION_CONFLICT'});
  }finally{await t.close();}
});

test('receipt requires original user source, full body, exact live Session and header fingerprint, and cannot be copied into a fork',async()=>{
  const t=await setup();try {
    const request=t.request('TEST ONLY full body\nTEST ONLY final tail');await t.http(request);const message=t.nativeMessage(request);
    assert(t.input.receiptFor(t.agent,message));
    for(const candidate of [{...message,id:randomUUID()},{...message,role:'assistant'},{...message,source:{...message.source,kind:'schedule'}},{...message,source:{kind:'user',rpcId:randomUUID()}},{...message,content:[{type:'text',text:'TEST ONLY full body'}]}])assert.equal(t.input.receiptFor(t.agent,candidate),null);
    const fork={...t.agent,id:randomUUID(),inbox:{nextTurn:[],nextStep:[]}};fork.session={...t.agent.session,id:fork.id,header:{...t.agent.session.header,id:fork.id,parentSession:t.agent.id,isSeeded:true}};t.live.set(fork.id,fork);
    assert.equal(t.input.receiptFor(fork,message),null);t.live.delete(t.agent.id);assert.equal(t.input.receiptFor(t.agent,message),null);
  }finally{await t.close();}
});

test('existing unproven native rpcId cannot be retroactively promoted through authenticated replay, including consumed durable inbox history',async()=>{
  const t=await setup();try {
    for(const location of ['events','nextTurn','nextStep','spliced','inserted']) {
      const request=t.request(),message=t.nativeMessage(request);
      if(location==='events')t.events.push({type:'user/message',data:message});
      else if(location==='spliced')t.events.push({type:'agent/inbox/spliced',data:{target:'next-turn',inserted:[message]}});
      else if(location==='inserted')t.events.push({type:'agent/inbox/inserted',data:{message}});
      else t.agent.inbox[location].push(message);
      const before=t.calls.length;await assert.rejects(t.http(request),{code:'HUMAN_INPUT_NATIVE_ID_UNPROVEN'});assert.equal(t.calls.length,before);assert.equal(t.input.receiptFor(t.agent,message),null);
    }
    assert.equal((await t.rows()).length,0);
  }finally{await t.close();}
});

test('consumed authenticated native identity keeps first receipt and explicitly rejects a replay that vendor dedup would assign a different ID',async()=>{
  const t=await setup();try {
    const request=t.request(),firstAt=new Date(t.now).toISOString();await t.http(request);const original=t.messages[0];
    t.events.push({type:'agent/inbox/spliced',data:{target:'next-turn',inserted:[original]}});t.agent.inbox.nextTurn.length=0;t.now+=60000;
    const before=t.calls.length;await assert.rejects(t.http(request),{code:'HUMAN_INPUT_NATIVE_REPLAY_CONFLICT'});assert.equal(t.calls.length,before);assert.equal(t.messages.length,1);
    const row=(await t.rows())[0];assert.equal(row.native_message_id,original.id);assert.equal(row.occurred_at_utc,firstAt);assert(t.input.receiptFor(t.agent,original));
    t.input.dispose();t.mount();await assert.rejects(t.http(request),{code:'HUMAN_INPUT_NATIVE_REPLAY_CONFLICT'});assert.equal((await t.rows())[0].native_message_id,original.id);
  }finally{await t.close();}
});

test('legal attachment requests retain their original admission and entrance refusal semantics without creating human proof',async()=>{
  const t=await setup();try {
    const request=t.request('TEST ONLY text',{content:[{type:'text',text:'TEST ONLY with attachment'},{type:'image',attachment:{id:'TEST ONLY attachment'}}]});await t.http(request);
    assert.equal(t.messages.length,1);assert.equal((await t.rows()).length,0);assert.equal(t.input.receiptFor(t.agent,t.messages[0]),null);
    let forwarded=0;const entrance=createEntrance({receiptFor:t.input.receiptFor,identity:async()=>randomUUID(),hostRequest:async()=>{forwarded++;return {status:200};}});
    await assert.rejects(entrance({agent:t.agent,messages:[t.messages[0]]},async()=>({kind:'enter',messages:t.messages})),/no content was forwarded/u);assert.equal(forwarded,0);
  }finally{await t.close();}
});

test('native refusal leaves an unbound attempt; actual admission before a later error binds only its exact native message identity',async()=>{
  const t=await setup();try {
    const refused=t.request();t.nativeRefusal=true;await t.http(refused);assert.equal(t.messages.length,0);assert.equal((await t.rows())[0].native_message_id,null);
    t.nativeRefusal=false;await t.invoke(refused);assert.equal(t.input.receiptFor(t.agent,t.nativeMessage(refused)),null);
    const partial=t.request();t.onMessage=()=>{throw Error('TEST ONLY AFTER ACTUAL ADMISSION');};await assert.rejects(t.http(partial),/AFTER ACTUAL ADMISSION/u);
    const exact=t.nativeMessage(partial);assert(t.input.receiptFor(t.agent,exact));assert.equal(t.input.receiptFor(t.agent,{...exact,id:randomUUID()}),null);
  }finally{await t.close();}
});

test('external store edits are rejected by CAS, successful atomic files hold no body, and disposal preserves a later wrapper',async()=>{
  const t=await setup();try {
    await t.http(t.request());const path=resolve(t.root,'human-input-receipts.json');assert.deepEqual(await readdir(t.root),['human-input-receipts.json']);
    await writeFile(path,(await readFile(path,'utf8'))+'\n');const before=t.calls.length;await assert.rejects(t.http(t.request()),{code:'HUMAN_INPUT_STORE_STALE'});assert.equal(t.calls.length,before);
    const current=Object.getOwnPropertyDescriptor(t.ctx.sessionController,'prompt').value;
    function later(request,signal){return Reflect.apply(current,this,arguments);}
    t.ctx.sessionController.prompt=later;t.input.dispose();assert.equal(Object.getOwnPropertyDescriptor(t.ctx.sessionController,'prompt').value,later);
    await t.invoke(t.request());assert.equal(t.calls.length,before+1);
  }finally{await t.close();}
});
