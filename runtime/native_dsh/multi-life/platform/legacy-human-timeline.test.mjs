import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {Conversations} from './conversations.mjs';
import {mountLegacyHumanTimeline} from './legacy-human-timeline.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
async function setup() {
  const root=mkdtempSync(resolve(tmpdir(),'human-ingress-truth-unit-'));
  const lifeId='life-'+randomUUID(),authoritySessionId=randomUUID(),life={lifeId,authoritySessionId,displayName:'TEST OWNER'};
  const contexts={registry:{life(id){if(id!==lifeId)throw Error('UNKNOWN_LIFE');return life;},assertTarget(id,sessionId){this.life(id);if(sessionId!==authoritySessionId)throw Error('OWNER_MISMATCH');return {lifeId:id,sessionId,role:'authority',status:'ready'};}}};
  const rooms=new Conversations({contexts,root:resolve(root,'rooms')});rooms.registerHuman({sender_id:'human:maintainer',display_name:'TEST HUMAN'});
  const room=rooms.defineRoom({participants:['human:maintainer',lifeId]});
  const events=[],listeners=new Map(),calls={human:0,own:0,native:0,readback:0};let clock=Date.parse('2026-10-07T04:00:00Z'),available=true;
  const forbidden=()=>{calls.native++;throw Error('TEST ONLY native prompt/wake/creation forbidden in timeline');};
  const session={id:authoritySessionId,header:{id:authoritySessionId,cwd:root,createdAt:1,agentPreset:'TEST'},ownEvents:()=>events.values(),append:forbidden};
  const agent={session,prompt:forbidden,wake:forbidden};
  const ctx={agents:{get:id=>id===authoritySessionId?agent:undefined,create:forbidden,resume:forbidden},sessionController:{prompt:forbidden},sessions:{flush:forbidden},
    on(name,fn){const group=listeners.get(name)??new Set();group.add(fn);listeners.set(name,group);return()=>group.delete(fn);}};
  const bridge={status:()=>({life_id:lifeId,registered_session_id:authoritySessionId}),async postHuman({args,occurredAt}) {
    calls.human++;if(!available)throw Object.assign(Error('TEST offline'),{code:'WORKER_NOT_READY'});
    return rooms.recordHumanTimeline({principalId:'human:maintainer',lifeId,sessionId:authoritySessionId,requestId:args.message_id,args,occurredAt});
  },async postOwn(){calls.own++;throw Error('TEST ONLY automatic Room speech forbidden');},async actionResult(args){calls.readback++;return rooms.actionResultForLife({lifeId,sessionId:authoritySessionId,...args});}};
  const options={ctx,bridge,lifeId,authoritySessionId,roomId:room.room_id,root:resolve(root,'private-ingress')};
  let journal=await mountLegacyHumanTimeline(options);
  const t={root,rooms,lifeId,authoritySessionId,room,events,session,ctx,bridge,calls,options,get journal(){return journal;},setAvailable:value=>available=value,
    async remount(extra={}){journal.dispose();journal=await mountLegacyHumanTimeline({...options,...extra});return journal;},
    async emit(type,data,owner=session){const event={type,data,seq:events.length,time:clock++};if(owner===session)events.push(event);for(const fn of listeners.get('session/event')??[])assert.equal(fn(owner,event),undefined);return event;},
    user(id,text){return t.emit('user/message',createUserMessage({content:[{type:'text',text}],source:{kind:'user',rpcId:id}}));},
    output(turn){const data={turn,step:1};Object.defineProperty(data,'message',{get(){throw Error('TEST native output body must never be read');}});return t.emit('assistant/message',data);},
    rows(){return rooms.inboxForLife({lifeId,includeTerminal:true}).items;},
    snapshot(){return JSON.parse(readFileSync(resolve(options.root,'human-timeline.json'),'utf8'));},
    async seedLegacyReply({requestId,text='TEST historical reply',centralState='pending',messageId='legacy-reply:TEST:1'}) {
      journal.dispose();const source=t.snapshot();source.turns['1']={turn:1,origin_request_ids:[requestId],occurred_at:'2026-10-07T04:00:00.000Z',native_end_seq:5,error_code:null,central_state:centralState,
        message_id:messageId,reply_to:requestId,text,native_assistant_seq:4};writeFileSync(resolve(options.root,'human-timeline.json'),JSON.stringify(source));await t.remount();
    },close(){journal.dispose();rooms.close();rmSync(root,{recursive:true,force:true});}
  };return t;
}

