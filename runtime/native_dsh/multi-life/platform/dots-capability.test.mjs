import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootLifeHost} from '../host.mjs';
import {createOfficialProviderFactory} from './official-provider.mjs';
import {createLifeDotsServices,DOTS_SPECS,mountLifeDots,reviewedBridgeFactory} from './dots-capability.mjs';
const source='.local/workspace/development/plugins/persona-dots';
const {Bridge}=await import(pathToFileURL(resolve(source,'bridge.mjs')));
const {SlackTransport}=await import(pathToFileURL(resolve(source,'slack.mjs')));
const policy={...JSON.parse(await readFile(resolve(source,'policy.json'),'utf8')),pollIntervalSeconds:0};
const request={idempotency_key:'same-key',goal:'Read current official public facts',reason:'Compare primary evidence',output:'One source and one follow-up step',public_context:true};
function context(lifeId,sessionId=lifeId+'-session'){
  return {lifeId,sessionId,callId:'call-'+sessionId,role:'activity',manifest:{displayName:lifeId}};
}
class Transport{
  kind='slack';connection={team_id:'T123456',channel_id:'C123456',dot_user_id:'U123456'};sent=[];pages=[];healthy=true;
  configured(){return true;}
  async health(){return {ready:this.healthy,sending_available:this.healthy,delegated_user_trigger:'tested_no_reply_observed'};}
  async send(t){this.sent.push(t);return {provider:'slack',channel_id:'C123456',thread:'1700000000.000001',message_ts:'1700000000.000001',sender_mode:'delegated_user'};}
  async poll(){return this.pages.shift()??{messages:[],response_metadata:{next_cursor:''}};}
  matches(t){return t.receipt?.channel_id===this.connection.channel_id;}
  accepts(m,t){return m.user===t.dot_user_id&&m.thread_ts===t.thread;}
}
test('independent owner state, trusted attribution, activity read, pagination, follow-up and no replay',async()=>{
  const root=await mkdtemp(resolve(tmpdir(),'v1-dots-')),trusted=new WeakSet(),transports=new Map();
  const a=context('life-a'),b=context('life-b'),second=context('life-a','life-a-next');[a,b,second].forEach(c=>trusted.add(c));
  const contexts={require(c){assert.ok(trusted.has(c));return c;}};
  const services=createLifeDotsServices({contexts,bindings:new Map([['life-a',{stateRoot:resolve(root,'a')}],['life-b',{stateRoot:resolve(root,'b')}]]),
    bridgeFactory:async(c,binding)=>{const transport=new Transport();transports.set(c.lifeId,transport);return new Bridge({path:resolve(binding.stateRoot,'tasks.sqlite3'),policy,transport});}});
  try{
    assert.equal(services.peek(a).loaded,false);
    const qa=await services.execute(a,'delegate_to_dots',request),qb=await services.execute(b,'delegate_to_dots',request);
    assert.notEqual(qa.task_id,qb.task_id);assert.equal(qa.owner_life_id,'life-a');
    assert.equal(transports.get('life-a').sent[0].initiated_by.owner_life_id,'life-a');
    assert.equal(transports.get('life-a').sent[0].initiated_by.session_id,a.sessionId);
    assert.equal((await services.execute(second,'delegate_to_dots',request)).duplicate,true);
    assert.equal(transports.get('life-a').sent.length,1);
    const ownList=await services.execute(second,'dots_task_list',{limit:1});
    assert.equal(ownList.tasks[0].task_id,qa.task_id);assert.equal(ownList.tasks[0].origin_session_id,a.sessionId);
    assert.equal(ownList.next_after,null);assert.equal(ownList.network_request,false);
    assert.equal((await services.execute(b,'dots_task_list',{})).tasks[0].task_id,qb.task_id);
    await assert.rejects(services.execute(b,'read_dots_result',{task_id:qa.task_id}),/DOTS_TASK_NOT_FOUND/);
    await assert.rejects(services.execute(a,'delegate_to_dots',{...request,goal:'changed'}),/IDEMPOTENCY_CONTENT_CONFLICT/);
    const sent=transports.get('life-a').sent[0],message=(phase,ts,text='')=>({user:sent.dot_user_id,thread_ts:sent.thread,text:`[DL_DOTS_${phase} ${sent.id}] ${text}`,ts});
    transports.get('life-a').pages.push({messages:[message('RESULT','1700000002.000001','https://example.org/source full public content')],response_metadata:{next_cursor:'next'}});
    assert.equal((await services.execute(a,'check_dots_task',{task_id:qa.task_id})).status,'running');
    transports.get('life-a').pages.push({messages:[message('DONE','1700000003.000001')],response_metadata:{next_cursor:''}});
    assert.equal((await services.execute(a,'check_dots_task',{task_id:qa.task_id})).status,'completed');
    const page=await services.execute(second,'read_dots_result',{task_id:qa.task_id,limit:10});
    assert.ok(page.next_offset);assert.equal(page.available,true);assert.equal(page.owner_life_id,'life-a');
    await assert.rejects(services.execute(second,'read_dots_result',{task_id:qa.task_id,offset:page.next_offset}),/RESULT_VERSION_REQUIRED/);
    const rest=await services.execute(second,'read_dots_result',{task_id:qa.task_id,offset:page.next_offset,result_version:page.result_version});
    assert.equal(rest.next_offset,null);
    const history=await services.execute(second,'dots_task_history',{task_id:qa.task_id});
    assert.equal(history.events.findLast(e=>e.kind==='result_read').value.reader.session_id,second.sessionId);
    const health=await services.status(second);assert.equal(health.delegated_user_trigger,'verified_reply_observed');
    assert.equal(health.automatic_trigger,'unverified');assert.equal(health.latest_own_task.task_id,qa.task_id);
    assert.equal(services.peek(second).available,true);
    const follow=await services.execute(second,'continue_dots_task',{...request,idempotency_key:'follow',task_id:qa.task_id});
    assert.equal(follow.parent_task_id,qa.task_id);assert.equal(follow.receipt.thread,qa.receipt.thread);
  }finally{await services.dispose();await rm(root,{recursive:true,force:true});}
});
test('official Adapter keeps Dot schemas and historical message prefix stable on successive requests',async()=>{
  const fixture=await createFixture(['DOT-WIRE']),registry=new LifeRegistry({root:fixture.registryRoot,mode:'fixture'}),wire=[];let host;
  try{
    const manifest=fixture.manifests[0];manifest.deployment.provider='deepseek-official';manifest.deployment.model='deepseek-flash';
    manifest.deployment.maxTokens=256;registry.register(manifest);
    host=await bootLifeHost({registry,root:fixture.nativeRoot,fixtureRoot:fixture.root,providerRoutes:['deepseek-official'],memoryBindings:new Map(),ownerBindings:new Map(),
      admit:async()=>({allowed:true}),extensions:[host=>mountLifeDots(host,{bindings:new Map(),bridgeFactory:async()=>{throw Error('no Slack access in wire fixture');}})],
      budgetConfig:{accounts:new Map([['TEST-account',{dailyLimitNanoCny:50000000000,stopOnUnknownUsage:true}]]),lifeAccounts:new Map([[manifest.lifeId,{accountRef:'TEST-account'}]])},
      providerFactory:createOfficialProviderFactory({credentialForAccount:async()=>'TEST-ONLY-DOT-WIRE-KEY-1234567890'}),
      rawModelTransport:async(_url,init)=>{
        wire.push(JSON.parse(init.body));
        return new Response([
          {type:'message_start',message:{id:randomUUID(),role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:100,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
          {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
          {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'TEST ONLY'}},{type:'content_block_stop',index:0},
          {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}
        ].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
      }});
    const agent=await host.runtime.create({lifeId:manifest.lifeId,sessionId:manifest.authoritySessionId,role:'authority'});
    for(let i=0;i<2;i++){
      await host.runtime.prompt({lifeId:manifest.lifeId,sessionId:agent.session.id,requestId:randomUUID(),content:[{type:'text',text:'TEST ONLY DOT WIRE '+i}]});await agent.whenIdle();
      assert.equal([...agent.session.ownEvents()].findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
    }
    assert.equal(wire.length,2);assert.equal(wire[0].system,wire[1].system);assert.match(wire[0].system,/TEST ONLY CORE DOT-WIRE/);
    assert.deepEqual(wire[0].tools,wire[1].tools);assert(wire[0].tools.some(t=>t.name==='dots_task_list'));
    assert.deepEqual(wire[0].messages,wire[1].messages.slice(0,wire[0].messages.length));
  }finally{if(host)await host.ctx.fiber.dispose();registry.close();await fixture.cleanup();}
});
test('malformed Dot arguments fail before state, credentials or network; unknown task is distinct',async()=>{
  const c=context('life-validation');let opens=0;
  const services=createLifeDotsServices({contexts:{require:x=>x},bindings:new Map([[c.lifeId,{}]]),bridgeFactory:async()=>{opens++;throw Error('must not open');}});
  try{
    for(const [name,args] of [['dots_task_history',{}],['check_dots_task',{task_id:'dot-'}],['dots_status',{lifeId:'other'}],
      ['dots_task_list',{limit:0}],['dots_task_list',{after:-1}],['dots_task_list',{limit:1.5}],
      ['read_dots_result',{task_id:'dot-b96b9ef3-2431-520e-b9d3-e1a1b820c5b1',offset:-1}],['delegate_to_dots',{...request,public_context:false}]])
      await assert.rejects(services.execute(c,name,args),/DOTS_ARGUMENTS_INVALID/);
    assert.equal(opens,0);
  }finally{await services.dispose();}
});
test('snapshot changes after actual status failure; no model or network on peek',async()=>{
  const root=await mkdtemp(resolve(tmpdir(),'v1-dots-status-')),c=context('life-one'),transport=new Transport();let now=0;
  const services=createLifeDotsServices({contexts:{require:()=>c},bindings:new Map([[c.lifeId,{stateRoot:root}]]),now:()=>now,statusTtlMs:100,
    bridgeFactory:async()=>new Bridge({path:resolve(root,'tasks.sqlite3'),policy,transport})});
  try{
    await services.status(c);assert.equal(services.peek(c).available,true);
    transport.healthy=false;await services.status(c);assert.equal(services.peek(c).available,false);assert.equal(services.peek(c).health,'unavailable');
    now=101;assert.equal(services.peek(c).health,'unknown');assert.equal(services.peek(c).health_stale,true);
  }finally{await services.dispose();await rm(root,{recursive:true,force:true});}
});
test('native mount registers actual schemas and rejects a delegate before opening state',async()=>{
  const c={...context('life-one'),role:'delegate'},definitions=[];let opens=0;
  const host={contexts:{require:c=>c,execution:()=>c,registry:{addControlRoot(){}}},ctx:{tools:{register:d=>{definitions.push(d);return()=>{};}},effect(){}}};
  const services=await mountLifeDots(host,{bindings:new Map([[c.lifeId,{stateRoot:'fixture-only'}]]),bridgeFactory:async()=>{opens++;throw Error('should not open');}});
  assert.deepEqual(definitions.map(d=>d.name),DOTS_SPECS.map(s=>s[0]));
  assert.equal(definitions.some(d=>d.parameters.properties.lifeId),false);
  const result=await definitions.find(d=>d.name==='delegate_to_dots').execute(request,{agent:{},callId:'test'});
  assert.equal(result.code,'DOTS_OWNER_REQUIRED');assert.equal(opens,0);await services.dispose();
});
test('Slack sender message names trusted requesting life, retains native client ID and API-only send',async()=>{
  const tr=new SlackTransport({sender_mode:'delegated_user',sender_user_id:'U123456',team_id:'T123456',channel_id:'C123456',dot_user_id:'U654321',ui_sending_enabled:false},{resolve:()=>{throw Error('fixture override only');}});
  let sent;
  tr.api=async(method,input)=>method==='auth.test'?{team_id:'T123456',user_id:'U123456'}:(sent=input,{channel:'C123456',ts:'1700000000.123456',message:{user:'U123456'}});
  try{
    const id='dot-b96b9ef3-2431-520e-b9d3-e1a1b820c5b1';await tr.send({id,initiated_by:{owner_life_id:'life-new',display_name:'New Life'}},'public body');
    assert.match(sent.text,/New Life经用户授权/);assert.doesNotMatch(sent.text,/人格经用户授权/);assert.equal(sent.client_msg_id,id.slice(4));
  }finally{await tr.close();}
});
test('reviewed factory routes credentials under the current Session context and rejects UI config',async()=>{
  const root=await mkdtemp(resolve(tmpdir(),'v1-dots-creds-')),first=context('life-one','first'),second=context('life-one','second'),seen=[];
  const connection={transport:'slack',team_id:'T123456',channel_id:'C123456',dot_user_id:'U123456',sender_user_id:'U654321',sender_mode:'delegated_user',ui_sending_enabled:false};
  await writeFile(resolve(root,'connection.json'),JSON.stringify(connection));
  const factory=await reviewedBridgeFactory({sourceRoot:source,credentialBackend:(c,_b,ref)=>{seen.push({sessionId:c.sessionId,ref});return {value:'synthetic-test-token'};},
    transportOptions:{proxy:null,fetchImpl:async(url,options)=>{
      const method=new URL(url).pathname.split('/').at(-1),isUser=options.headers.authorization==='Bearer synthetic-test-token';
      const data=method==='auth.test'?{team_id:'T123456',user_id:'U654321'}:method==='conversations.info'?{channel:{id:'C123456',is_private:true,is_member:true}}:{members:['U123456']};
      assert.equal(isUser,true);return new Response(JSON.stringify({ok:true,...data}));
    }}});
  const contexts={require(c){assert.ok(c===first||c===second);return c;}};
  const services=createLifeDotsServices({contexts,bindings:new Map([[first.lifeId,{stateRoot:resolve(root,'state'),connectionRoot:root}]]),bridgeFactory:factory});
  try{
    assert.equal((await services.status(first)).ready,true);const count=seen.length;
    assert.equal((await services.status(second)).ready,true);assert.ok(seen.slice(count).every(c=>c.sessionId==='second'));
    await writeFile(resolve(root,'connection.json'),JSON.stringify({...connection,sender_mode:'delegated_ui'}));
    await assert.rejects(factory(first,{stateRoot:resolve(root,'bad'),connectionRoot:root}),/DOTS_API_ONLY_CONNECTION_REQUIRED/);
  }finally{await services.dispose();await rm(root,{recursive:true,force:true});}
});
