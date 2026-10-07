// Immutable, explicit source export; no Session/memory/credentials/transport state.
import {readdir,readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {worldSnapshot} from '../native_dsh/multi-life/supervisor/deployment.mjs';
const m=Object.values(worldSnapshot().lives).find(x=>x.kind==='legacy');
const files=['README.md','bindings.mjs','ledger.test.mjs','approvals.test.mjs',...(await readdir(join(import.meta.dirname,'bundle'))).filter(n=>/\.(mjs|json|yml)$/.test(n)).map(n=>'bundle/'+n)];
const rows=await Promise.all(files.sort().map(async path=>{const bytes=await readFile(join(import.meta.dirname,path));return {path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes};}));
const hash=createHash('sha256').update(JSON.stringify(rows.map(({path,sha256})=>({path,sha256})))).digest('hex');
const root=join(m.deployment.workspace,'development/moltbook-source'),generation=join(root,hash),target=join(generation,'runtime/moltbook');
await mkdir(target,{recursive:true});
for(const r of rows){const p=join(target,r.path);await mkdir(resolve(p,'..'),{recursive:true});try{await writeFile(p,r.bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||createHash('sha256').update(await readFile(p)).digest('hex')!==r.sha256)throw Error('IMMUTABLE_SOURCE_GENERATION_CHANGED');}}
const value={schema_version:1,life_id:m.lifeId,generation:hash,formal_root:import.meta.dirname,source_root:target,files:rows.map(({path,sha256})=>({path,sha256})),contains_private_records:false};
await writeFile(join(root,'CURRENT.json'),JSON.stringify(value,null,2)+'\n');
console.log(JSON.stringify({life_id:m.lifeId,generation:hash,source_root:target,files:rows.length}));