test('authenticated ingress saves pending before one native admission; assistant text never posts Room speech',async()=>{
  const t=await setup();try {
    const requestId=randomUUID(),text='TEST real human input';let originalNativeAdmissions=0;
    const receipt=await t.journal.recordHumanTurn({requestId,text,occurredAt:'2026-10-07T03:59:00.000Z'});
    assert.equal(receipt.central_state,'saved');assert.equal(t.rows().length,1);assert.equal(t.rows()[0].status,'pending');assert.equal(t.rows()[0].attempt,null);
    assert.deepEqual(t.rows()[0].native_ingress,{session_id:t.authoritySessionId,request_id:requestId});assert.equal(t.rooms.deliveryCandidates({lifeId:t.lifeId}).length,0);
    // Original Host admission is outside this journal. Neither timeline nor
    // controller performs another native admission after this durable save.
    originalNativeAdmissions++;await t.emit('turn/start',{turn:1});await t.user(requestId,text);await t.output(1);await t.emit('turn/end',{turn:1,reason:{kind:'completed'}});await t.journal.drain();
    await t.journal.recordHumanTurn({requestId,text});await t.journal.drain();
    assert.equal(originalNativeAdmissions,1);assert.equal(t.calls.human,1);assert.equal(t.calls.native,0);assert.equal(t.calls.own,0);
    assert.equal(t.rooms.timelineForPrincipal(t.lifeId).messages.length,1);assert.equal(t.rows()[0].status,'pending');
    const row=t.snapshot().turns['1'];assert.equal(row.suppression_code,'NATIVE_TEXT_IS_NOT_ROOM_SEND');assert(!Object.hasOwn(row,'text'));
    assert.equal(t.journal.status().automatic_room_reply,false);assert.equal(t.snapshot().requests[requestId].native_turn,1);
  }finally{t.close();}
});

test('Room-save-before-native-admission crash remains pending after reload and next genuine wake',async()=>{
  const t=await setup();try {
    const requestId=randomUUID(),text='TEST crash after Room save';await t.journal.recordHumanTurn({requestId,text});const original=t.rows()[0];
    assert.equal(t.events.length,0);await t.remount();await t.journal.drain();
    const after=t.rooms.recentInboxItems(t.lifeId,t.authoritySessionId).find(item=>item.message_id===requestId);
    assert.equal(after.inbox_id,original.inbox_id);assert.equal(after.status,'pending');assert.equal(after.attempt,null);assert.equal(t.rooms.deliveryCandidates({lifeId:t.lifeId}).length,0);
    await t.emit('turn/start',{turn:2});await t.emit('user/message',createUserMessage({content:[{type:'text',text:'TEST unrelated genuine wake'}],source:{kind:'schedule',rpcId:'TEST next wake'}}));
    assert(t.rooms.recentInboxItems(t.lifeId,t.authoritySessionId).some(item=>item.inbox_id===original.inbox_id&&item.status==='pending'));
    assert.equal(t.calls.native,0);assert.equal(t.calls.own,0);assert.equal(t.calls.human,1);
  }finally{t.close();}
});

test('failed Room persistence blocks original native admission and preserves the authenticated input for retry',async()=>{
  const t=await setup();try {
    const requestId=randomUUID();let nativeAdmissions=0;t.setAvailable(false);
    const admit=async()=>{await t.journal.recordHumanTurn({requestId,text:'TEST offline input'});nativeAdmissions++;};
    await assert.rejects(admit(),/WORKER_NOT_READY/);assert.equal(nativeAdmissions,0);assert.equal(t.rows().length,0);assert.equal(t.journal.status().human_pending,1);
    t.setAvailable(true);await admit();await t.journal.recordHumanTurn({requestId,text:'TEST offline input'});
    assert.equal(nativeAdmissions,1);assert.equal(t.rows().length,1);assert.equal(t.rooms.timelineForPrincipal(t.lifeId).messages.length,1);assert.equal(t.journal.status().human_pending,0);
    assert.equal(t.calls.native,0);assert.equal(t.calls.own,0);
  }finally{t.close();}
});

test('old final reply intent recognizes a durable receipt without republishing or completing its input',async()=>{
  const t=await setup();try {
    const requestId=randomUUID();await t.journal.recordHumanTurn({requestId,text:'TEST old human input'});
    const actual=t.rooms.postForLife({lifeId:t.lifeId,sessionId:t.authoritySessionId,args:{room_id:t.room.room_id,reply_to:requestId,body:'TEST historical reply'}});
    await t.seedLegacyReply({requestId});await t.journal.drain();
    const row=t.snapshot().turns['1'];assert.equal(row.central_state,'saved');assert.equal(row.message_id,'legacy-reply:TEST:1');assert.equal(row.effect_result.status,'confirmed_success');assert.equal(row.effect_result.message_id,actual.message_id);
    assert.equal(t.journal.status().health_notices.length,0);assert.equal(t.calls.own,0);assert.equal(t.calls.native,0);assert.equal(t.rooms.timelineForPrincipal(t.lifeId).messages.length,2);assert.equal(t.rows()[0].status,'pending');
    await t.remount();await t.journal.drain();assert.equal(t.rooms.timelineForPrincipal(t.lifeId).messages.length,2);assert.equal(t.calls.own,0);
  }finally{t.close();}
});

