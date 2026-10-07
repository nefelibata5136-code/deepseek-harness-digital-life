import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {recordIncident,incidents,recentFailures} from './diagnostics.mjs';
const root=await mkdtemp(resolve(tmpdir(),'persona-diagnostics-'));
try {
  const sessionId='80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b';
  await mkdir(resolve(root,'incidents'));
  const damaged='bf72d6f7-d5a5-5888-b5ad-4f5960f39252.json';
  await writeFile(resolve(root,'incidents',damaged),'');
  await writeFile(resolve(root,'incidents','42f75f13-4b16-56fb-bfb2-3342699890ec.json'),'{');
  await writeFile(resolve(root,'incidents','f9c47da5-6c52-5192-87ec-7e774b58107d.json'),'null');
  await writeFile(resolve(root,'incidents','partial.json.tmp'),'{');
  const good=await recordIncident({sessionId,stage:'host-command',causes:[]},root);
  const rows=await incidents({sessionId,root});
  assert.equal(rows.length,4);
  assert.equal(rows.filter(r=>r.errorCode==='CORRUPT_INCIDENT_RECORD').length,3);
  assert.equal(rows.at(-1).id,good.id);
  assert.equal(await readFile(resolve(root,'incidents',damaged),'utf8'),'');
  assert.equal((await recentFailures(root)).length,4);
  const files=await readdir(resolve(root,'incidents'));
  assert.equal(files.filter(f=>f.endsWith('.tmp')).length,1);
  assert.equal(JSON.parse(await readFile(resolve(root,'incidents',good.id+'.json'),'utf8')).id,good.id);
  console.log(JSON.stringify({passed:true,emptyTruncatedAndInvalidShapeReported:true,originalPreserved:true,atomicPublication:true}));
} finally {await rm(root,{recursive:true,force:true});}
