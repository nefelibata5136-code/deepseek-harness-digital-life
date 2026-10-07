// Recheck actual existing outputs; no model replay for an assertion-name mismatch.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const report=resolve(import.meta.dirname,'../../../reports/luna-full-access-20261007');
const evidence=JSON.parse(await readFile(resolve(report,'official-full-access.json'),'utf8'));
const files=[];
for(const row of evidence.results){
 assert.equal(row.status,'completed');assert.equal(row.actual_model,'gpt-5.6-luna');assert.equal(row.sandbox_policy,'dangerFullAccess');assert.equal(row.approval_policy,'never');assert(row.command_count>0);assert(row.command_exit_codes.every(code=>code===0));
 const metadata=JSON.parse(row.output.at(-1).text),input=JSON.parse(await readFile(resolve(metadata.workDirectory,'full-access-input.json'),'utf8'));
 const actual=JSON.parse((await readFile(resolve(metadata.workDirectory,'full-access-output.json'),'utf8')).replace(/^\uFEFF/,''));
 assert.equal(actual.nonce,input.nonce);assert.equal(actual.sum,input.a+input.b);assert.equal(actual.life_id??actual['Host父life_id'],row.parent_life);assert.equal(resolve(actual.cwd),resolve(metadata.workDirectory));files.push({parent_life:row.parent_life,input,actual});
}
const result={ok:true,checked_at:new Date().toISOString(),model_replays:0,files,note:'Original fixture prompt requested Host父life_id; both workers used that exact JSON key. The initial harness assertion expected life_id. Actual files were correct and are retained.'};
await writeFile(resolve(report,'saved-files-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