test('old missing or conflicting final reply stays unknown with metadata notice and no automatic resend',async()=>{
  const t=await setup();try {
    const requestId=randomUUID();await t.journal.recordHumanTurn({requestId,text:'TEST old input'});await t.seedLegacyReply({requestId});await t.journal.drain();
    let row=t.snapshot().turns['1'];assert.equal(row.central_state,'pending');assert.equal(row.effect_result.status,'unknown');assert.equal(t.calls.own,0);
    const notice=t.journal.status().health_notices[0];assert.equal(notice.code,'LEGACY_REPLY_EFFECT_UNKNOWN');assert(!Object.hasOwn(notice,'body'));assert(!Object.hasOwn(notice,'text'));
    t.rooms.postForLife({lifeId:t.lifeId,sessionId:t.authoritySessionId,args:{room_id:t.room.room_id,reply_to:requestId,body:'TEST different historical effect'}});
    await t.journal.drain();row=t.snapshot().turns['1'];assert.equal(row.effect_result.status,'unknown');assert.equal(t.calls.own,0);assert.equal(t.journal.status().health_notices.length,1);
  }finally{t.close();}
});

test('previous saved status cannot replace actual existence when readonly bridge is unavailable',async()=>{
  const t=await setup();try {
    const requestId=randomUUID();await t.journal.recordHumanTurn({requestId,text:'TEST old saved input'});
    await t.seedLegacyReply({requestId,centralState:'saved'});await t.remount({bridge:{postHuman:t.bridge.postHuman,status:t.bridge.status}});await t.journal.drain();
    const row=t.snapshot().turns['1'];assert.equal(row.central_state,'saved');assert.equal(row.effect_result.status,'unknown');assert.equal(t.journal.status().health_notices[0].result,'unknown');assert.equal(t.calls.own,0);
  }finally{t.close();}
});

test('screened provenance and occurrence time survive replay; Session incarnation still guards the journal',async()=>{
  const t=await setup();try {
    await t.remount({sanitizeText:text=>text.replace('TEST RAW CANARY','TEST SCREENED')});
    const requestId=randomUUID(),occurredAt='2026-10-06T17:00:00.123Z';await t.journal.recordHumanTurn({requestId,text:'TEST RAW CANARY',occurredAt});
    const saved=t.snapshot().requests[requestId];assert.equal(saved.input_hash,digest('TEST RAW CANARY'));assert.equal(saved.text,'TEST SCREENED');assert.equal(saved.occurred_at,occurredAt);
    assert.equal(t.rooms.timelineForPrincipal(t.lifeId).messages[0].timestamp,occurredAt);await t.journal.recordHumanTurn({requestId,text:'TEST RAW CANARY',occurredAt:'2026-10-07T04:00:00.000Z'});assert.equal(t.snapshot().requests[requestId].occurred_at,occurredAt);
    await assert.rejects(t.journal.recordHumanTurn({requestId,text:'TEST conflicting human content'}),/HUMAN_REQUEST_ID_CONFLICT/);
    await t.emit('turn/start',{turn:1});const oldHeader=t.session.header.createdAt;t.session.header.createdAt=99;await t.emit('turn/start',{turn:99});assert.equal(t.journal.status().error_code,'HUMAN_TIMELINE_NATIVE_INCARNATION_CHANGED');t.session.header.createdAt=oldHeader;
    assert.equal(t.calls.own,0);assert.equal(t.calls.native,0);
  }finally{t.close();}
});

test('cold history uses metadata only and never publishes old or new assistant bodies',async()=>{
  const t=await setup();try {
    const requestId=randomUUID();await t.journal.recordHumanTurn({requestId,text:'TEST known input'});t.journal.dispose();
    const event=(type,data)=>t.events.push({type,data,seq:t.events.length,time:Date.parse('2026-10-07T04:00:00Z')+t.events.length});
    for(let turn=1;turn<=200;turn++) {
      event('turn/start',{turn});event('user/message',{id:randomUUID(),source:{kind:'schedule',rpcId:requestId}});
      const data={turn};Object.defineProperty(data,'message',{get(){throw Error('TEST private historical output unreadable');}});event('assistant/message',data);event('turn/end',{turn,reason:{kind:'completed'}});
    }
    event('turn/start',{turn:201});event('user/message',{id:randomUUID(),source:{kind:'user',rpcId:requestId}});
    const data={turn:201};Object.defineProperty(data,'message',{get(){throw Error('TEST native final output unreadable');}});event('assistant/message',data);event('turn/end',{turn:201,reason:{kind:'completed'}});
    await t.remount();await t.journal.drain();assert.deepEqual(Object.keys(t.snapshot().turns),['201']);assert.equal(t.snapshot().turns['201'].suppression_code,'NATIVE_TEXT_IS_NOT_ROOM_SEND');assert.equal(t.calls.own,0);assert.equal(t.calls.native,0);
    assert.equal(t.rooms.timelineForPrincipal(t.lifeId).messages.length,1);assert.equal(t.rows()[0].status,'pending');
  }finally{t.close();}
});
