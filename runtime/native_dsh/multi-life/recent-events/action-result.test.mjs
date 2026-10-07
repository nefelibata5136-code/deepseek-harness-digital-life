import {test} from 'node:test';
import assert from 'node:assert/strict';

test('state without state_key identifies the exact record instead of an opaque ACK failure',()=>{
  assert.throws(()=>parseActionResult(JSON.stringify({status:'ok',disposition:'silent',actions:[],records:[{key:'TEST-state',kind:'state',summary:'TEST ONLY',state:'done'}]})),
    error=>error.code==='TURN_RECORDS_INVALID'&&error.details.field==='records[0].state_key'&&error.message.includes('TEST-state'));
});
import {parseActionResult,isMachineActionResult,looksLikeActionResult,findTurnActionResult} from './action-result.mjs';

const silent={status:'ok',disposition:'silent',actions:[]};
const send={status:'ok',disposition:'acted',actions:[{type:'send_message',conversation_id:'room-target',body:'Explicit cross-room action',reply_to:'message-target'}]};
const encode=JSON.stringify;
const call=(seq=3,args=silent)=>({seq,type:'tool/call',data:{turn:1,step:0,callId:'ack-call',name:'life_turn_ack',arguments:encode(args)}});
const tool=(seq=4,result=silent,extra={})=>({seq,type:'tool/result',sourceEventSeqs:[3],data:{turn:1,step:0,message:{id:'tool-result',role:'tool',source:{kind:'tool',callId:'ack-call'},toolCallId:'ack-call',isError:false,content:[{type:'text',text:encode({acknowledged:true,result,delivery_batch_id:'batch-1'})}]},...extra}});
const assistant=(seq=5,result=silent,extra={})=>({seq,type:'assistant/message',data:{turn:1,step:1,message:{id:'assistant-result',role:'assistant',content:[{type:'reasoning',text:'Private reasoning is never parsed as ACK.'},{type:'text',text:typeof result==='string'?result:encode(result)}]},...extra}});
const end=reason=>({seq:6,type:'turn/end',data:{turn:1,reason:{kind:reason}}});
const invalid=fn=>assert.throws(fn,error=>/^ACTION_RESULT_ACK_/u.test(error.code)&&!error.message.includes('Explicit cross-room'));

test('silent result can retain self-authored facts; records cannot select owner, audience or reasoning',()=>{
 const result=parseActionResult(JSON.stringify({...silent,records:[{key:'finding-1',kind:'finding',summary:'TEST ONLY verified service state',importance:'persistent'}]}));
 assert.equal(result.disposition,'silent');assert.equal(result.actions.length,0);assert.equal(result.records[0].occurred_at_utc,null);
 for(const illegal of [{owner:'other'},{scope:'public'},{reasoning:'private chain'},{visibility:{members:['other']}}])assert.throws(()=>parseActionResult(JSON.stringify({...silent,records:[{key:'finding-1',kind:'finding',summary:'TEST ONLY',...illegal}]})),error=>error.code==='TURN_RECORDS_INVALID');
 assert.throws(()=>parseActionResult(JSON.stringify({...silent,records:[{key:'same',kind:'finding',summary:'A'},{key:'same',kind:'finding',summary:'B'}]})),error=>error.code==='TURN_RECORDS_INVALID');
});

