import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactThinking, projectThinkingSnapshot, readThinking} from './thinking.mjs';
import {projectEvents} from './transport.mjs';
import {createDetector} from '../key_output_guard/detector.mjs';
const message = (reasoning, text='FINAL_SENTINEL') => ({content:[{type:'reasoning',text:reasoning},{type:'text',text},
  {type:'tool-call',id:'not-thinking',name:'read',arguments:'TOOL_ARGS_SENTINEL'}]});
const events = [
  {seq:0,type:'turn/start',data:{turn:1}},
  {seq:1,type:'assistant/message',data:{turn:1,message:message('before tool')}},
  {seq:2,type:'tool/call',data:{turn:1,name:'read',callId:'read-1',arguments:'{}'}},
  {seq:3,type:'tool/result',data:{turn:1,message:{toolCallId:'read-1',content:[{type:'text',text:'TOOL_RESULT_SENTINEL'}]}}},
  {seq:4,type:'assistant/message',data:{turn:1,message:message('after tool')}},
];
test('durable thinking survives tools and keeps final text, tool args/results separate',()=>{
  const {rows}=projectEvents(events);
  assert.deepEqual(rows.filter(r=>r.role==='thinking').map(r=>r.text),['before tool','after tool']);
  assert.equal(rows.filter(r=>r.role==='assistant').length,2);
  assert(rows.find(r=>r.role==='tool').result.includes('TOOL_RESULT_SENTINEL'));
});
test('compact real reasoning deltas extend durable reasoning without duplicates',()=>{
  const snapshot={cursor:4,records:events.map(event=>({type:'event',event})),assistantStream:{revision:8,
    activeAttempt:{turn:1,stream:[{type:'reasoning-chunks',texts:['next ','thought ','in ','progress']},
      {type:'text-chunks',texts:['FINAL_STREAM_SENTINEL']},{type:'tool-call-chunks',args:['ARGS']} ]}}};
  const value=projectThinkingSnapshot(snapshot,{running:true});
  assert.equal(value.text,'before tool\n\nafter tool\n\nnext thought in ');
  assert.equal(value.state,'thinking');
  const tools=projectThinkingSnapshot({records:events.slice(0,3).map(event=>({event}))},{running:true});
  assert.equal(tools.state,'tools');
});
test('new turn excludes old reasoning, completed text is exact',()=>{
  const result=projectThinkingSnapshot({records:[...events,{seq:5,type:'turn/start',data:{turn:2}},
    {seq:6,type:'assistant/message',data:{turn:2,message:message('当前原文\n  保留空格。')}}].map(event=>({event}))});
  assert.equal(result.turn,2);assert.equal(result.text,'当前原文\n  保留空格。');
});
test('secret screening across every token cut, including opaque known secrets',()=>{
  for(const secret of ['sk-'+ 'x'.repeat(30),'opaque-known-secret-123456789']) {
    const detector=createDetector([secret]);
    for(let i=1;i<=secret.length;i++) {
      const value=redactThinking('正常原文 '+secret.slice(0,i),{streaming:true,detector});
      assert.equal(value,'正常原文 ');
    }
    assert(!redactThinking('正常原文 '+secret+' 后续',{streaming:true,detector}).includes(secret));
  }
  for(const text of ['Authorization: Bearer synthetic-token','Cookie: sid=synthetic; second=value',
    'api_key = "synthetic"','"token": "synthetic"','Authorization = "synthetic"'])
    assert(!redactThinking(text).includes('synthetic'));
  assert.equal(redactThinking('token 是一个概念。\n保持原文。'),'token 是一个概念。\n保持原文。');
});
test('official snapshot read releases its follower and does not submit/activate a turn',async()=>{
  let returned=false,signal;
  const ctx={personaTasks:{running:()=>[]},sessionController:{follow(request,cancellation){
    assert(request.assistantStream);signal=cancellation;
    return {next:async()=>({value:{type:'snapshot',records:events.map(event=>({event}))}}),
      return:async()=>{returned=true;return {done:true};}};
  }}};
  const result=await readThinking(ctx,'test-session');
  assert.equal(result.text,'before tool\n\nafter tool');assert(returned);assert(signal.aborted);
});
