import {test} from 'node:test';
import assert from 'node:assert/strict';
import {provenanceForAgent,wirePromptMetadata} from './provenance.mjs';
function agent(source){return {session:{id:'TEST-session',ownEvents:()=>[{type:'user/message',data:{source}},{type:'turn/start',data:{turn:3}},{type:'user/message',data:{source:{kind:'life-current-state'}}}]}};}
test('cost reasons come from trusted native sources and preserve one run through tool steps',()=>{
  for(const [source,reason] of [
    [{kind:'room-inbox',rpcId:'TEST-human',sender:{sender_type:'human'}},'human_room'],
    [{kind:'room-inbox-batch',rpcId:'TEST-peer-burst',sender_types:['life','life']},'peer_room'],
    [{kind:'room-inbox-batch',rpcId:'TEST-mixed',sender_types:['human','life']},'other'],
    [{kind:'schedule',rpcId:'TEST-schedule'},'scheduler'],
    [{kind:'user',rpcId:'resident:TEST'},'resident'],
    [{kind:'host-notice',rpcId:'TEST-developer'},'developer_test'],
    [{kind:'user',rpcId:'TEST-unknown'},'other']]) {
    const a=agent(source),row=provenanceForAgent(a,{lifeId:'life-TEST-A'});
    assert.equal(row.reason,reason);assert.equal(row.run_id,'TEST-session:turn:3');assert.equal(row.request_id,source.rpcId);
    assert.equal(row.life_id,'life-TEST-A');assert.equal(provenanceForAgent(a,{lifeId:'life-TEST-A'}).run_id,row.run_id);
  }
  assert.equal(provenanceForAgent(agent({kind:'user',rpcId:'TEST'}),{lifeId:'life-TEST-A',role:'delegate'}).reason,'subagent');
  assert.equal(provenanceForAgent(agent(),{lifeId:'life-TEST-A'}).provenance,'trusted_owner_source_unknown');
});
test('wire fingerprints omit text while exposing stable/dynamic structures and tool reordering',()=>{
  const body={system:'TEST PRIVATE SYSTEM TEXT',tools:[{name:'read',description:'private text'},{name:'write'}],messages:[{role:'user',content:'private first message'}]};
  const first=wirePromptMetadata(body),second=wirePromptMetadata({...body,messages:[...body.messages,{role:'user',content:'later dynamic state'}]});
  assert.equal(first.system_hash,second.system_hash);assert.equal(first.tools_hash,second.tools_hash);assert.equal(first.first_message_hash,second.first_message_hash);
  assert.notEqual(first.tool_order_hash,wirePromptMetadata({...body,tools:[...body.tools].reverse()}).tool_order_hash);
  assert.equal(first.message_count,1);assert(!JSON.stringify(first).includes('PRIVATE'));assert(!JSON.stringify(first).includes('private'));
});
