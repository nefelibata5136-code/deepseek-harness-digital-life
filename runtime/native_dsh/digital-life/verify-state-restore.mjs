// Separate process: genuine JSONL load and Agent recreation, no model call.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { pathToFileURL } from 'node:url';
import { bootNative, here } from '../boot-native.mjs';
import { stateChanges } from './state-board.mjs';
const base = resolve(here, '../..'), proof = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert(proof.passed); const root = proof.root, workspace = proof.workspace ?? resolve(root,'workspace');
assert(root.startsWith(resolve(base, 'reports/state-board')));
process.env.DEEPSEEK_API_KEY='offline-placeholder';
globalThis.fetch=()=>{throw new Error('Restore acceptance must not invoke a model');};
const rows=parse(await readFile(resolve(here,'home/profiles/persona/cordis.patch.yml'),'utf8')).flatMap(r=>r.insert??[]);
const entry={id:'persona-resident-v1',name:pathToFileURL(resolve(here,'digital-life/resident.mjs')).href,config:{workspace}};
const ctx=await bootNative({sessionId:proof.sessionId,testRoot:root,overlays:[{id:'persona-preset-declaration',config:{...rows.find(r=>r.id==='persona-preset-declaration').config,plugins:[entry]}},
  ...['workspace-foundation','persona-bridge','persona-tasks','persona-digital-life'].map(id=>({id,config:{...rows.find(r=>r.id===id).config,workspace,
    ...(id==='workspace-foundation'?{store:resolve(root,'versions'),readRoots:[root,workspace]}:{}),
    ...(id==='persona-bridge'?{core:resolve(workspace,'persona-core.md')}:{}),...(id==='persona-digital-life'?{root:resolve(root,'digital-life')}:{})}}))]});
try {
 const resolved=await ctx.sessionController.resolveAgent(proof.sessionId); assert(!('error' in resolved), String(resolved.error?.stack ?? resolved.error)); const {agent}=resolved; assert(agent);
 const events=[...agent.session.ownEvents()], latest=stateChanges(events).at(-1); assert(latest);
 assert.deepEqual(ctx.personaLife.stateBoard.get(agent),latest.state);
 const queried=await ctx.sessionQuery.readSession(proof.sessionId); assert(queried.events.some(e=>e.type==='system/message'&&e.data.message.source.producer==='digital-life-state-board'));
 const report={passed:true,observedAt:new Date().toISOString(),sessionId:proof.sessionId,root,stateSurvivesRealRestart:true,
  nativeJsonlDecoded:true,self:latest.state,modelCalls:0};
 await writeFile(resolve(base,'reports/state-board/'+(proof.baseline===false?'live-restore-validation':'restore-validation')+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {await ctx.fiber.dispose();}
