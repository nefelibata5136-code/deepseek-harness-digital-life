import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { root } from './configure.mjs';
const node=process.execPath,python=process.env.DL_PYTHON||'python';
const checks=[
 [node,['--test','runtime/native_dsh/digital-life/store.test.mjs','runtime/native_dsh/digital-life/resident.test.mjs','runtime/native_dsh/digital-life/state-board-model.test.mjs','runtime/native_dsh/digital-life/deployment-admission.test.mjs','runtime/native_dsh/digital-life/codex-advisor.test.mjs','runtime/native_dsh/capabilities/read-policy.test.mjs','runtime/bluesky/bundle/extended.test.mjs','runtime/dots_bridge/bundle/bridge.test.mjs'],root],
 [python,['-m','unittest','test_memory','test_qwen'],resolve(root,'runtime/long_term_memory')],
 [python,['-m','unittest','test_authority'],resolve(root,'runtime/budget_guard')],
 [python,['-m','unittest','runtime.budget_guard.test_usage_report'],root],
 [node,['--test','runtime/budget_guard/test_provider_gate.mjs'],root],
 [node,['runtime/self_maintenance/verify-change.mjs'],root],
 [node,['tools/web-search/verify.mjs'],root],
 [node,['runtime/key_output_guard/verify.mjs'],root],
 [node,['runtime/native_dsh/verify-self-compaction.mjs'],root],
 [node,['runtime/native_dsh/digital-life/verify-resident.mjs'],root],
 [node,['runtime/native_dsh/private-vault/verify.mjs'],root],
];
for(const [cmd,args,cwd] of checks){
 const result=spawnSync(cmd,args,{cwd,stdio:'inherit',windowsHide:true,timeout:180000,
  env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
 if(result.error||result.status!==0)throw new Error('Check failed: '+args.join(' '));
}
console.log('Public core tests passed. No live external-service or desktop acceptance is implied.');