test('all explicit dispositions normalize; the trigger does not bind a send target',()=>{
  assert.deepEqual(parseActionResult(encode(silent)),silent);
  assert.deepEqual(parseActionResult(encode(send)),send);
  const result=parseActionResult(encode({status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:'event-1',until:null},{type:'defer',event_id:'event-2',until:'2026-10-06T04:00:00Z'}]}));
  assert.equal(result.actions[1].until,'2026-10-06T04:00:00.000Z');
  assert(Object.isFrozen(result)&&Object.isFrozen(result.actions)&&result.actions.every(Object.isFrozen));
  assert.deepEqual(parseActionResult(encode({status:'ok',disposition:'acted',actions:[]})),{status:'ok',disposition:'acted',actions:[]});
});
test('semantic completion is optional, explicit, immutable and never inferred from historical send actions',()=>{
  assert.deepEqual(parseActionResult(encode(silent)),silent);
  assert(!Object.hasOwn(parseActionResult(encode(send)),'completed_event_ids'));
  for(const completed_event_ids of [[],['event-1','event-2']]) {
    const expected={...silent,completed_event_ids};
    const actual=parseActionResult(encode(expected));assert.deepEqual(actual,expected);assert(Object.isFrozen(actual.completed_event_ids));
    assert.deepEqual(findTurnActionResult([call(3,expected),tool(4,expected)],{turn:1}).result,expected);
  }
  for(const completed_event_ids of [null,'event-1',[null],[''],[' event-1'],['event-1\n'],['event-1','event-1'],Array.from({length:101},(_,index)=>'event-'+index)])
    invalid(()=>parseActionResult(encode({...silent,completed_event_ids})));
  const deferred={status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:'event-1',until:null}],completed_event_ids:['event-2']};
  assert.deepEqual(parseActionResult(encode(deferred)),deferred);
  assert.throws(()=>parseActionResult(encode({...deferred,completed_event_ids:['event-1']})),error=>error.code==='ACTION_RESULT_ACK_CONFLICT');
  assert.throws(()=>findTurnActionResult([call(),tool(4,{...silent,completed_event_ids:[]})],{turn:1}),error=>error.code==='ACTION_RESULT_ACK_CONFLICT');
});
test('only exact JSON or one exact JSON fence is an ACK',()=>{
  assert.deepEqual(parseActionResult('  ```json\n'+encode(silent)+'\n```\n'),silent);
  assert.deepEqual(parseActionResult('```\n'+encode(silent)+'\n```'),silent);
  for(const text of [undefined,null,'','  ','I decided to stay quiet.','Prefix '+encode(silent),encode(silent)+' trailing','```js\n'+encode(silent)+'\n```'])invalid(()=>parseActionResult(text));
  assert.throws(()=>parseActionResult(''),error=>error.code==='ACTION_RESULT_ACK_MISSING');
});

