import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {root} from './configure.mjs';
const files=[
 'registry.test.mjs','life-services/services.test.mjs','private-services/private-services.test.mjs',
 'platform/normal-interface-ownership.test.mjs','platform/inbox-recovery.test.mjs','platform/social.test.mjs',
 'platform/input-truth.test.mjs','platform/conversation-storage.test.mjs','platform/cache-prefix.test.mjs','platform/execution-status.test.mjs','platform/inbox-performance.test.mjs',
 'recent-events/worker.test.mjs','recent-events/input-completion.test.mjs','recent-events/store.test.mjs','recent-events/world.test.mjs',
 'supervisor/world.test.mjs','supervisor/resources.test.mjs'
];
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/API.?KEY|SECRET|TOKEN|PASSWORD|AUTH|COOKIE/i.test(k)));
env.DSH_TELEMETRY_DISABLED='1';env.PYTHONUTF8='1';
for(const file of files){
 const r=spawnSync(process.execPath,['--test',resolve(root,'runtime/native_dsh/multi-life',file)],{cwd:root,env,stdio:'inherit',windowsHide:true,timeout:90000});
 if(r.status!==0)throw Error('Multi-life check failed: '+file);
}
for(const file of ['runtime/native_dsh/subagent-router/router.test.mjs','runtime/native_dsh/subagent-router/slots.test.mjs','runtime/desktop_persona/reference-service/global-start.test.mjs','runtime/deepseek_billing/service/cache.test.mjs','runtime/deepseek_billing/service/snapshots.test.mjs','runtime/deepseek_billing/service/recovery.test.mjs','runtime/workspace_foundation/file-operation-locks.test.mjs']){
 const r=spawnSync(process.execPath,['--test',resolve(root,file)],{cwd:root,env,stdio:'inherit',windowsHide:true,timeout:90000});if(r.status!==0)throw Error('Check failed: '+file);
}
console.log('Multi-life source fixtures passed; no live provider or installed desktop acceptance implied.');
