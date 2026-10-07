import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {mountLegacyHumanTimeline} from './legacy-human-timeline.mjs';

async function fixture() {
  const root=await mkdtemp(resolve(tmpdir(),'TEST-ONLY-human-source-time-'));
  const lifeId='life-'+randomUUID(),authoritySessionId=randomUUID(),calls=[];
  const options={root,lifeId,authoritySessionId,roomId:'TEST-ONLY-human-private-room',
    ctx:{agents:{get:()=>undefined},on:()=>()=>{}},
    bridge:{async postHuman(input){calls.push(input);return {message_id:input.args.message_id,sender_id:'human:maintainer'};},postOwn:async()=>{throw new Error('TEST ONLY unexpected reply');}}};
  const t={journal:await mountLegacyHumanTimeline(options),root,calls,
    async reload(){t.journal.dispose();t.journal=await mountLegacyHumanTimeline(options);},
    async cleanup(){t.journal.dispose();await rm(root,{recursive:true,force:true});}};
  return t;
}

test('first authenticated frontend receipt survives delayed protected admission, replay and journal reload',async()=>{
  const t=await fixture();
  try {
    const requestId=randomUUID(),text='TEST ONLY frontend human text',occurredAt='2026-10-06T17:00:00.123Z';
    const first=await t.journal.recordHumanTurn({requestId,text,occurredAt});
    assert.equal(first.occurred_at,occurredAt);
    assert.equal(t.calls[0].occurredAt,occurredAt);
    const replay=await t.journal.recordHumanTurn({requestId,text,occurredAt:'2026-10-06T18:00:00.000Z'});
    assert.equal(replay.occurred_at,occurredAt);
    assert.equal(t.calls.length,1,'duplicate input retains the original central record');
    const saved=JSON.parse(await readFile(resolve(t.root,'human-timeline.json'),'utf8'));
    assert.equal(saved.requests[requestId].occurred_at,occurredAt);
    await t.reload();
    assert.equal((await t.journal.recordHumanTurn({requestId,text})).occurred_at,occurredAt);
    assert.equal(t.calls.length,1,'cold recovery does not change or republish saved receipt');
    await assert.rejects(t.journal.recordHumanTurn({requestId,text:'TEST ONLY different content',occurredAt}),/HUMAN_REQUEST_ID_CONFLICT/);
    assert.equal(t.calls.length,1);
  }finally{await t.cleanup();}
});

test('malformed or ambiguous supplied occurrence time cannot create a human event',async()=>{
  const t=await fixture();
  try {
    for(const occurredAt of [null,1,'','unknown','2026-10-07 01:00','2026-10-07T01:00:00+08:00'])
      await assert.rejects(t.journal.recordHumanTurn({requestId:randomUUID(),text:'TEST ONLY human text',occurredAt}),/HUMAN_TIMELINE_EVENT_TIME_REQUIRED/);
    assert.equal(t.calls.length,0);
    assert.equal(t.journal.status().human_receipts,0);
    const before=Date.now(),received=await t.journal.recordHumanTurn({requestId:randomUUID(),text:'TEST ONLY other authenticated channel'});
    assert(Date.parse(received.occurred_at)>=before);
    assert(Date.parse(received.occurred_at)<=Date.now());
  }finally{await t.cleanup();}
});
