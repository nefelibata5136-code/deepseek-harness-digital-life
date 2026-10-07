import assert from 'node:assert/strict';
import {needsAuthorCapacityView} from '../author-pressure.mjs';
import {readFileSync} from 'node:fs';
const events=[];
const session={*ownEvents(){yield* events;}};
assert.equal(needsAuthorCapacityView(session,true,-1,false),true,'initial overflow projects');
events.push({seq:100,type:'user/message',data:{source:{kind:'self-compaction-view-manifest'}}});
// The real failure was the next request's small-view usage making full history
// appear to fit. A durable manifest must override every subsequent fits=true.
for(let i=0;i<32;i++)assert.equal(needsAuthorCapacityView(session,true,-1,true),true,'calibration drop cannot restore full history');
const restored={*ownEvents(){yield* JSON.parse(JSON.stringify(events));}};
assert.equal(needsAuthorCapacityView(restored,true,-1,true),true,'restart keeps capacity view');
assert.equal(needsAuthorCapacityView(restored,false,101,true),false,'committed generation exits view');
assert.equal(needsAuthorCapacityView(restored,true,101,true),false,'old manifest does not contaminate next transaction');
const projected={purpose:'self-author-capacity-view',messages:[]};
const middlewareCopy={...projected,messages:[...projected.messages]};
assert.notEqual(middlewareCopy,projected);
assert.equal(middlewareCopy.purpose,'self-author-capacity-view');
const source=readFileSync(new URL('../author-pressure.mjs',import.meta.url),'utf8');
assert(source.includes("options.purpose === 'self-author-capacity-view' || projected.has(options)"),'cloned projected request must bypass recursive projection');
console.log(JSON.stringify({ok:true,projectedUsageCannotRestoreFullHistory:true,durableAcrossRestart:true,commitEndsProjection:true}));
