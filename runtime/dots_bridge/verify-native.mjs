/** Actual official Plugin Manager -> isolated worker -> schema/call verification. No model or network. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createBus } from '../native_dsh/capabilities/bus.mjs';
import { registerProfile, approveProfile, withManager } from '../native_dsh/capabilities/profiles.mjs';
const source = '.local/workspace/development/plugins/persona-dots';
const root=resolve(import.meta.dirname,'../../reports/dots_bridge/native-'+randomUUID());
await mkdir(root,{recursive:true});
const profiles=resolve(root,'profiles');
const python=(process.env.DL_PYTHON || 'python');
const bus=createBus({root:profiles,python,toolTimeoutMs:30000});
const checks=[];
try {
  await registerProfile(profiles,{id:'dots',kind:'plugin',description:'isolated Dots native fixture',credentialRefs:['DL_DOTS_SLACK_TOKEN']});
  await withManager(profiles,'dots',async manager=>{
    const installed=await manager.installBundle(source,{enabled:false});
    assert.notEqual(installed.application,'failed');
    await manager.setBundleEnabled('persona-dots',true);
  });
  await writeFile(resolve(profiles,'dots/cordis.patch.yml'),`- id: persona-dots\n  config:\n    root: '${resolve(root,'data').replaceAll('\\','/')}'\n`);
  await approveProfile(profiles,'dots');
  await bus.manage({capability:'dots',action:'enable'});
  const live=await bus.list();assert.equal(live.entries[0].state,'ready');assert.equal(live.entries[0].toolCount,8);
  checks.push('official bundle installs and worker exposes eight tools');
  const discovery=await bus.search({capability:'dots'});assert.equal(discovery.tools.length,8);
  checks.push('native tool schemas discovered');
  const status=await bus.call('dots','dots_status',{},'fixture-status');
  assert.equal(status.value.ready,false);assert.equal(status.value.code,'SLACK_CONNECTION_NOT_CONFIGURED');
  checks.push('unconfigured external channel fails explicitly while local worker stays ready');
  const result=await bus.call('dots','delegate_to_dots',{idempotency_key:'native-fixture',goal:'Public paper research',reason:'Isolated interface test',output:'Primary source URLs',public_context:true},'fixture-delegate');
  assert.equal(result.value.status,'failed');
  const history=await bus.call('dots','dots_task_history',{task_id:result.value.task_id},'fixture-history');
  assert(history.value.events.some(e=>e.value.caller?.native_call_id==='fixture-delegate'));
  checks.push('delegate and history preserve native call attribution and failure state');
  await assert.rejects(bus.call('dots','delegate_to_dots',{},'invalid'),/ARGUMENTS_INVALID/);
  checks.push('native schema rejects missing fields');
  await bus.manage({capability:'dots',action:'disable'});
  assert.equal((await bus.search({capability:'dots'})).total,0);
  checks.push('disable withdraws this capability without touching the main Host');
  const report={passed:true,root,checks,real_dot_called:false,real_model_called:false,production_store_written:false};
  await writeFile(resolve(root,'validation.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await bus.dispose(); }
