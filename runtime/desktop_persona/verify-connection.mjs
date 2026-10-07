import assert from 'node:assert/strict';
import { connectionStatus, apply, requestLocalHost } from './usage-adapter.mjs';
import {createServer} from 'node:http';
let supervisorCalls = 0;
const healthy = { ready: true, sessionId: 'existing-seat', busy: false };
assert.deepEqual(await connectionStatus({ request: async () => ({ status: 200, value: healthy }),
  supervisor: async () => { supervisorCalls++; throw new Error('Not needed'); } }), healthy);
assert.equal(supervisorCalls, 0);
for (const [diagnostic, expected] of [[{ state: 'starting' }, 'starting'], [{ state: 'stopped' }, 'stopped'],
  [{ state: 'stopped', reason: 'conflict' }, 'conflict'], [{ state: 'stopped', disabled: true }, 'disabled']]) {
  let requested = 0;
  const result = await connectionStatus({ request: async (method, route, value, signal) => {
    requested++; assert.equal(method, 'GET'); assert.equal(route, '/status'); assert.equal(value, undefined);
    assert(signal instanceof AbortSignal); throw new Error('fetch failed');
  }, supervisor: async () => diagnostic });
  assert.equal(result.ready, false); assert.equal(result.connection.state, expected);
  assert(result.connection.message.length > 0); assert.equal(requested, 1, 'No retry or model invocation');
}
assert.equal((await connectionStatus({ request: async () => ({ status: 403 }),
  supervisor: async () => ({ state: 'running' }) })).connection.state, 'running');
const routes = new Map();
function mount() {
  const disposers = [];
  apply({ effect: effect => disposers.push(effect()), connection: { fetch: { register: route => {
    assert(!routes.has(route.path), 'Hot replacement must withdraw old routes');
    routes.set(route.path, route); return async () => routes.delete(route.path);
  } } } });
  return async () => { for (const dispose of disposers.reverse()) await dispose(); };
}
for (let replacement = 0; replacement < 3; replacement++) {
  const dispose = mount(); assert(routes.has('/api/persona.status')); assert(routes.size > 0); await dispose(); assert.equal(routes.size, 0);
}
let posts=0;
const server=createServer((req,res)=>{
  if(req.method==='POST')posts++;
  if(req.url==='/image'){res.writeHead(200,{'content-type':'image/png'});return res.end(Buffer.from([1,2,3]));}
  setTimeout(()=>{if(!res.destroyed){res.writeHead(200,{'content-type':'application/json'});res.end('{"completed":true}');}},150);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const port=server.address().port;
try{
  await assert.rejects(requestLocalHost({method:'GET',route:'/slow',port,token:'fixture',signal:AbortSignal.timeout(30)}));
  const response=await requestLocalHost({method:'POST',route:'/slow',port,token:'fixture',body:'{}'});
  assert(response.value.completed);assert.equal(posts,1,'One admitted POST, no replay');
  const media=await requestLocalHost({method:'GET',route:'/image',port,token:'fixture'});
  assert.deepEqual([...media.value],[1,2,3]);assert.equal(media.mediaType,'image/png');
}finally{await new Promise(done=>server.close(done));}
console.log(JSON.stringify({ passed: true, modelCalls: 0, checks: ['live identity preserved', 'hot replacement withdraws all owned routes', 'read deadline, unbounded admitted POST, no replay, binary media preserved',
  'starting/stopped/conflict/disabled/auth failure have explicit diagnostics', 'bounded read-only status request; no restart or retry'] }));