test('message targets are exactly one actor, public area, or compatible conversation without changing the semantic result',()=>{
  for(const [key,value] of [['to_actor_id','life-target'],['public_area_id','public-area'],['conversation_id','room-target']]) {
    const result={status:'ok',disposition:'acted',actions:[{type:'send_message',[key]:value,body:'TEST ONLY semantic action',reply_to:'message-1'}]};
    assert.deepEqual(parseActionResult(encode(result)),result);
    assert.deepEqual(findTurnActionResult([call(3,result),tool(4,result)],{turn:1}).result,result);
  }
  for(const fields of [{},{to_actor_id:''},{to_actor_id:null},{public_area_id:'  room'},{to_actor_id:'life',conversation_id:'room'},{public_area_id:'public',conversation_id:'room'},{to_actor_id:'life',public_area_id:'public'},{to_actor_id:'life',sender_id:'forged'}])
    invalid(()=>parseActionResult(encode({status:'ok',disposition:'acted',actions:[{type:'send_message',...fields,body:'TEST ONLY invalid target'}]})));
});
test('malformed, unknown, contradictory, and oversized protocol fields never silently succeed',()=>{
  for(const result of [{},[],null,{...silent,status:'failed'},{...silent,disposition:'unknown'},{status:'ok',disposition:'silent'},{...silent,noticed_at:'invented'},{...silent,actions:send.actions},{...send,actions:[{...send.actions[0],sender_id:'forged'}]},{...send,actions:[{...send.actions[0],body:' '}]}])invalid(()=>parseActionResult(encode(result)));
  for(const text of ['{"status":"failed","status":"ok","disposition":"silent","actions":[]}','{"status":"ok","disposition":"silent","actions":[],}'])invalid(()=>parseActionResult(text));
  invalid(()=>parseActionResult(encode({...send,actions:[{...send.actions[0],body:'x'.repeat(1024*1024+1)}]})));
});
test('defer validates complete real UTC dates and leaves future-time policy to the Host clock',()=>{
  for(const until of [undefined,'2026-10-06T12:00:00+08:00','2026-02-30T12:00:00.000Z','2026-10-06','soon',0])invalid(()=>parseActionResult(encode({status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:'event-1',until}]})));
  assert.equal(parseActionResult(encode({status:'ok',disposition:'deferred',actions:[{type:'defer',event_id:'event-1',until:'2020-01-01T00:00:00Z'}]})).actions[0].until,'2020-01-01T00:00:00.000Z');
});
test('publication recognizer suppresses invalid protocol without calling absence silence',()=>{
  assert(isMachineActionResult(encode(silent)));assert(!isMachineActionResult(''));assert(!isMachineActionResult('{"status":"failed","disposition":"silent"}'));
  assert(looksLikeActionResult('{"status":"ok","disposition":"silent",broken'));assert(looksLikeActionResult('status: ok\ndisposition: silent'));
  assert(!looksLikeActionResult('Hello, Maintainer.'));assert(!looksLikeActionResult(null));
});
test('final assistant ACK excludes reasoning and must be the last complete assistant message',()=>{
  const found=findTurnActionResult([assistant(),end('completed')],{turn:1});assert.deepEqual(found.result,silent);assert.equal(found.source,'assistant');assert.equal(found.machine_ack,true);
  assert.equal(findTurnActionResult([assistant(3),assistant(5,'Ordinary final speech.')],{turn:1}),null);
  assert.equal(findTurnActionResult([assistant(5,silent,{interrupted:true})],{turn:1}),null);
  const reasoning=assistant();reasoning.data.message.content=[{type:'reasoning',text:encode(silent)}];assert.equal(findTurnActionResult([reasoning],{turn:1}),null);
});
test('a durable successful named tool result is matched to the exact preceding native call',()=>{
  const found=findTurnActionResult([call(),tool(),end('completed')],{turn:1,startSeq:1,endSeq:6});assert.equal(found.source,'tool');assert.equal(found.call_id,'ack-call');assert.deepEqual(found.result,silent);
  assert.equal(findTurnActionResult([call()],{turn:1}),null);assert.equal(findTurnActionResult([tool()],{turn:1}),null);
  for(const mutate of [event=>event.data.message.source.callId='other',event=>event.data.message.toolCallId='other',event=>event.data.step=2,event=>event.sourceEventSeqs=[2],event=>event.data.message.isError=true,event=>event.data.error={code:'FAILURE'},event=>event.data.turn=2]){
    const event=tool();mutate(event);assert.equal(findTurnActionResult([call(),event],{turn:1}),null);
  }
});
test('successful ACK must end execution, including matching later ACKs, while native metadata stays valid',()=>{
  const metadata=['step/end','turn/end','session/checkpoint','checkpoint','user/message'].map((type,index)=>({seq:5+index,type,data:{turn:1,source:{kind:'author-pressure-checkpoint'}}}));
  assert.equal(findTurnActionResult([call(),tool(),...metadata],{turn:1}).source,'tool');
  for(const suffix of [assistant(),assistant(5,'TEST ONLY later speech'),
    {seq:5,type:'assistant/attempt',data:{turn:1,step:1}},
    {seq:5,type:'tool/call',data:{turn:1,step:1,callId:'later',name:'read',arguments:'{}'}},
    {seq:5,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',isError:true}}}]) {
    assert.throws(()=>findTurnActionResult([call(),tool(),suffix,end('completed')],{turn:1}),error=>error.code==='ACTION_RESULT_ACK_NOT_TERMINAL');
    const other=structuredClone(suffix);other.data.turn=2;
    assert.equal(findTurnActionResult([call(),tool(),other],{turn:1}).source,'tool');
  }
  const repeatedCall=call(5),repeatedResult=tool(6);
  repeatedCall.data.callId='second-ack';repeatedCall.data.step=1;
  repeatedResult.data.step=1;repeatedResult.data.message.source.callId='second-ack';repeatedResult.data.message.toolCallId='second-ack';repeatedResult.sourceEventSeqs=[5];
  assert.throws(()=>findTurnActionResult([call(),tool(),repeatedCall,repeatedResult],{turn:1}),error=>error.code==='ACTION_RESULT_ACK_NOT_TERMINAL');
  const extraTool={seq:6,type:'tool/call',data:{turn:1,step:1,name:'read',callId:'later',arguments:'{}'}};
  assert.throws(()=>findTurnActionResult([assistant(),extraTool],{turn:1}),error=>error.code==='ACTION_RESULT_ACK_NOT_TERMINAL');
});
test('a rejected earlier ACK does not prevent the final successful ACK from completing the same turn',()=>{
  const rejected=tool(4,silent,{error:{code:'ACTION_RESULT_ACK_PENDING_CONTEXT'}});rejected.data.message.isError=true;
  const finalCall=call(6),finalResult=tool(7);finalCall.data.callId='final-ack';finalCall.data.step=1;
  finalResult.data.step=1;finalResult.data.message.source.callId='final-ack';finalResult.data.message.toolCallId='final-ack';finalResult.sourceEventSeqs=[6];
  const ended=end('completed');ended.seq=8;
  const found=findTurnActionResult([call(),rejected,assistant(5,'TEST ONLY internal continuation'),finalCall,finalResult,ended],{turn:1});
  assert.equal(found.call_id,'final-ack');assert.equal(found.event_seq,7);
});
test('ACK candidates never convert overall turn errors or interruptions into success',()=>{
  for(const reason of ['error','aborted','interrupted']){
    const events=[call(),tool(),end(reason)],candidate=findTurnActionResult(events,{turn:1});assert(candidate&&candidate.machine_ack);assert.equal(events.at(-1).data.reason.kind,reason);
  }
  assert.equal(findTurnActionResult([call(),tool()],{turn:1,endSeq:3}),null);
});
test('tool result corruption, argument mismatch, or conflicting ACKs fail safely',()=>{
  const malformed=tool();malformed.data.message.content[0].text='bad json';invalid(()=>findTurnActionResult([call(),malformed],{turn:1}));
  const unacknowledged=tool();unacknowledged.data.message.content[0].text=encode({acknowledged:false,result:silent});invalid(()=>findTurnActionResult([call(),unacknowledged],{turn:1}));
  assert.throws(()=>findTurnActionResult([call(),tool(4,send)],{turn:1}),error=>error.code==='ACTION_RESULT_ACK_CONFLICT');
  assert.throws(()=>findTurnActionResult([call(),tool(),assistant(5,send)],{turn:1}),error=>error.code==='ACTION_RESULT_ACK_CONFLICT');
  const invalidFinal=assistant(5,'{"status":"ok","disposition":"silent",broken');invalid(()=>findTurnActionResult([invalidFinal],{turn:1}));
});
test('other turns and tool-call assistant messages are never final ACKs',()=>{
  const different=assistant();different.data.turn=2;assert.equal(findTurnActionResult([different],{turn:1}),null);
  const pending=assistant();pending.data.message.content.push({type:'tool-call',id:'later',name:'read',arguments:'{}'});assert.equal(findTurnActionResult([pending],{turn:1}),null);
  const duplicate=call(4);assert.throws(()=>findTurnActionResult([call(),duplicate],{turn:1}),error=>error.code==='ACTION_RESULT_ACK_AMBIGUOUS');
});
