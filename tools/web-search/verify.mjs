import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
for(const args of [[],['--describe'],['test query','--json']]){
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./search.mjs',import.meta.url)),...args],{encoding:'utf8',windowsHide:true});
 assert.equal(r.status,1);assert.match(r.stderr,/LOCAL_SEARCH_RETIRED/);assert.equal(r.stdout,'');
}
console.log(JSON.stringify({passed:true,retiredLocalSearch:true,externalRequests:0}));
