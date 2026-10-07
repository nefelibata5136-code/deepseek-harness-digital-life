import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationStorage,readConversationSnapshot} from '../../native_dsh/multi-life/platform/conversation-storage.mjs';
import {executionRoomTurns} from './execution.mjs';
test('presentation reads the current SQLite transaction while immutable import JSON remains stale',()=>{
 const root=mkdtempSync(join(tmpdir(),'social-view-storage-'));let writer;
 try{writeFileSync(join(root,'rooms.json'),JSON.stringify({rooms:{old:{}}}));writer=new ConversationStorage({root});
  writer.commit({rooms:{current:{sessionBindings:{life:'native-session'}}}});
  const before=writer.revision,view=readConversationSnapshot(root);
  assert.deepEqual(view.state.rooms.current.sessionBindings,{life:'native-session'});assert.equal(view.revision,before);assert.equal(writer.revision,before);
 }finally{writer?.close();rmSync(root,{recursive:true,force:true});}
});
test('semantic speech is associated by trusted native call receipt, and admission stays with its independent session',()=>{
 const messages=[{senderPrincipalId:'life',originSessionId:'activity',messageId:'native-send:life:activity:send',conversationId:'private-chat'}];
 const events=[{type:'agent/inbox/spliced',data:{inserted:[{source:{inboxIds:['input']}}]}},{type:'turn/start',data:{turn:1}},{type:'tool/call',data:{name:'life_send_message',callId:'send',turn:1,arguments:JSON.stringify({to:'用户',visibility:'private',body:'test'})}}];
 const scope={lifeId:'life',sessionId:'activity',inbox:{input:{owner_life_id:'life',room_id:'public-chat'}},messages};
 assert.deepEqual([...executionRoomTurns(events,scope).get(1)],['public-chat','private-chat']);
 assert.deepEqual([...executionRoomTurns(events,{...scope,admittedOnly:true}).get(1)],['public-chat']);
 assert.deepEqual([...executionRoomTurns(events,{...scope,sessionId:'wrong-session'}).get(1)],['public-chat']);
});
