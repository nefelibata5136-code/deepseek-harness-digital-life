import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const run=promisify(execFile),root=fileURLToPath(new URL('.',import.meta.url)),results=[],logs=[];
const files=['registry.test.mjs','life-services/services.test.mjs','private-services/private-services.test.mjs','budget/budget.test.mjs',
  'platform/platform.test.mjs','platform/browser.test.mjs','platform/capabilities.test.mjs','platform/http.test.mjs','platform/official-provider.test.mjs','platform/legacy-host.test.mjs',
  'platform/communication.test.mjs','platform/tasks.test.mjs','platform/fair-admission.test.mjs','platform/worker-gateway.test.mjs','platform/legacy-worker.test.mjs',
  'platform/public-activity.test.mjs','platform/direct-chat.test.mjs','platform/legacy-human-timeline.test.mjs','platform/legacy-room-inbox.test.mjs','platform/host-notice.test.mjs'];
const startedAt=new Date().toISOString();let passed=true;
for(const file of [...files,'verify-phase1.mjs','verify-integration.mjs']) {
  const started=Date.now();console.log(JSON.stringify({status:'running',file}));
  const args=file.endsWith('.test.mjs')?['--test','--test-reporter=tap',resolve(root,file)]:[resolve(root,file)];
  try {
    const {stdout,stderr}=await run(process.execPath,args,{windowsHide:true,timeout:180000,maxBuffer:2000000});
    logs.push('FILE '+file+'\n'+stdout+stderr);
    const testCount=Number(stdout.match(/^# tests (\d+)$/m)?.[1]??0),passCount=Number(stdout.match(/^# pass (\d+)$/m)?.[1]??0);
    if(file.endsWith('.test.mjs')&&(testCount<1||testCount!==passCount))throw Error('TEST_COUNTS_NOT_COMPLETE');
    const row={file,passed:true,testCount,passCount,elapsedMs:Date.now()-started};results.push(row);console.log(JSON.stringify(row));
  }catch(error){passed=false;logs.push('FILE '+file+'\n'+(error.stdout??'')+(error.stderr??''));const row={file,passed:false,exitCode:error.code,elapsedMs:Date.now()-started};results.push(row);console.log(JSON.stringify(row));break;}
}
const report={passed,startedAt,completedAt:new Date().toISOString(),testCount:results.reduce((sum,row)=>sum+row.testCount||sum,0),
  results,paidModelCalls:0,formalLifeRegistrations:0,productionActivated:false,evidenceKind:'isolated-local-fixtures-and-native-official-code'};
const reportRoot=resolve(root,'../../../reports/multi-life-communication-20261006');await mkdir(reportRoot,{recursive:true});
await writeFile(resolve(reportRoot,'final-validation.log'),logs.join('\n\n'));
await writeFile(resolve(reportRoot,'final-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));if(!passed)process.exitCode=1;
