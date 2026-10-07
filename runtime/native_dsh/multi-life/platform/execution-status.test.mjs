import {test} from 'node:test';
import assert from 'node:assert/strict';
import {legacyExecutionStatus,lifeExecutionStatus} from './execution-status.mjs';
test('legacy execution polling touches only synchronous current task state',()=>{
  const ctx=new Proxy({personaTasks:{running:()=>['active']}},{get(target,key){assert.equal(key,'personaTasks');return target[key];}});
  assert.deepEqual(legacyExecutionStatus({ctx,sessionId:'authority',pid:123}),{ready:true,pid:123,sessionId:'authority',busy:true,activeSessionIds:['active']});
  assert.deepEqual(legacyExecutionStatus({ctx:{},sessionId:'authority',pid:123}),{ready:false,pid:123,sessionId:'authority',busy:false,activeSessionIds:[]});
});
test('modern execution polling does not read inbox, schemas, credentials or foundation',()=>{
  const row=status=>new Proxy({agent:{status}},{get(target,key){assert.equal(key,'agent');return target[key];}});
  const sessions=new Map([['authority',row('idle')],['activity',row('running')]]);
  assert.deepEqual(lifeExecutionStatus({sessions,lifeId:'owner',pid:124}),{ready:true,pid:124,life_id:'owner',sessions:[{session_id:'authority',busy:false},{session_id:'activity',busy:true}]});
});
