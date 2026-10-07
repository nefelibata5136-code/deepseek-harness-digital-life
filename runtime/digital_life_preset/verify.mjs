/** Keyless checks of resident routing, replay identities, and client navigation. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createEntrance, forwardingId} from './entrance.mjs';

const primary = 'c3d2dc83-6630-5fc3-b66e-617e53c9f797';
const request = '7fff9a96-165f-5b1a-ac0a-145cbd426b27';
const user = {id:'durable-user-1',role:'user',source:{kind:'user',rpcId:request},content:[{type:'text',text:'看看你之前挂着的事。'}]};
let forwarded=[];
let delegated=0;
let status=200;
const entrance=createEntrance({identity:async()=>primary,hostRequest:async(...args)=>{forwarded.push(args);return {status};}});
const next=async()=>{delegated++;return {kind:'enter',messages:[user,{role:'user',source:{kind:'context'},content:[{type:'text',text:'SYSTEM CONTEXT'}]}]};};
assert.deepEqual(await entrance({agent:{id:'desktop-seat'},messages:[user]},next),{kind:'reject'});
assert.equal(delegated,1);
assert.deepEqual(forwarded[0],['POST','/prompt',{sessionId:primary,mode:'queue',text:user.content[0].text,requestId:request}]);
status=409;
assert.deepEqual(await entrance({agent:{id:'desktop-seat'},messages:[user]},next),{kind:'reject'});
assert.equal(forwarded[1][2].requestId,forwarded[0][2].requestId);
status=423;
await assert.rejects(entrance({agent:{id:'desktop-seat'},messages:[user]},next),/refused input/);
assert.equal(forwarded.length,3);
await assert.rejects(entrance({agent:{id:'desktop-seat'},messages:[{...user,content:[{type:'image'}]}]},next),/no content was forwarded/);
assert.equal(forwarded.length,3);
assert.deepEqual(await entrance({agent:{id:'desktop-seat'},messages:[{...user,source:{kind:'schedule'}}]},next),{kind:'reject'});
assert.equal(forwarded.length,3);
assert.deepEqual(await entrance({agent:{id:'desktop-seat'},messages:[user]},async()=>({kind:'reject'})),{kind:'reject'});
assert.equal(forwarded.length,3);
const bare={...user,source:{kind:'user'}};
assert.equal(forwardingId({id:'desktop-seat'},[bare]),forwardingId({id:'desktop-seat'},[structuredClone(bare)]));
assert.notEqual(forwardingId({id:'desktop-seat'},[bare]),forwardingId({id:'desktop-seat'},[{...bare,id:'durable-user-2'}]));
assert.match(forwardingId({id:'desktop-seat'},[bare]),/^[a-f0-9-]{36}$/);

// Only exact authenticated frontend receipts can add human routing metadata.
const occurredAt='2026-10-06T17:50:00.123Z';
const routed=[];
const humanEntrance=createEntrance({identity:async()=>primary,
  receiptFor:(_agent,message)=>message.id===user.id?{humanPrincipalId:'human:maintainer',occurredAt}:null,
  hostRequest:async(...args)=>{routed.push(args);return {status:200};}});
await humanEntrance({agent:{id:'desktop-seat'},messages:[user]},next);
assert.deepEqual(routed[0][2],{sessionId:primary,mode:'queue',text:user.content[0].text,requestId:request,humanPrincipalId:'human:maintainer',humanOccurredAt:occurredAt});
const unproven={...user,id:'unknown-native-message',source:{kind:'user',rpcId:'1e1fb0bc-6ae9-51af-818b-633687a4af42'},content:[{type:'text',text:'TEST ONLY UNKNOWN INPUT'}]};
await humanEntrance({agent:{id:'desktop-seat'},messages:[user,unproven]},next);
assert.equal(routed.length,3);
assert.equal(routed[1][2].requestId,request);
assert.equal(routed[1][2].humanOccurredAt,occurredAt);
assert.equal(routed[2][2].requestId,unproven.source.rpcId);
assert.equal(Object.hasOwn(routed[2][2],'humanPrincipalId'),false);
assert.equal(Object.hasOwn(routed[2][2],'humanOccurredAt'),false);
const secondTime='2026-10-06T17:50:01.123Z';
const second={...unproven,id:'trusted-second-message'};
const multiple=[];
await createEntrance({identity:async()=>primary,
  receiptFor:(_agent,message)=>({humanPrincipalId:'human:maintainer',occurredAt:message.id===user.id?occurredAt:secondTime}),
  hostRequest:async(...args)=>{multiple.push(args);return {status:200};}})({agent:{id:'desktop-seat'},messages:[user,second]},next);
assert.equal(multiple.length,2,'each human event keeps its own native identity');
assert.equal(multiple[0][2].requestId,request);
assert.equal(multiple[1][2].requestId,second.source.rpcId);
assert.equal(multiple[0][2].humanOccurredAt,occurredAt);
assert.equal(multiple[1][2].humanOccurredAt,secondTime);

const client=await readFile(new URL('./client.js',import.meta.url),'utf8');
let plugin;
runInNewContext(client,{window:{__ModuleLoader__:{load:value=>{plugin=value.factory();}}},Promise,Error});
let state={byId:{}};
let roster={ok:true,value:{presets:[{id:'standard',isDefault:true},{id:'persona',isDefault:false}]}};
const listeners={};
const effects=[];
const panels=[];
let disposed=0;
const subscribe=(name,callback)=>{listeners[name]=callback;return()=>{disposed++;delete listeners[name];};};
plugin.apply({
  effect:callback=>effects.push(callback()),
  slots:{entries:()=>[{options:{key:'persona'}}]},
  layout:{selectPanel:id=>panels.push(id),panelInfo:{getSnapshot:()=>({activePanelId:null}),subscribe:callback=>subscribe('navigation',callback)}},
  sessions:{list:{getSnapshot:()=>state,subscribe:callback=>subscribe('sessions',callback)}},
  remote:{agentPresets:{list:async()=>roster},$on:(name,callback)=>subscribe(name,callback)},
  on:(name,callback)=>subscribe(name,callback),
});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
await flush();
assert.equal(panels.length,0);
roster={ok:true,value:{presets:[{id:'standard',isDefault:false},{id:'persona',isDefault:true}]}};
listeners['settings/document-updated']('agent-preset-registry');
await flush();
assert.deepEqual(panels,['persona']);
listeners['settings/document-updated']('agent-preset-registry');
await flush();
assert.equal(panels.length,1);
state={byId:{blank:{id:'blank',blank:true,retainedBy:{mainView:1},projectionValues:{agentPreset:'persona'}}}};
listeners.sessions();
assert.equal(panels.length,2);
listeners.sessions();
assert.equal(panels.length,2);
state={byId:{}};
listeners.navigation();
await flush();
assert.equal(panels.length,3, 'A new unbound blank conversation enters the chosen default');
state={byId:{existing:{id:'existing',blank:false,retainedBy:{mainView:1},projectionValues:{agentPreset:'standard'}}}};
listeners.navigation();
await flush();
assert.equal(panels.length,3, 'Opening an existing Standard conversation preserves its navigation');
effects.forEach(dispose=>dispose());
assert.equal(disposed,4);
assert.equal(Object.keys(listeners).length,0);
console.log(JSON.stringify({passed:true,paidModelCalls:0,protectedHostCalls:0,checks:[
  'native user input forwarded only to existing primary identity',
  'local model step always rejected',
  'persisted request identity reused for Host deduplication',
  'downstream system context never forwarded as user speech',
  'unsupported attachments fail before forwarding',
  'non-user input cannot become a second Persona turn',
  'authenticated frontend receipt retains human routing and first occurrence time',
  'mixed native claims do not promote unknown sources to human',
  'default and session selections enter resident workspace',
  'unrelated refresh does not repeatedly steal navigation',
  'client subscriptions dispose',
]}));
