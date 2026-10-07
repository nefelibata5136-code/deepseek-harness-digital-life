import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationStorage} from './conversation-storage.mjs';

test('Room and input commit together; old bytes are preserved and reopen uses the current SQLite receipt',()=>{
  const root=mkdtempSync(join(tmpdir(),'room-truth-')),old={schemaVersion:2,rooms:{A:{messages:[]}},inbox:{I:{status:'needs_review'}},humans:{},nextInboxSeq:2,nextMessageSeq:1};
  const bytes=JSON.stringify(old)+'\n';writeFileSync(join(root,'rooms.json'),bytes);let store;
  try{
    store=new ConversationStorage({root,migrate:state=>({state:{...state,schemaVersion:3,inbox:{I:{status:'pending'}}}})});
    const next=structuredClone(store.state);next.rooms.A.messages.push({messageId:'effect-1'});next.inbox.I.reply_message_id='effect-1';store.commit(next);store.close();
    assert.equal(readFileSync(join(root,'rooms.json'),'utf8'),bytes);
    // Changing an archived import cannot override current durable state.
    writeFileSync(join(root,'rooms.json'),JSON.stringify(old));store=new ConversationStorage({root});
    assert.equal(store.state.rooms.A.messages[0].messageId,'effect-1');assert.equal(store.state.inbox.I.status,'pending');assert.equal(store.state.inbox.I.reply_message_id,'effect-1');
  }finally{store?.close();rmSync(root,{recursive:true,force:true});}
});

test('stale writer cannot erase a committed Room message or input',()=>{
  const root=mkdtempSync(join(tmpdir(),'room-truth-'));let first,second;
  try{first=new ConversationStorage({root});second=new ConversationStorage({root});first.commit({...first.state,nextMessageSeq:2});assert.throws(()=>second.commit(second.state),/CONVERSATION_WRITER_STALE/);}
  finally{first?.close();second?.close();rmSync(root,{recursive:true,force:true});}
});

test('failed migration preserves input bytes and can be retried without swallowing records',()=>{
  const root=mkdtempSync(join(tmpdir(),'room-truth-')),bytes=JSON.stringify({schemaVersion:2,inbox:{real:{status:'failed'}},rooms:{}});let store;
  try{writeFileSync(join(root,'rooms.json'),bytes);assert.throws(()=>new ConversationStorage({root,migrate:()=>{throw Error('TEST migration stopped');}}),/migration stopped/);assert.equal(readFileSync(join(root,'rooms.json'),'utf8'),bytes);store=new ConversationStorage({root});assert.equal(store.state.inbox.real.status,'failed');}
  finally{store?.close();rmSync(root,{recursive:true,force:true});}
});
