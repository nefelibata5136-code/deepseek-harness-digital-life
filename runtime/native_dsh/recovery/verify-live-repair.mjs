// Real DeepSeek recovery Agent repairs a deliberately broken isolated source.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runRecovery} from './kernel.mjs';
import {sha} from './diagnostics.mjs';
const root=resolve(import.meta.dirname,'../../../reports/self-recovery/live-repair-'+randomUUID());
const source=resolve(root,'candidate');await mkdir(source,{recursive:true});
const target=resolve(source,'health.mjs'),before="export function health() { return 'healthy';\n";
await writeFile(target,before);
let initialSyntaxFailed=false;try{await promisify(execFile)(process.execPath,['--check',target],{windowsHide:true});}catch{initialSyntaxFailed=true;}
if(!initialSyntaxFailed)throw Error('Acceptance candidate must start broken');
const result=await runRecovery({root,candidateRoot:source,episode:{kind:'isolated-source-repair-acceptance',
  task:'这是独立恢复功能验收。候选根目录里的 health.mjs 有真实语法错误（缺少函数闭合括号），不属于人格生活内容。请repair_read_source读取，再用真实repair_patch_source及expected_hash做最小修复，然后repair_probe验证。不要读记忆、改正式Host或重启。',candidateFile:'health.mjs'},
  toolOverrides:{repair_probe:async()=>{
    await promisify(execFile)(process.execPath,['--check',target],{windowsHide:true});
    const module=await import(new URL('file:///'+target.replaceAll('\\','/')));if(module.health()!=='healthy')throw Error('Repaired candidate behavior failed');
    return {state:'completed',candidateHealth:module.health(),formalHostUnchanged:true};
  }}});
const after=await readFile(target,'utf8');
const verified=result.state==='completed'&&after!==before&&result.receipts.some(r=>r.verified)&&result.checks.some(c=>c.tool==='repair_probe');
const report={passed:verified,observedAt:new Date().toISOString(),initialSyntaxFailed,sessionId:result.sessionId,
  actualNativeAgent:true,actualDeepSeek:true,actualPatchTool:true,candidateRoot:source,beforeHash:sha(before),afterHash:sha(after),
  checkpoints:result.receipts,steps:result.steps,longTermMemoryLoaded:result.longTermMemoryLoaded,formalHostChanged:false,text:result.text};
await writeFile(resolve(import.meta.dirname,'../../../reports/self-recovery/live-repair-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));if(!verified)process.exitCode=1;
